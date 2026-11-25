#!/usr/bin/env bash
# The core idea: run the SAME query twice per optimization — OFF then ON — and
# report the difference. Each optimization is an isolated A/B, nothing cumulative.
# Toggles are scripted (plugin enable/disable, proxy env, config files, MCP add/remove).
#
#   ./eval/run-all.sh            # all tasks
#   ./eval/run-all.sh --task 1   # one task across every A/B (cheap)
#   ./eval/run-all.sh --only caveman --task 1   # a single A/B
#   ./eval/run-all.sh --only caveman --rows caveman_chain   # one scoreboard row
#   ./eval/run-all.sh --long     # also the long-answer + long-chat rows (~$30 total)
#
# Records results/<opt>__off.json and results/<opt>__on.json, then prints the
# scoreboard. Refuses to run (rather than record zeros) if claude isn't logged in.
set -uo pipefail
cd "$(dirname "$0")/.."

TASK_ARG=""
REPS_ARG=""
ONLY=""
ROWS=""
LONG_ROWS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --long) LONG_ROWS=1; shift ;;   # also run the *_long (task 6) and *_chain (task 7) rows
    --task) TASK_ARG="--task $2"; shift 2 ;;
    --reps) REPS_ARG="--reps $2"; shift 2 ;;
    --only) ONLY="$2"; shift 2 ;;   # headroom | caveman | config | cli
    --rows) ROWS=",$2,"; shift 2 ;; # e.g. headroom_long,caveman_chain — skip other rows
    *) shift ;;
  esac
done

# Default: plain `claude` on PATH. Override only if your setup wraps it, e.g.
#   CLAUDE_BIN=~/.axcli/bin/claude npm run eval:all -- --task 1
export CLAUDE_BIN="${CLAUDE_BIN:-claude}"

# Homebrew's libpq is keg-only (psql not on PATH by default). Put it on PATH so
# both this script and the agent it drives can run psql.
if command -v brew >/dev/null 2>&1; then
  LIBPQ_BIN="$(brew --prefix libpq 2>/dev/null)/bin"
  [ -x "$LIBPQ_BIN/psql" ] && export PATH="$LIBPQ_BIN:$PATH"
fi

say()  { printf "\n\033[1;35m▶ %s\033[0m\n" "$1"; }
sub()  { printf "\033[36m   %s\033[0m\n" "$1"; }
skip() { printf "\033[33m⤼ SKIP %s A/B — %s\033[0m\n" "$1" "$2"; }
die()  { printf "\033[31m✗ %s\033[0m\n" "$1"; exit 1; }
# Which scoreboard rows run: --rows picks exactly those; otherwise every default
# row, and the expensive *_long / *_chain rows only with --long (~$12 per chat A/B).
row()  {
  local r="${1%__*}"
  if [ -n "$ROWS" ]; then case "$ROWS" in *",$r,"*) return 0 ;; *) return 1 ;; esac; fi
  case "$r" in *_long|*_chain) [ "$LONG_ROWS" = 1 ] ;; *) return 0 ;; esac
}
evt()  { row "$2" || return 0; npm run --silent eval -- --label "$2" --task "$1" $REPS_ARG || die "eval failed for $2"; }   # fixed task
want() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }
ev()   { row "$1" || return 0; npm run --silent eval -- --label "$1" $TASK_ARG $REPS_ARG || die "eval failed for $1"; }

# Long-form rows, run next to each A/B's default row:
#   *_long  = task 6, one long written answer (output-heavy)
#   *_chain = task 7, a six-message conversation in one session (context-heavy)
LONG_TASK="${LONG_TASK:-${CAVEMAN_LONG_TASK:-6}}"
CHAIN_TASK="${CHAIN_TASK:-7}"

say "Preflight"
command -v "$CLAUDE_BIN" >/dev/null || die "claude CLI not found ($CLAUDE_BIN)"
"$CLAUDE_BIN" -p "reply with: ok" --output-format json </dev/null 2>/dev/null | grep -q '"is_error":false' \
  || die "claude is NOT authenticated ($CLAUDE_BIN) — a run now would record zeros. Sign in and retry."
