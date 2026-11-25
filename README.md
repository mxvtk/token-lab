# token-lab

Sandbox for the workshop **"Minimizing LLM Token Spend When Coding with AI Agents."**
A trivial full-stack TypeScript app (React + Express + Postgres), fully Dockerized,
with a tiny eval that measures token usage before and after four optimizations.

## Stack
- `web/` — Vite + React list/detail view
- `api/` — Express REST API + Postgres seed
- `eval/` — headless Claude Code runner + scoreboard
- `config/` — reference "after" config for Section 4
- `results/` — measured A/B results (`<opt>__off.json` / `__on.json` + per-rep `.runs/`)

## Quick start (do this in pre-flight, before the workshop)
```bash
docker compose up -d          # web :5173, api :3001, db :5432
npm install                   # for the eval runner (tsx)
./preflight.sh                # verifies docker, stack, claude, gh, node
```
Open http://localhost:5173 — you'll see the users list.

> Note: `web/src/App.tsx` has a deliberate bug (it crashes on an empty user list).
> That's eval **task 2** — leave it until the workshop.

## The eval — per-optimization A/B
The core idea: run the **same query** with each optimization **off, then on**, and
report the difference. Every optimization is an isolated A/B; nothing is cumulative.
Fixed tasks live in `eval/tasks.yaml`; the runner drives Claude Code headlessly and
records real token usage per run.

### One command (after `./setup.sh`)
```bash
npm run eval:all            # runs every off/on A/B, scripted toggles, prints scoreboard
npm run eval:all -- --task 1   # one task across all A/Bs (cheap, for a Pro window)
npm run eval:all -- --long     # also the long-answer (task 6) and long-chat (task 7) rows
```
`eval:all` flips each optimization automatically — Headroom proxy passthrough/optimizing,
`caveman` plugin disable/enable (this repo only), `CLAUDE.md` absent/present, GitHub/Postgres
MCP servers on/off (passed with `--mcp-config`, your global config untouched) — runs the
same task each side, and writes `results/<opt>__off.json` / `results/<opt>__on.json`. It
**refuses to run** (rather than record zeros) if `claude` isn't logged in, and refuses to
record an A/B whose toggle provably didn't take effect (Headroom: no requests reached the
proxy; Caveman: its hook never fired; MCP: a server didn't connect). A Headroom failure
skips the Headroom rows only — the other A/Bs still run.

### Running the participant tests (tester / dry run)
How to run every test designed for workshop participants, what to check, and what
to send back to the facilitator.

#### 0. What the machine needs
- **Docker Desktop**, running. Ports **5173** (web), **3001** (api), **5432** (Postgres)
  and **8788** (Headroom proxy) must be free.
- **Node 20+** and **Python 3.10+**.
- **Homebrew** (macOS) — `setup.sh` uses it to install `gh` and `psql` if missing.
- **Claude Code** (`claude` on PATH), logged in with **claude.ai or an Anthropic API key**.
  Bedrock through a *local* gateway (`ANTHROPIC_BEDROCK_BASE_URL=http://127.0.0.1:…`)
  also works. Vertex, or Bedrock straight to AWS, can't be routed through Headroom —
  the Headroom tests are skipped.
- **`gh auth login`** done.
- **Caveman plugin:** the Caveman tests need `caveman@agentic-builders-hub` from the
  monday org plugin marketplace. Without it you get `⤼ SKIP Caveman` — expected, not a failure.

#### 1. Get the repo and set up
```bash
git clone https://github.com/mxvtk/token-lab && cd token-lab
./setup.sh       # docker up, npm install, Headroom venv, caveman check, gh/psql, claude auth
./preflight.sh   # should end with "All green"
```
Every `setup.sh` line should be ✓ — note any `!` line. Open http://localhost:5173: you
should see a users list.

> Do not fix `web/src/App.tsx`. Its crash on an empty list is deliberate — it is eval task 2.

#### 2. Main test — every A/B on one task (≈ $4)
```bash
npm run eval:all -- --task 1
```
Runs the same task with each optimization **off, then on** (3 reps per side), flipping
each switch itself, then prints the scoreboard:

| Section | OFF | ON | Printed proof the switch flipped |
|---|---|---|---|
| Headroom | proxy `--mode token --no-optimize` | proxy optimizing | `headroom proxy requests during …: N → M, pipeline ran on K` |
| Caveman | plugin disabled (this repo only) | plugin enabled (this repo only) | `caveman hook fired during ON (flag file refreshed)` |
| Config | no `CLAUDE.md` / `.claudeignore` | `config/*.after` files | — |
| CLI vs MCP | GitHub + Postgres MCP servers connected | no MCP, agent uses `gh` + `psql` | run refused if a server isn't `connected` |

