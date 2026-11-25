# token-lab

Sandbox for the workshop **"Minimizing LLM Token Spend When Coding with AI Agents."**
A trivial full-stack TypeScript app (React + Express + Postgres), fully Dockerized,
with a tiny eval that measures token usage before and after four optimizations.

## Stack
- `web/` — Vite + React list/detail view
- `api/` — Express REST API + Postgres seed
- `eval/` — headless Claude Code runner + scoreboard
- `config/` — reference "after" config for Section 4
- `results/` — the facilitator's measured A/B baseline the deck is built from
  (`<opt>__off.json` / `__on.json` + per-rep `.runs/`)
- `results/local/` — your own runs (gitignored); `eval:all` writes here

## Quick start (do this in pre-flight, before the workshop)
```bash
docker compose up -d          # web :5173, api :3001, db :5432
npm install                   # for the eval runner (tsx)
./preflight.sh                # verifies docker, stack, claude, gh, node, port 8788
```
No Docker? Run the api on :3001 against your own Postgres on :5432 (user/db/password
`tokenlab`), the web on :5173, then `NO_DOCKER=1 ./preflight.sh`. The eval only needs
something answering on `http://localhost:3001/api/users`.

`preflight.sh` makes one tiny `claude -p` call to check auth (a few cents on an API
key); `SKIP_CLAUDE_CALL=1` skips it.

> `web/src/App.tsx` has a deliberate bug: it crashes **only when the API returns an empty
> list** (a normal seeded DB renders fine). That's eval **task 2** — leave it until the workshop.

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
`caveman` plugin disable/enable (this repo only), `CLAUDE.md` + `permissions.deny` absent/present,
GitHub/Postgres MCP servers on/off (passed with `--mcp-config`, your global config untouched) —
runs the same task each side, and writes `results/local/<opt>__off.json` / `__on.json`
(`RESULTS_DIR=…` to change; `results/` itself is the facilitator baseline). It
**refuses to run** (rather than record zeros) if `claude` isn't logged in, and refuses to
record an A/B whose toggle provably didn't take effect (Headroom: no requests reached the
proxy; Caveman: its hook never fired; MCP: a server didn't connect). A Headroom failure
skips the Headroom rows only — the other A/Bs still run.

### Running the participant tests
How to run every test designed for workshop participants, what to check, and what
to send back to the facilitator.

#### 0. What the machine needs
- **Docker Desktop**, running — or your own api + Postgres (see Quick start, `NO_DOCKER=1`).
  Ports **5173** (web), **3001** (api), **5432** (Postgres) are used by the app; with
  Headroom installed, **8788** (its proxy) must be free too. `preflight.sh` checks them.