curl -fs http://localhost:3001/api/users >/dev/null 2>&1 || die "app not up — run 'docker compose up -d'"
command -v node >/dev/null || die "node not found"
git status >/dev/null 2>&1 || die "git can't read this repo (needed to reset the app tree between runs)"
printf "   %s authenticated, app up, node + git OK\n" "$CLAUDE_BIN"

# ---------- Headroom A/B ----------
# Two ways to toggle Headroom, picked by HEADROOM_AB (default: axcli when
# CLAUDE_BIN is the axcli wrapper, otherwise proxy):
#
#   proxy  (workshop default) — run our own `headroom proxy` on HEADROOM_AB_PORT
#          and point Claude Code at it via ANTHROPIC_BASE_URL.
#          OFF = proxy with --no-optimize (passthrough), ON = proxy optimizing.
#          Same transport on both sides, so only compression differs. Needs
#          first-party auth: under Bedrock/Vertex ANTHROPIC_BASE_URL is ignored —
#          the request-counter check below catches that and refuses to record.
#
#   axcli  — `axcli config compression off|on`. NOT a valid A/B for this eval:
#          verified 2026-11-25 that headless `claude -p` sessions get no gateway
#          compression even with it ON, so OFF and ON are identical. Only runs
#          when asked for explicitly (HEADROOM_AB=axcli), and labels itself so.
HEADROOM_BIN="${HEADROOM_BIN:-headroom}"
# setup.sh installs Headroom into a venv (Homebrew Python refuses pip --user).
command -v "$HEADROOM_BIN" >/dev/null 2>&1 || { [ -x "$HOME/.venvs/headroom/bin/headroom" ] && HEADROOM_BIN="$HOME/.venvs/headroom/bin/headroom"; }
HR_PORT="${HEADROOM_AB_PORT:-8788}"   # not 8787: axcli's sidecar may hold that
HEADROOM_AB="${HEADROOM_AB:-proxy}"
# Headroom's default --mode is "cache" (freeze prior turns). On the Bedrock
# passthrough that means NO compression at all (handlers/bedrock.py bypasses on
# cache mode) — verified 2026-11-25: 72 requests, 0 input tokens seen. "token"
# runs the pipeline on every request, on both transports.
HR_PROXY_MODE="${HEADROOM_AB_MODE:-token}"
HR_LOG="/tmp/token-lab-headroom-$HR_PORT.log"
# One "[router] route_counts=" line per request the compression pipeline actually ran on.
hr_pipeline_runs() { local n; n=$(grep -c '\[router\] route_counts=' "$HR_LOG" 2>/dev/null); echo "${n:-0}"; }

# Bedrock-mode Claude Code (e.g. the axcli wrapper) ignores ANTHROPIC_BASE_URL and
# posts to ANTHROPIC_BEDROCK_BASE_URL instead. If that points at a local re-signing
# gateway, Headroom sits in between with its Bedrock InvokeModel passthrough
# (--bedrock-api-url), and claude is pointed at the proxy with --settings (the
# settings.json `env` block beats the shell env). Empty = first-party transport.
hr_bedrock_upstream() {
  [ -n "${HEADROOM_BEDROCK_UPSTREAM:-}" ] && { echo "$HEADROOM_BEDROCK_UPSTREAM"; return; }
  node -e '
    const fs = require("fs"), p = require("path"), os = require("os");
    let env = {};
    try { env = JSON.parse(fs.readFileSync(p.join(process.env.CLAUDE_CONFIG_DIR || p.join(os.homedir(), ".claude"), "settings.json"), "utf8")).env || {}; } catch {}
    const get = (k) => env[k] ?? process.env[k] ?? "";
    const on = /^(1|true)$/i.test(get("CLAUDE_CODE_USE_BEDROCK"));
    const url = get("ANTHROPIC_BEDROCK_BASE_URL");
    if (on && /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url)) console.log(url);
  ' 2>/dev/null
}
HR_BEDROCK_UP="$(want headroom && hr_bedrock_upstream)"

