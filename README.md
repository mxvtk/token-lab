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
npm run eval:all -- --long     # also the long-answer (task 6) and long-chat (task 7) rows — ~$30
```
`eval:all` flips each optimization automatically — Headroom proxy passthrough/optimizing,
`caveman` plugin disable/enable (this repo only), `CLAUDE.md` absent/present, GitHub/Postgres
MCP servers on/off (passed with `--mcp-config`, your global config untouched) — runs the
same task each side, and writes `results/<opt>__off.json` / `results/<opt>__on.json`. It
**refuses to run** (rather than record zeros) if `claude` isn't logged in, and refuses to
record an A/B whose toggle provably didn't take effect (Headroom: no requests reached the
proxy; Caveman: its hook never fired; MCP: a server didn't connect). A Headroom failure
skips the Headroom rows only — the other A/Bs still run.

### Dry run of the participant path (facilitator, before the workshop)
Run this on a machine set up **like a participant's**: plain `claude` on PATH, logged in
with first-party auth (claude.ai / Anthropic API — *not* Bedrock/Vertex, which ignore
`ANTHROPIC_BASE_URL`, so the Headroom proxy can't see the traffic).
```bash
./setup.sh                     # every line should be ✓ — note any ! lines
npm run eval:all -- --task 1   # default rows; about $4
```
Check, and send back to the facilitator:
1. The `Headroom A/B` section ran (not `⤼ SKIP`), and each row printed
   `headroom proxy requests during …: N → M` with M > N.
2. The `saved/compress` metric lines under `headroom_…__on` grew, and under `__off` did not —
   that is the proof Headroom was really off, then on. The raw `/metrics` snapshots are in
   `results/*.headroom-metrics.txt`.
3. `npm run scoreboard` output, plus the whole `results/` folder (json + `.runs/` + metrics).
4. Any `✗` line, verbatim.

Optional, if budget allows: `npm run eval:all -- --only headroom --long` (adds the
long-answer and long-chat Headroom rows, ~$15).

### Setup is scripted too
```bash
./setup.sh      # docker up, npm install, install Headroom, enable caveman, gh/psql, check auth
```

No savings number is claimed in advance — every figure comes from a real run.
`npm run scoreboard` shows `—` for any A/B that has no OFF+ON pair yet.

### Scoreboard
`results/<opt>__off.json` / `__on.json` hold the facilitator's measured runs (each with its
`.runs/` folder: the agent's answer, its diff and usage per rep, so every number can be
checked). Your own `eval:all` overwrites them with your numbers.

## The four optimizations (workshop flow)
1. **Headroom** (demo) — the [headroomlabs-ai/headroom](https://github.com/headroomlabs-ai/headroom) proxy; compresses tool outputs/logs/JSON before they reach the model (`headroom wrap`).
2. **Caveman plugin** (demo) — compress the model's own output.
3. **Config** (hands-on) — add a tight `CLAUDE.md` + `.claudeignore`. Reference in `config/`.
4. **CLI instead of MCP** (hands-on) — `gh` and `psql` instead of MCP servers.

## Budget note
Default model is **Sonnet**, never Opus. Participants spend their own budget only in
the two hands-on sections (~2 small runs). Everything else is demoed or pre-baked.