- **Node 20+**.
- **Homebrew** (macOS) — `setup.sh` uses it to install `uv`, `gh` and `psql` if missing.
- **Headroom — optional, not needed for the workshop.** The facilitator demos it. Its install
  can take 20+ minutes, so `setup.sh` skips it and `eval:all` skips the Headroom A/B. To try it
  at home, see [Try Headroom at home](#try-headroom-at-home).
- **Claude Code** (`claude` on PATH), a current version, logged in with **claude.ai or an
  Anthropic API key**. Old versions (2.0.x) lack the plugin commands the eval uses
  (`plugin list --json`, `plugin install --scope local`) and can't read the community
  marketplace (`Invalid schema: plugins.N.source`). `setup.sh` runs `claude update` when it
  finds one.
  Bedrock through a *local* gateway (`ANTHROPIC_BEDROCK_BASE_URL=http://127.0.0.1:…`)
  also works. Vertex, or Bedrock straight to AWS, can't be routed through Headroom —
  the Headroom tests are skipped.
- **`gh auth login`** done.
- **Caveman plugin:** [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman), installed as
  `caveman@claude-community` from Anthropic's public community marketplace
  ([anthropics/claude-plugins-community](https://github.com/anthropics/claude-plugins-community)).
  `setup.sh` adds the marketplace (HTTPS fallback if the SSH clone fails) and, if caveman still
  isn't available, prints why. By hand: `claude plugin marketplace add https://github.com/anthropics/claude-plugins-community.git`.
  Not `caveman@anthropic-plugin-directory` — that is a different plugin with the same name.
  If you already have a `caveman` from another marketplace (e.g. `caveman@caveman`), the eval
  turns it off for both sides, in this repo only, and turns it back on afterwards.

#### 1. Get the repo and set up
```bash
git clone https://github.com/mxvtk/token-lab && cd token-lab
./setup.sh       # docker up, npm install, Claude Code version, caveman check, gh/psql, claude auth
./preflight.sh   # should end with "All green"
```
Every `setup.sh` line should be ✓ — note any `!` line.

> Do not fix `web/src/App.tsx`. Its crash on an empty API response is deliberate — it is eval task 2.

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
| Config | no `CLAUDE.md`, no project `.claude/settings.json` | `config/CLAUDE.md.after` + `config/settings.json.after` (`permissions.deny`) | `## Denied by permissions` in a rep's `.md` when a deny rule fired |
| CLI vs MCP | GitHub + Postgres MCP servers connected | no MCP, agent uses `gh` + `psql` | run refused if a server isn't `connected` |

**About the Config number in the deck.** It comes from `results/config__off.json` →
`results/config__on.json`: **task 1 only, n=3 per side**, median 147,398 → 111,548 tokens,
and every rep went from **4 turns to 3**. One fewer turn is where the saving comes from; the
result files don't record tool calls, so *which* step was skipped isn't measured. Those
files predate recording the Claude Code version, and their ON side used the old config
(`CLAUDE.md` + a `.claudeignore`, which Claude Code doesn't read), so it measured
`CLAUDE.md` alone. A second run on another machine (Linux, no Docker) found Config
**within noise** on tasks 1–4. Treat it as one facilitator run that may not reproduce —
measure it on your own repo.

The ON side now also denies reads of `results/` (tracked: prior runs' answers and diffs,
which Grep would otherwise find), `node_modules`, `dist` and lockfiles via
`permissions.deny`. That version hasn't been measured yet.

`⤼ SKIP Headroom A/B` is expected unless you installed Headroom. If you did, check:
1. The Headroom section ran.
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

#### Try Headroom at home
The workshop only demos Headroom. To measure it yourself:
```bash
./setup.sh --with-headroom                       # official install: uv tool install --python 3.13 "headroom-ai[all]" (20+ min)
npm run eval:all -- --only headroom --task 1      # ≈ $1.20
npm run eval:all -- --only headroom --long --task 1   # adds the long-answer and long-chat rows, ≈ $6.25
```
Port 8788 must be free (`./preflight.sh` checks it once Headroom is installed). Behind a
corporate SSL proxy, see the [install notes](https://github.com/headroomlabs-ai/headroom#install).
Compare with the facilitator's numbers in `results/headroom*.json`. On task 1 Headroom used
*more* tokens there, so measure before you keep it.

#### 5. Other tasks (not measured yet)
- `npm run eval:all` with no `--task` runs tasks 1–4 on every A/B. Tasks 2–4 are not in
  the facilitator baseline, so there is no cost figure for them. Task 4 is noisy (its
  reps varied by more than any A/B difference), so it runs **5 reps** by default
  (`reps:` in `eval/tasks.yaml`; `--reps N` overrides). Don't read a Task 4 delta as a
  win unless the OFF and ON ranges don't overlap.
- Task 5 **opens a real GitHub PR** and is never part of the batch. Only on your own fork:
  `npm run eval -- --label live --task 5`.

#### 6. Check the answers
Each rep saves the agent's answer, its diff and its token usage in
`results/local/<label>.runs/task<N>-rep<R>.md`. Grade it against the task's `grade:` line in
`eval/tasks.yaml` (task 1: "GET /api/health returns {status:'ok'}"). Token numbers only
count if the answers are correct.
```bash
npm run scoreboard                 # reads results/local/ once it has runs, else the baseline
node scripts/results-summary.mjs   # every OFF/ON pair: tokens, range, output, cache reads, turns, $
RESULTS_DIR=results npm run scoreboard   # the facilitator baseline
```
Overlapping OFF/ON ranges print as **within noise** — that is a result, not a failure.

#### 7. Send back to the facilitator
1. The full terminal output of `eval:all` — especially every `✗` line, verbatim.
2. `npm run scoreboard` output.
3. The whole `results/local/` folder (`.json`, `.runs/`, `*.headroom-metrics.txt`). Each
   `.json` records `claude_version` and `model`.
4. How you're logged in: claude.ai, API key, or Bedrock via a local gateway.

#### Rules
- **Never run two evals at once** — they share the app tree (reset via git between reps)
  and the proxy port.
- Your runs go to `results/local/` and never touch the baseline in `results/`.
- If `claude` isn't logged in, the run refuses to start instead of recording zeros.

#### Cost (facilitator's recorded runs, Sonnet, 3 reps per side; sum of all reps per row)
| Run | Recorded cost |
|---|---|
| One A/B row on task 1 | $0.44–$0.60 per row |
| `eval:all -- --task 1` (8 rows) | ≈ $4.01 |
| `--only headroom --long --task 1` (6 rows) | ≈ $6.25 |
| Headroom long (task 6), per row | $0.59 OFF / $0.97 ON |
| Headroom chat (task 7), per row | $1.53 OFF / $1.96 ON |
| `preflight.sh` / `setup.sh` auth check | one tiny `claude -p` call (a few cents) |

The Caveman long/chat rows were recorded before the per-step cost fix (their files lack
`"cost_accounting": "session-delta"`), so their recorded cost is overcounted; there is no
corrected figure yet.

### Setup is scripted too
```bash
./setup.sh                  # docker up, npm install, Claude Code version, caveman check, gh/psql, auth
./setup.sh --with-headroom  # the same, plus Headroom (slow)
```
With `--with-headroom`, Headroom is installed with `uv tool install --python 3.13 "headroom-ai[all]"` into
`~/.local/bin`. `eval:all` finds it there even before a new shell picks up the PATH; set
`HEADROOM_BIN` to use another copy.

No savings number is claimed in advance — every figure comes from a real run.
`npm run scoreboard` shows `—` for any A/B that has no OFF+ON pair yet.

### Scoreboard
`results/<opt>__off.json` / `__on.json` hold the facilitator's measured runs (each with its
`.runs/` folder: the agent's answer, its diff and usage per rep, so every number can be
checked). The deck is built from these. Your own `eval:all` writes to `results/local/`.
Every figure in the deck is one facilitator run on one machine and model — yours may vary.

Cost: in a multi-message chat `claude` reports `total_cost_usd` cumulatively per session,
so the runner records only each step's increase. Files written that way carry
`"cost_accounting": "session-delta"`; the deck ignores the cost of files without it.

## The four optimizations (workshop flow)
1. **Headroom** (demo only; [try it at home](#try-headroom-at-home)) — the [headroomlabs-ai/headroom](https://github.com/headroomlabs-ai/headroom) proxy; compresses tool outputs/logs/JSON before they reach the model (`headroom wrap`).
2. **Caveman plugin** (demo) — [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) (`caveman@claude-community`); compresses the model's own output.
3. **Config** (hands-on) — add a tight `CLAUDE.md` + `permissions.deny` in `.claude/settings.json`
   (Claude Code does not read `.claudeignore`). Reference in `config/`.
4. **CLI instead of MCP** (hands-on) — `gh` and `psql` instead of MCP servers.

## Budget note
Default model is **Sonnet**, never Opus. Participants spend their own budget only in
the two hands-on sections (~2 small runs). Everything else is demoed or pre-baked.