hr_metrics()  { curl -s -m 3 "http://127.0.0.1:$HR_PORT/metrics" 2>/dev/null; }
hr_requests() { hr_metrics | awk '/^headroom_requests_total/{print $2}'; }
HR_PID=""
hr_stop() { [ -n "$HR_PID" ] && kill "$HR_PID" 2>/dev/null; wait "$HR_PID" 2>/dev/null; HR_PID=""; }
hr_start() {   # $1 = extra flags ("" or "--no-optimize"); returns 1 if the proxy never came up
  hr_stop
  local up=""; [ -n "$HR_BEDROCK_UP" ] && up="--bedrock-api-url $HR_BEDROCK_UP"
  "$HEADROOM_BIN" proxy --port "$HR_PORT" --no-telemetry --mode "$HR_PROXY_MODE" $up $1 >"$HR_LOG" 2>&1 & HR_PID=$!
  for _ in $(seq 1 60); do
    curl -fs -m 1 "http://127.0.0.1:$HR_PORT/health" >/dev/null 2>&1 && return 0
    kill -0 "$HR_PID" 2>/dev/null || break
    sleep 0.5
  done
  return 1
}
# Run one Headroom row through the proxy. Refuses (deletes) the result if no
# request reached the proxy, and saves the proxy's /metrics before/after next to
# the result as evidence of what it actually did. Returns 1 if not routed.
hr_row() {   # $1 = row, $2 = off|on
  local L="$1" lab="$1__$2" before after p0 p1
  before=$(hr_metrics); p0=$(hr_pipeline_runs)
  case $L in headroom) ev "$lab" ;; headroom_long) evt "$LONG_TASK" "$lab" ;; *) evt "$CHAIN_TASK" "$lab" ;; esac
  row "$L" || return 0
  after=$(hr_metrics); p1=$(hr_pipeline_runs)
  printf '# proxy --mode %s, compression pipeline ran on %s requests\n# /metrics before\n%s\n\n# /metrics after\n%s\n' \
    "$HR_PROXY_MODE" "$((p1 - p0))" "$before" "$after" > "results/$lab.headroom-metrics.txt"
  local b a
  b=$(printf '%s\n' "$before" | awk '/^headroom_requests_total/{print $2}')
  a=$(printf '%s\n' "$after"  | awk '/^headroom_requests_total/{print $2}')
  printf "   headroom proxy requests during %s: %s → %s, pipeline ran on %s   (metrics: results/%s.headroom-metrics.txt)\n" "$lab" "${b:-0}" "${a:-?}" "$((p1 - p0))" "$lab"
  # What the proxy says it saved — OFF (--no-optimize) should show nothing new, ON may.
  printf '%s\n' "$after" | grep -iE '^[a-z_]*(saved|compress)[a-z_]*(\{| )' | grep -v '^#' | head -5 | sed 's/^/     /'
  if [ -z "$a" ] || [ "${a%.*}" -le "${b%.*}" ]; then rm -f "results/$lab.json"; return 1; fi
  # ON must have actually run the pipeline. Requests alone don't prove it: in cache
  # mode the Bedrock route forwards everything untouched.
  if [ "$2" = on ] && [ "$((p1 - p0))" -eq 0 ]; then
    rm -f "results/$lab.json"; HR_WHY="proxy forwarded the requests but never ran its compression pipeline (--mode $HR_PROXY_MODE)"; return 1
  fi
  return 0
}
hr_fail() {  # skip the rest of the Headroom A/B, keep going with the others
  for L in headroom headroom_long headroom_chain; do row "$L" && rm -f "results/${L}__on.json"; done
  unset EVAL_MODE ANTHROPIC_BASE_URL EVAL_CLAUDE_SETTINGS
  hr_stop; trap - EXIT
  skip "Headroom" "$1"
}

