# token-lab

Sandbox for the workshop **"Minimizing LLM Token Spend When Coding with AI Agents."**
A trivial full-stack TypeScript app (React + Express + Postgres), fully Dockerized,
with a tiny eval that measures token usage before and after four optimizations.

## Stack
- `web/` — Vite + React list/detail view
- `api/` — Express REST API + Postgres seed
- `eval/` — headless Claude Code runner + scoreboard
- `config/` — reference "after" config for Section 4
- `results/` — **pre-baked** eval results so the scoreboard works out of the box

## Quick start (do this in pre-flight, before the workshop)
```bash
docker compose up -d          # web :5173, api :3001, db :5432
npm install                   # for the eval runner (tsx)
./preflight.sh                # verifies docker, stack, claude, gh, node
```
Open http://localhost:5173 — you'll see the users list.

> Note: `web/src/App.tsx` has a deliberate bug (it crashes on an empty user list).
> That's eval **task 2** — leave it until the workshop.

## The eval
Fixed tasks live in `eval/tasks.yaml`. The runner drives Claude Code headlessly and
records token usage per task.

```bash
# one task, live — what participants run (stays inside a Pro window)
npm run eval -- --label config --task 1

# full set — facilitator pre-run only
npm run eval -- --label baseline

# show the side-by-side scoreboard
npm run scoreboard
```

Each run writes `results/<label>.json`. Grading is manual/binary: the runner prints
a grade hint per task; you mark pass/fail. Token numbers are automatic.

### Pre-baked scoreboard
`results/` already contains `baseline, headroom, caveman, config, cli`, so
`npm run scoreboard` shows the full falling curve even before anyone runs a thing.
This is the no-token fallback — nobody is blocked by their plan limit.

## The four optimizations (workshop flow)
1. **Headroom** (demo) — keep the context window lean.
2. **Caveman plugin** (demo) — compress model output.
3. **Config** (hands-on) — add a tight `CLAUDE.md` + `.claudeignore`. Reference in `config/`.
4. **CLI instead of MCP** (hands-on) — `gh` and `psql` instead of MCP servers.

## Budget note
Default model is **Sonnet**, never Opus. Participants spend their own budget only in
the two hands-on sections (~2 small runs). Everything else is demoed or pre-baked.
