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
  npm install --silent >/dev/null 2>&1 && ok "npm install" || warn "npm install failed"
else
  warn "npm not found — install Node 20+"
fi

step "3. Headroom (compresses tool outputs before the model)"
# Installed into its own venv: Homebrew Python refuses `pip install --user`
# (PEP 668, externally-managed-environment). eval/run-all.sh finds it there.
HR_VENV="$HOME/.venvs/headroom"
if command -v headroom >/dev/null 2>&1; then
  ok "headroom already installed ($(headroom --version 2>/dev/null | head -1))"
elif [ -x "$HR_VENV/bin/headroom" ]; then
  ok "headroom already installed in $HR_VENV ($("$HR_VENV/bin/headroom" --version 2>/dev/null | head -1))"
elif command -v python3 >/dev/null 2>&1; then
  python3 -m venv "$HR_VENV" >/dev/null 2>&1 \
    && "$HR_VENV/bin/pip" install -q "headroom-ai[all]" >/dev/null 2>&1 \
    && ok "installed into $HR_VENV" \
    || warn "headroom install failed — try: python3 -m venv $HR_VENV && $HR_VENV/bin/pip install \"headroom-ai[all]\""
else
  warn "no python3 — install Python 3.10+, then re-run ./setup.sh"
fi

step "4. Caveman plugin (compresses the model's output)"
# Only CHECK here. The eval toggles caveman itself, in this repo only
# (--scope local), so your other sessions are never switched to caveman mode.
CAVEMAN_ID="${CAVEMAN_PLUGIN:-caveman@agentic-builders-hub}"
if claude plugin list --json --available 2>/dev/null | grep -q "\"$CAVEMAN_ID\""; then
  ok "$CAVEMAN_ID available — the eval enables it for this repo only"
elif claude plugin list --json 2>/dev/null | grep -q "\"caveman@"; then
  ok "caveman already installed"
else
  warn "$CAVEMAN_ID not found — add the org marketplace (agentic-builders-hub), or set CAVEMAN_PLUGIN=<id>"
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
if claude -p "reply with: ok" --output-format json </dev/null 2>/dev/null | grep -q '"is_error":false'; then
  ok "claude is logged in"
else
  warn "claude NOT logged in — run 'claude' and sign in (the eval can't record real numbers without this)"
fi

printf "\n\033[1mSetup done.\033[0m Next:  npm run eval:all\n"