if ! want headroom; then
  :
elif [ "$HEADROOM_AB" = proxy ] && command -v "$HEADROOM_BIN" >/dev/null 2>&1; then
  say "Headroom A/B (same query through headroom proxy: passthrough, then optimizing)"
  trap hr_stop EXIT
  HR_OK=1
  sub "OFF — headroom proxy --mode $HR_PROXY_MODE --no-optimize on :$HR_PORT"
  if ! hr_start --no-optimize; then
    HR_OK=0; hr_fail "headroom proxy did not come up on :$HR_PORT (see /tmp/token-lab-headroom-$HR_PORT.log)"
  fi
  if [ "$HR_OK" = 1 ] && [ -n "$HR_BEDROCK_UP" ]; then
    # Bedrock transport: claude → headroom :$HR_PORT → local gateway ($HR_BEDROCK_UP)
    sub "claude is in Bedrock mode — routing via headroom's Bedrock passthrough to $HR_BEDROCK_UP"
    export EVAL_MODE=headroom-proxy-bedrock
    export EVAL_CLAUDE_SETTINGS="{\"env\":{\"ANTHROPIC_BEDROCK_BASE_URL\":\"http://127.0.0.1:$HR_PORT\",\"AWS_ENDPOINT_URL_BEDROCK_RUNTIME\":\"http://127.0.0.1:$HR_PORT\"}}"
  elif [ "$HR_OK" = 1 ]; then
    export EVAL_MODE=headroom-proxy ANTHROPIC_BASE_URL="http://127.0.0.1:$HR_PORT"
  fi
  for L in headroom headroom_long headroom_chain; do
    [ "$HR_OK" = 1 ] || break
    hr_row "$L" off || { HR_OK=0; hr_fail "no requests reached the proxy — this claude ignores ANTHROPIC_BASE_URL (Vertex, or Bedrock straight to AWS?). Needs first-party auth or a local Bedrock gateway."; }
  done
  if [ "$HR_OK" = 1 ]; then
    sub "ON — headroom proxy --mode $HR_PROXY_MODE (optimizing) on :$HR_PORT"
    hr_start "" || { HR_OK=0; hr_fail "headroom proxy (optimizing) did not come up on :$HR_PORT"; }
  fi
  for L in headroom headroom_long headroom_chain; do
    [ "$HR_OK" = 1 ] || break
    HR_WHY=""
    hr_row "$L" on || { HR_OK=0; hr_fail "${HR_WHY:-no requests reached the proxy during ON}"; }
  done
  if [ "$HR_OK" = 1 ]; then
    unset EVAL_MODE ANTHROPIC_BASE_URL EVAL_CLAUDE_SETTINGS
    hr_stop; trap - EXIT
  fi
elif [ "$HEADROOM_AB" = axcli ] && command -v axcli >/dev/null 2>&1 && axcli config compression >/dev/null 2>&1; then
  say "Headroom A/B (same query, axcli compression off then on)"
  printf "\033[33m   WARNING: headless sessions get no axcli compression — expect OFF = ON. Not a Headroom measurement.\033[0m\n"
  HR_WAS=$(axcli config compression 2>/dev/null | grep -qw on && echo on || echo off)
  trap 'axcli config compression "$HR_WAS" >/dev/null 2>&1' EXIT   # always restore
  sub "OFF — axcli config compression off"
  axcli config compression off >/dev/null 2>&1 || die "could not turn compression off"
  EVAL_MODE=headroom-axcli-mcp ev headroom__off
  EVAL_MODE=headroom-axcli-mcp evt "$LONG_TASK" headroom_long__off
  EVAL_MODE=headroom-axcli-mcp evt "$CHAIN_TASK" headroom_chain__off
  sub "ON — axcli config compression on"
  axcli config compression on >/dev/null 2>&1 || die "could not turn compression on"
  B=$(hr_requests 8787)
  EVAL_MODE=headroom-axcli-mcp ev headroom__on
  EVAL_MODE=headroom-axcli-mcp evt "$LONG_TASK" headroom_long__on
  EVAL_MODE=headroom-axcli-mcp evt "$CHAIN_TASK" headroom_chain__on
  printf "   axcli headroom sidecar requests during ON: %s → %s\n" "${B:-?}" "$(hr_requests 8787)"
  axcli config compression "$HR_WAS" >/dev/null 2>&1
  trap - EXIT
