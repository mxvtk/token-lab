#!/usr/bin/env bash
# Scripted install for the whole workshop. Idempotent — safe to re-run.
# Installs/sets up everything the eval needs, then tells you what's ready and
# what (if anything) still needs your hand. Nothing here fabricates data.
set -uo pipefail
cd "$(dirname "$0")"

ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
warn() { printf "  \033[33m!\033[0m %s\n" "$1"; }
step() { printf "\n\033[1;35m▶ %s\033[0m\n" "$1"; }

step "1. Docker app (web + api + db)"
if docker info >/dev/null 2>&1; then
  docker compose up -d >/dev/null 2>&1 && ok "docker compose up" || warn "docker compose failed — check 'docker compose logs'"
else
  warn "Docker not running — start Docker Desktop, then re-run ./setup.sh"
fi

step "2. Eval runner deps (tsx)"
if command -v npm >/dev/null 2>&1; then
  # Public registry pinned in ./.npmrc — a company registry in ~/.npmrc would ask for npm login.
  if npm install --silent --registry=https://registry.npmjs.org/ >/tmp/token-lab-npm.log 2>&1; then
    ok "npm install"
  else
    warn "npm install failed (full log: /tmp/token-lab-npm.log):"; grep -iE 'err|401|403|auth' /tmp/token-lab-npm.log | head -5 | sed 's/^/      /'
  fi
else
  warn "npm not found — install Node 20+"
fi

step "3. Headroom (compresses tool outputs before the model)"
# Official install (github.com/headroomlabs-ai/headroom, "Install"):
#   uv tool install --python 3.13 "headroom-ai[all]"
# uv fetches Python 3.13 itself and puts the CLI in ~/.local/bin.
HR_LOG_INSTALL=/tmp/token-lab-headroom-install.log
HR_UV_BIN="$HOME/.local/bin/headroom"
if command -v headroom >/dev/null 2>&1; then
  ok "headroom already installed ($(headroom --version 2>/dev/null | head -1))"
elif [ -x "$HR_UV_BIN" ]; then
  ok "headroom already installed in $HR_UV_BIN ($("$HR_UV_BIN" --version 2>/dev/null | head -1))"
elif [ -x "$HOME/.venvs/headroom/bin/headroom" ]; then
  ok "headroom already installed in ~/.venvs/headroom"
else
  if ! command -v uv >/dev/null 2>&1; then
    if command -v brew >/dev/null 2>&1; then
      brew install uv >"$HR_LOG_INSTALL" 2>&1 && ok "installed uv" || warn "brew install uv failed (log: $HR_LOG_INSTALL)"
    else
      warn "uv not found — install it: https://docs.astral.sh/uv/getting-started/installation/"
    fi
  fi
  if command -v uv >/dev/null 2>&1; then
    if uv tool install --python 3.13 "headroom-ai[all]" >>"$HR_LOG_INSTALL" 2>&1; then
      uv tool update-shell >/dev/null 2>&1   # puts ~/.local/bin on PATH for new shells
      ok "headroom installed ($("$HR_UV_BIN" --version 2>/dev/null | head -1)) — open a new terminal if 'headroom' isn't found"
    else
      warn "headroom install failed (full log: $HR_LOG_INSTALL):"
      tail -5 "$HR_LOG_INSTALL" | sed 's/^/      /'
      warn "behind a corporate SSL proxy? see https://github.com/headroomlabs-ai/headroom#install (Corporate networks)"
    fi
  fi
fi

step "4. Caveman plugin (compresses the model's output)"
# Only CHECK here. The eval toggles caveman itself, in this repo only
# (--scope local), so your other sessions are never switched to caveman mode.
# Source: Anthropic's public community marketplace (anthropics/claude-plugins-community,
# marketplace name "claude-community"), which pins upstream JuliusBrussee/caveman.
CAVEMAN_ID="${CAVEMAN_PLUGIN:-caveman@claude-community}"
cv_avail() { node scripts/caveman-avail.mjs "$CAVEMAN_ID" "$@"; }
CV_ADD_LOG=/tmp/token-lab-caveman-marketplace.log
: > "$CV_ADD_LOG"
if ! cv_avail && [ "$CAVEMAN_ID" = caveman@claude-community ]; then
  if claude plugin marketplace list --json 2>/dev/null | grep -q '"claude-community"'; then
    # Configured but caveman missing from it: the local copy is stale.
    claude plugin marketplace update claude-community >>"$CV_ADD_LOG" 2>&1 \
      && ok "updated Anthropic community marketplace (claude-community)"
  else
    # Shorthand clones over SSH first; the HTTPS URL is the fallback for machines without a GitHub SSH key.
    for src in anthropics/claude-plugins-community https://github.com/anthropics/claude-plugins-community.git; do
      echo "\$ claude plugin marketplace add $src" >>"$CV_ADD_LOG"
      claude plugin marketplace add "$src" >>"$CV_ADD_LOG" 2>&1 \
        && { ok "added Anthropic community marketplace (claude-community) from $src"; break; }
    done
  fi
fi
if cv_avail; then
  ok "$CAVEMAN_ID available — the eval enables it for this repo only"
elif claude plugin list --json 2>/dev/null | grep -q "\"caveman@"; then
  ok "caveman already installed"
else
  warn "$CAVEMAN_ID not found ($(claude --version 2>/dev/null | head -1)):"
  cv_avail --why
  [ -s "$CV_ADD_LOG" ] && { warn "marketplace add/update said (full log: $CV_ADD_LOG):"; tail -6 "$CV_ADD_LOG" | sed 's/^/      /'; }
  warn "by hand: claude plugin marketplace add https://github.com/anthropics/claude-plugins-community.git"
fi

step "5. CLI tools for the CLI-vs-MCP phase (gh + psql)"
# Homebrew's libpq is keg-only: psql lands in $(brew --prefix libpq)/bin, which
# is NOT on PATH. Add it for this script (the eval does the same itself).
libpq_path() {
  command -v brew >/dev/null 2>&1 || return 0
  local d; d="$(brew --prefix libpq 2>/dev/null)/bin"
  [ -x "$d/psql" ] && case ":$PATH:" in *":$d:"*) ;; *) PATH="$d:$PATH" ;; esac
  return 0
}
libpq_path
have_gh=$(command -v gh >/dev/null 2>&1 && echo 1 || echo 0)
have_psql=$(command -v psql >/dev/null 2>&1 && echo 1 || echo 0)
if [ "$have_gh" = 1 ] && [ "$have_psql" = 1 ]; then
  ok "gh and psql present"
elif command -v brew >/dev/null 2>&1; then
  [ "$have_gh" = 0 ]   && { brew install gh    >/dev/null 2>&1 && ok "installed gh"   || warn "brew install gh failed"; }
  [ "$have_psql" = 0 ] && { brew install libpq >/dev/null 2>&1 && libpq_path && command -v psql >/dev/null 2>&1 \
    && ok "installed psql (libpq, $(dirname "$(command -v psql)") — the eval finds it automatically)" \
    || warn "brew install libpq failed, or psql still not found"; }
else
  warn "install gh and psql (libpq) manually — no brew found"
fi

step "6. Claude auth"
if claude -p "reply with: ok" --output-format json </dev/null 2>/dev/null | node scripts/claude-ok.mjs; then
  ok "claude is logged in"
else
  warn "claude NOT logged in — run 'claude' and sign in (the eval can't record real numbers without this)"
fi

printf "\n\033[1mSetup done.\033[0m Next:  npm run eval:all\n"