Check:
1. The Headroom section ran (no `⤼ SKIP Headroom`).
2. Every Headroom row shows **M > N**, and every `__on` row shows **K > 0**. With K = 0 on
   an ON row the script refuses to record it and says why.
3. The `saved`/`compress` metric lines grew under `headroom_…__on` and did **not** grow
   under `__off`.

#### 3. Hands-on sections, one at a time
What participants run themselves during the workshop:
```bash
npm run eval:all -- --only config --task 1
npm run eval:all -- --only cli --task 1
```
The demo sections can also run alone:
```bash
npm run eval:all -- --only headroom --task 1
npm run eval:all -- --only caveman --task 1
```

#### 4. Long tests (optional, costs more)
Adds **task 6** (one long written code review) and **task 7** (a six-message chat in one
session: reads files, logs and psql, then edits and writes a PR description):
```bash
npm run eval:all -- --only headroom --long --task 1
npm run eval:all -- --long --task 1                  # everything
npm run eval:all -- --only caveman --rows caveman_chain   # a single row
```

#### 5. Other tasks (not measured yet)
- `npm run eval:all` with no `--task` runs tasks 1–4 on every A/B. Tasks 2–4 have not been
  run on this setup yet, so there is no cost figure for them.
- Task 5 **opens a real GitHub PR** and is never part of the batch. Only on your own fork:
  `npm run eval -- --label live --task 5`.

#### 6. Check the answers
Each rep saves the agent's answer, its diff and its token usage in
`results/<label>.runs/task<N>-rep<R>.md`. Grade it against the task's `grade:` line in
`eval/tasks.yaml` (task 1: "GET /api/health returns {status:'ok'}"). Token numbers only
count if the answers are correct.
```bash
npm run scoreboard
node scripts/results-summary.mjs   # every OFF/ON pair: tokens, range, output, cache reads, turns, $
```

#### 7. Send back to the facilitator
1. The full terminal output of `eval:all` — especially every `✗` line, verbatim.
2. `npm run scoreboard` output.
3. The whole `results/` folder (`.json`, `.runs/`, `*.headroom-metrics.txt`).
4. How you're logged in: claude.ai, API key, or Bedrock via a local gateway.

#### Rules
- **Never run two evals at once** — they share the app tree (reset via git between reps)
  and the proxy port.
- Your runs **overwrite** `results/<opt>__off.json` / `__on.json` with your numbers.
- If `claude` isn't logged in, the run refuses to start instead of recording zeros.

#### Cost (facilitator's recorded runs, Sonnet, 3 reps per side)
| Run | Recorded cost |
|---|---|
| One A/B row on task 1 | $0.44–$0.49 per row |
| `eval:all -- --task 1` (8 rows) | ≈ $3.80 |
| `--only headroom --long --task 1` (6 rows) | ≈ $5.70 |
| Headroom long (task 6), per row | $0.87 OFF / $0.78 ON |
| Headroom chat (task 7), per row | $1.55 OFF / $1.57 ON |

The Caveman long/chat rows were recorded before the per-step cost fix (their files lack
`"cost_accounting": "session-delta"`), so their recorded cost is overcounted; there is no
corrected figure yet.

### Setup is scripted too
```bash
./setup.sh      # docker up, npm install, install Headroom, enable caveman, gh/psql, check auth
```
Headroom goes into its own venv (`~/.venvs/headroom`) — Homebrew Python refuses
`pip install --user`. `eval:all` finds it there; set `HEADROOM_BIN` to use another copy.

No savings number is claimed in advance — every figure comes from a real run.
`npm run scoreboard` shows `—` for any A/B that has no OFF+ON pair yet.

### Scoreboard
`results/<opt>__off.json` / `__on.json` hold the facilitator's measured runs (each with its
`.runs/` folder: the agent's answer, its diff and usage per rep, so every number can be
checked). Your own `eval:all` overwrites them with your numbers.

Cost: in a multi-message chat `claude` reports `total_cost_usd` cumulatively per session,
so the runner records only each step's increase. Files written that way carry
`"cost_accounting": "session-delta"`; the deck ignores the cost of files without it.

## The four optimizations (workshop flow)
1. **Headroom** (demo) — the [headroomlabs-ai/headroom](https://github.com/headroomlabs-ai/headroom) proxy; compresses tool outputs/logs/JSON before they reach the model (`headroom wrap`).
2. **Caveman plugin** (demo) — compress the model's own output.
3. **Config** (hands-on) — add a tight `CLAUDE.md` + `.claudeignore`. Reference in `config/`.
4. **CLI instead of MCP** (hands-on) — `gh` and `psql` instead of MCP servers.

## Budget note
Default model is **Sonnet**, never Opus. Participants spend their own budget only in
the two hands-on sections (~2 small runs). Everything else is demoed or pre-baked.