elif [ "$HEADROOM_AB" = proxy ]; then
  skip "Headroom" "'$HEADROOM_BIN' not on PATH (run ./setup.sh, or set HEADROOM_BIN)"
else
  skip "Headroom" "HEADROOM_AB=axcli but axcli has no compression setting"
fi

# ---------- Caveman A/B : plugin off vs on ----------
# Caveman ships in the org marketplace (agentic-builders-hub). Once enabled, its
# SessionStart hook injects the caveman ruleset into every session — no command
# needed. Every toggle here is --scope local (this repo's
# .claude/settings.local.json), so your user-level plugin setup is never touched,
# and the local override is removed afterwards.
CAVEMAN_ID="${CAVEMAN_PLUGIN:-caveman@agentic-builders-hub}"
cv_state() {   # prints: absent | enabled | disabled
  "$CLAUDE_BIN" plugin list --json 2>/dev/null | node -e '
    const id = process.argv[1].split("@")[0];
    const ps = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const hits = ps.filter((p) => p.id.split("@")[0] === id);
    console.log(hits.length === 0 ? "absent" : hits.some((p) => p.enabled) ? "enabled" : "disabled");
  ' "$CAVEMAN_ID" 2>/dev/null || echo absent
}
cv_available() {
  "$CLAUDE_BIN" plugin list --json --available 2>/dev/null | grep -q "\"$CAVEMAN_ID\""
}
CV_FLAG="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.caveman-active"   # rewritten by caveman's SessionStart hook
cv_stamp() { [ -e "$CV_FLAG" ] && stat -f %m "$CV_FLAG" 2>/dev/null || stat -c %Y "$CV_FLAG" 2>/dev/null || echo 0; }

CV_WAS=$(want caveman && cv_state || echo absent)
if ! want caveman; then
  :
elif [ "$CV_WAS" != absent ] || cv_available; then
  say "Caveman A/B (same query, plugin off then on — local scope only)"
  CV_LOCAL_SETTINGS=.claude/settings.local.json
  CV_HAD_DIR=$([ -d .claude ] && echo 1 || echo 0)
  [ -e "$CV_LOCAL_SETTINGS" ] && cp "$CV_LOCAL_SETTINGS" "$CV_LOCAL_SETTINGS.bak.$$"
  CV_INSTALLED=0
  cv_restore() {
    [ "$CV_INSTALLED" = 1 ] && "$CLAUDE_BIN" plugin uninstall "$CAVEMAN_ID" --scope local >/dev/null 2>&1
    if [ -e "$CV_LOCAL_SETTINGS.bak.$$" ]; then mv "$CV_LOCAL_SETTINGS.bak.$$" "$CV_LOCAL_SETTINGS"
    else rm -f "$CV_LOCAL_SETTINGS"; fi
    [ "$CV_HAD_DIR" = 0 ] && rmdir .claude 2>/dev/null
    return 0
  }
  trap cv_restore EXIT

  sub "OFF — caveman not active in this repo"
  [ "$CV_WAS" = enabled ] && { "$CLAUDE_BIN" plugin disable "$CAVEMAN_ID" --scope local >/dev/null 2>&1 || die "could not disable caveman locally"; }
  [ "$(cv_state)" = enabled ] && die "caveman still enabled for the OFF side"
  EVAL_MODE=caveman-plugin ev caveman__off
  EVAL_MODE=caveman-plugin evt "$LONG_TASK" caveman_long__off
  EVAL_MODE=caveman-plugin evt "$CHAIN_TASK" caveman_chain__off

  sub "ON — caveman enabled (local scope)"
  if [ "$CV_WAS" = absent ]; then
    "$CLAUDE_BIN" plugin install "$CAVEMAN_ID" --scope local >/dev/null 2>&1 || die "could not install $CAVEMAN_ID"
    CV_INSTALLED=1
  else
    "$CLAUDE_BIN" plugin enable "$CAVEMAN_ID" --scope local >/dev/null 2>&1 || die "could not enable caveman locally"
  fi
  [ "$(cv_state)" = enabled ] || die "caveman did not enable"
  B=$(cv_stamp)
  EVAL_MODE=caveman-plugin ev caveman__on
  EVAL_MODE=caveman-plugin evt "$LONG_TASK" caveman_long__on
  EVAL_MODE=caveman-plugin evt "$CHAIN_TASK" caveman_chain__on
  [ "$(cv_stamp)" != "$B" ] || { for L in caveman caveman_long caveman_chain; do row $L && rm -f results/${L}__on.json; done; die "caveman's SessionStart hook never ran during ON — refusing to record it"; }
  printf "   caveman hook fired during ON (flag file refreshed)\n"

  cv_restore; trap - EXIT
