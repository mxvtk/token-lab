#!/usr/bin/env bash
# token-lab pre-flight check. Run BEFORE the workshop.
# Verifies the stack, Claude Code, and gh. Prints a green checklist.
#
#   ./preflight.sh              # full check (Docker stack)
#   NO_DOCKER=1 ./preflight.sh  # api :3001 + web :5173 already running without Docker
#
# The auth check makes one tiny `claude -p` call (a few cents on an API key).
# Set SKIP_CLAUDE_CALL=1 to skip it.
set -uo pipefail
cd "$(dirname "$0")"

ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
bad()  { printf "  \033[31m✗\033[0m %s\n" "$1"; FAIL=1; }
note() { printf "  \033[33m-\033[0m %s\n" "$1"; }
FAIL=0
START_HINT="run 'docker compose up -d' and wait ~20s"
[ "${NO_DOCKER:-0}" = 1 ] && START_HINT="start the api on :3001 (PGHOST/PGUSER/PGPASSWORD/PGDATABASE set) and the web on :5173"

echo "token-lab pre-flight"
echo "--------------------"

# 1–2. Docker (skipped with NO_DOCKER=1)
if [ "${NO_DOCKER:-0}" = 1 ]; then
  note "NO_DOCKER=1 — Docker checks skipped"
else
  if docker info >/dev/null 2>&1; then ok "Docker is running"; else bad "Docker not running — start Docker Desktop (or NO_DOCKER=1 if the stack runs without it)"; fi
  if docker compose config >/dev/null 2>&1; then ok "docker-compose.yml is valid"; else bad "docker compose config failed"; fi
fi

# 3. API responds
if curl -fs http://localhost:3001/api/users >/dev/null 2>&1; then ok "API responds on :3001"; else bad "API not responding on :3001 — $START_HINT"; fi

# 4. Web responds
if curl -fs http://localhost:5173 >/dev/null 2>&1; then ok "Web responds on :5173"; else bad "Web not responding on :5173 — $START_HINT"; fi

# 5. Headroom proxy port must be free (eval:all starts its own proxy there)
HR_PORT="${HEADROOM_AB_PORT:-8788}"
HR_HAVE=$(command -v headroom >/dev/null 2>&1 || [ -x "$HOME/.local/bin/headroom" ] || [ -x "$HOME/.venvs/headroom/bin/headroom" ] && echo 1 || echo 0)
if [ "$HR_HAVE" = 0 ]; then
  note "Headroom not installed — optional, the eval skips its A/B (./setup.sh --with-headroom to add it)"
elif lsof -nP -iTCP:"$HR_PORT" -sTCP:LISTEN >/dev/null 2>&1 || curl -s -m 1 "http://127.0.0.1:$HR_PORT" >/dev/null 2>&1; then
  bad "port $HR_PORT is in use — the Headroom A/B needs it (free it, or set HEADROOM_AB_PORT)"
else
  ok "port $HR_PORT free (Headroom proxy)"
fi

# 6. Claude Code installed + authenticated
if command -v claude >/dev/null 2>&1; then
  ok "claude CLI installed"
  if [ "${SKIP_CLAUDE_CALL:-0}" = 1 ]; then
    note "SKIP_CLAUDE_CALL=1 — auth not checked"
  elif claude -p "reply with the single word: ok" --output-format json </dev/null 2>/dev/null | node scripts/claude-ok.mjs; then
    ok "claude is authenticated"
  else
    bad "claude not authenticated — run 'claude' once and sign in"
  fi
else
  bad "claude CLI not found — install Claude Code"
fi

# 7. gh CLI authenticated
if command -v gh >/dev/null 2>&1; then
  if gh auth status >/dev/null 2>&1; then ok "gh authenticated"; else bad "gh not authenticated — run 'gh auth login'"; fi
else
  bad "gh CLI not found — install the GitHub CLI"
fi

# 8. node (for the eval runner)
if command -v node >/dev/null 2>&1; then ok "node installed (eval runner)"; else bad "node not found — install Node 20+"; fi

echo "--------------------"
if [ "$FAIL" -eq 0 ]; then
  printf "\033[32mAll green — you're ready for the workshop.\033[0m\n"
else
  printf "\033[31mSome checks failed — fix the ✗ items before the session.\033[0m\n"
  exit 1
fi