else
  skip "Caveman" "$CAVEMAN_ID not installed or available in any marketplace"
fi

# ---------- Config A/B : no project config vs tight CLAUDE.md ----------
if want config; then
say "Config A/B (same query, CLAUDE.md off then on)"
for f in CLAUDE.md .claudeignore; do [ -e "$f" ] && mv "$f" "$f.bak.$$"; done
sub "OFF — no CLAUDE.md / .claudeignore"
ev config__off
sub "ON — tight CLAUDE.md + .claudeignore"
cp config/CLAUDE.md.after CLAUDE.md; cp config/claudeignore.after .claudeignore
ev config__on
rm -f CLAUDE.md .claudeignore
for f in CLAUDE.md .claudeignore; do [ -e "$f.bak.$$" ] && mv "$f.bak.$$" "$f"; done
fi

# ---------- CLI-vs-MCP A/B : GitHub/Postgres MCP servers on vs off ----------
# Servers are passed with --mcp-config (via EVAL_MCP_CONFIG), NOT a project
# .mcp.json: headless `claude -p` leaves unapproved project servers "pending"
# with zero tools, which would make OFF identical to ON. run.ts refuses the run
# unless every server in the config reports "connected". Your global config is
# never touched.
if ! want cli; then
  :
elif command -v gh >/dev/null 2>&1 && command -v psql >/dev/null 2>&1; then
  say "CLI-vs-MCP A/B (same query, MCP servers on then off)"
  CLI_MCP=$(mktemp -t token-lab-mcp).json
  trap 'rm -f "$CLI_MCP"' EXIT
  cat > "$CLI_MCP" <<'JSON'
{ "mcpServers": {
  "github":   { "command": "npx", "args": ["-y","@modelcontextprotocol/server-github"] },
  "postgres": { "command": "npx", "args": ["-y","@modelcontextprotocol/server-postgres","postgresql://tokenlab:tokenlab@localhost:5432/tokenlab"] }
} }
JSON
  sub "OFF (control) — GitHub/Postgres MCP servers connected"
  EVAL_MODE=cli-vs-mcp EVAL_MCP_CONFIG="$CLI_MCP" ev cli__off
  sub "ON — no MCP; agent uses gh + psql"
  EVAL_MODE=cli-vs-mcp ev cli__on
  rm -f "$CLI_MCP"; trap - EXIT
else
  skip "CLI-vs-MCP" "gh and/or psql not installed (run ./setup.sh)"
fi

say "Scoreboard — one isolated A/B per optimization"
npm run scoreboard
echo "Next: npm run deck  (rebuilds the scoreboard slide from results/)"
