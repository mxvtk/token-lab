#!/usr/bin/env node
/**
 * token-lab eval runner.
 *
 * Drives Claude Code in headless mode against the repo and records token usage
 * per task. Headless (not a direct API call) so the run actually exercises the
 * CLAUDE.md config and whatever MCP/CLI setup is active.
 *
 * Usage:
 *   npm run eval -- --label config__off --task 1 --reps 3
 *   npm run eval -- --label config__off            # every task not marked live_only
 *
 * Env:
 *   CLAUDE_BIN  claude binary to drive (default: `claude` on PATH). Override only
 *               when your setup wraps Claude Code, e.g. under axcli:
 *               CLAUDE_BIN=~/.axcli/bin/claude npm run eval:all
 *   EVAL_MODE        how the A/B toggle was applied; stored as `mode` in the results.
 *   EVAL_MCP_CONFIG  extra MCP config passed with --mcp-config; every server in it
 *                    must report "connected" or the run is refused.
 *
 * Each rep starts from a clean app tree (api/ web/ db/ reset via git), so OFF
 * and ON really run the same query against the same files.
 *
 * Grading is manual/binary: each rep stores the agent's final text and the diff
 * it produced in results/<label>.runs/, so you can check it before trusting the
 * tokens.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const APP_DIRS = ["api", "web", "db"].filter((d) => existsSync(join(ROOT, d)));

const CLAUDE_BIN = (process.env.CLAUDE_BIN || "claude").replace(/^~(?=\/)/, homedir());
const MCP_CONFIG = process.env.EVAL_MCP_CONFIG || "";

// steps: a multi-turn conversation — each step is sent as the next user message
// in the same session (`--resume <session_id>`); usage is summed over all steps.
// allow: extra tools pre-approved for this task only (headless runs deny Bash
// commands that aren't allowlisted), e.g. allow: Bash(psql:*), Bash(git diff:*)
type Task = { id: number; prompt: string; grade: string; live_only?: boolean; steps?: string[]; allow?: string[] };

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Tiny YAML reader for our simple tasks.yaml (no external deps). */
function loadTasks(): Task[] {
  const text = readFileSync(join(__dirname, "tasks.yaml"), "utf8");
  const tasks: Task[] = [];
  let cur: Partial<Task> | null = null;
  let key: "prompt" | "grade" | "steps" | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (cur && key === "steps") {
      if (buf.length) (cur.steps ??= []).push(buf.join(" ").trim());
    } else if (cur && key) (cur as any)[key] = buf.join(" ").trim();
    buf = [];
    key = null;
  };
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (/^\s*#/.test(line)) continue; // comments never belong to a prompt/grade
    const idm = line.match(/^\s*-\s*id:\s*(\d+)/);
    if (idm) {
      flush();
      if (cur) tasks.push(cur as Task);
      cur = { id: Number(idm[1]) };
      continue;
    }
    // live_only (real side effects) and opt_in (special-purpose) both keep a
    // task out of the default batch; it runs only when named with --task.
    const lm = line.match(/^\s*(live_only|opt_in):\s*(true|false)\s*$/);
    if (lm && cur) {
      flush();
      if (lm[2] === "true") cur.live_only = true;
      continue;
    }
    const am = line.match(/^\s*allow:\s*(.+)$/);
    if (am && cur) {
      flush();
      cur.allow = am[1].split(/,\s*(?=[A-Za-z]+(?:\(|$|,))/).map((x) => x.trim()).filter(Boolean);
      continue;
    }
    if (cur && /^\s*steps:\s*$/.test(line)) {
      flush();
      key = "steps";
      cur.steps = [];
      continue;
    }
    const sm = key === "steps" ? line.match(/^\s*-\s+(.*)$/) : null;
    if (sm && cur) {
      // next step: close the previous one, stay in the steps list
      if (buf.length) cur.steps!.push(buf.join(" ").trim());
      buf = [sm[1].trim()];
      continue;
    }
    const pm = line.match(/^\s*(prompt|grade):\s*(.*)$/);
    if (pm && cur) {
      flush();
      key = pm[1] as "prompt" | "grade";
      const inline = pm[2].replace(/^[>|]\s*$/, "").trim();
      if (inline && inline !== ">" && inline !== "|") buf.push(inline);
      continue;
    }
    if (key && /^\s+/.test(line) && line.trim()) buf.push(line.trim());
  }
  flush();
  if (cur) tasks.push(cur as Task);
  for (const t of tasks) if (!t.prompt && t.steps?.length) t.prompt = t.steps.join(" → ");
  return tasks.filter((t) => t.prompt);
}

type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  total_tokens: number;
  cost_usd: number;
  num_turns: number;
};

function git(args: string[]) {
  return spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
}

/** Put the app tree back to the committed state so every rep starts identical. */
function resetAppTree() {
  if (APP_DIRS.length === 0) return;
  const co = git(["checkout", "--", ...APP_DIRS]);
  const cl = git(["clean", "-fdq", "--", ...APP_DIRS]);
  if (co.status !== 0 || cl.status !== 0) {
    throw new Error(`could not reset app tree: ${co.stderr}${cl.stderr}`);
  }
}

function appDiff(): string {
  if (APP_DIRS.length === 0) return "";
  git(["add", "-N", "--", ...APP_DIRS]); // so new files show up in the diff
  const d = git(["diff", "--", ...APP_DIRS]).stdout;
  git(["reset", "-q", "--", ...APP_DIRS]);
  return d;
}

/**
 * `--output-format json` is a single result object on some setups and an array
 * of stream events (system/assistant/result) on others — accept both.
 */
function resultEvent(stdout: string): any {
  const parsed = JSON.parse(stdout);
  const events = Array.isArray(parsed) ? parsed : [parsed];
  const result = [...events].reverse().find((e) => e && e.type === "result");
  if (!result) throw new Error("no result event in claude output");
  return result;
}

/** One `claude -p` call (optionally continuing a session); returns its result event. */
function claudeCall(prompt: string, resume?: string, allow: string[] = []): any {
  const res = spawnSync(
    CLAUDE_BIN,
    [
      "-p", prompt,
      ...(resume ? ["--resume", resume] : []),
      "--output-format", "json",
      "--model", "sonnet",
      // Headless runs deny edits by default; the tasks need to edit files.
      "--permission-mode", "acceptEdits",
      ...(allow.length ? ["--allowedTools", ...allow] : []),
      // Extra MCP servers for the CLI-vs-MCP control side (see run-all.sh).
      ...(MCP_CONFIG ? ["--mcp-config", MCP_CONFIG] : []),
    ],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }
  );
  if (!res.stdout) {
    throw new Error(`claude exited ${res.status} with no output: ${res.stderr}`);
  }
  const r = resultEvent(res.stdout);
  if (MCP_CONFIG) {
    // A server that never connects adds no tools — the "MCP on" side would
    // silently equal "MCP off". Refuse the run instead.
    const wanted = Object.keys(JSON.parse(readFileSync(MCP_CONFIG, "utf8")).mcpServers ?? {});
    const events = [].concat(JSON.parse(res.stdout));
    const init: any = events.find((e: any) => e && e.type === "system" && e.subtype === "init");
    const status = new Map((init?.mcp_servers ?? []).map((s: any) => [s.name, s.status]));
    const bad = wanted.filter((n) => status.get(n) !== "connected");
    if (bad.length) {
      throw new Error(`MCP servers not connected: ${bad.map((n) => `${n}=${status.get(n) ?? "missing"}`).join(", ")}`);
    }
  }
  if (r.is_error) {
    // Refuse to record an errored run — that's how zeros sneak into a scoreboard.
    throw new Error(`claude returned an error: ${String(r.result ?? r.subtype).slice(0, 300)}`);
  }
  return r;
}

/**
 * Run one task; returns usage plus what the agent produced. A `steps` task is a
 * conversation: step 1 starts a session, every later step resumes it, and the
 * usage of all calls is summed (each call reports only its own usage).
 */
function runTask(task: Task): { usage: Usage; text: string; diff: string } {
  resetAppTree();
  const prompts = task.steps?.length ? task.steps : [task.prompt];
  let session: string | undefined;
  let input = 0, output = 0, cacheRead = 0, cacheCreate = 0, cost = 0, turns = 0;
  const texts: string[] = [];
  prompts.forEach((p, i) => {
    const r = claudeCall(p, session, task.allow);
    if (prompts.length > 1) {
      if (!r.session_id) throw new Error("no session_id in claude output — can't continue the conversation");
      if (session && r.session_id !== session) {
        // --resume may fork to a new id on some versions; follow it.
        process.stdout.write(`    (session ${session} → ${r.session_id})\n`);
      }
      session = r.session_id;
    }
    const u = r.usage ?? {};
    input += u.input_tokens ?? 0;
    output += u.output_tokens ?? 0;
    cacheRead += u.cache_read_input_tokens ?? 0;
    cacheCreate += u.cache_creation_input_tokens ?? 0;
    cost += r.total_cost_usd ?? 0;
    turns += r.num_turns ?? 0;
    texts.push(prompts.length > 1 ? `### Step ${i + 1}: ${p}\n\n${String(r.result ?? "")}` : String(r.result ?? ""));
  });
  if (input + output + cacheRead + cacheCreate === 0) {
    throw new Error("claude reported zero usage — refusing to record it");
  }
  const diff = appDiff();
  resetAppTree();
  return {
    usage: {
      input_tokens: input,
      output_tokens: output,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: cacheCreate,
      // Same prefix counts as cache_creation on a cold run and cache_read on a
      // warm one, so the sum is (roughly) independent of run order.
      total_tokens: input + output + cacheRead + cacheCreate,
      cost_usd: cost,
      num_turns: turns,
    },
    text: texts.join("\n\n"),
    diff,
  };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

function main() {
  const label = arg("label") ?? "run";
  const only = arg("task");
  const reps = Math.max(1, Number(arg("reps") ?? process.env.EVAL_REPS ?? 3));
  const all = loadTasks();
  if (process.argv.includes("--list")) {
    // print what the parser read — check a new task before spending a run on it
    console.log(JSON.stringify(all, null, 2));
    return;
  }
  const tasks = only
    ? all.filter((t) => String(t.id) === only)
    : all.filter((t) => !t.live_only);
  if (tasks.length === 0) {
    console.error(`no tasks matched --task ${only}`);
    process.exit(1);
  }

  const resultsDir = join(ROOT, "results");
  const runsDir = join(resultsDir, `${label}.runs`);
  mkdirSync(runsDir, { recursive: true });
  const outPath = join(resultsDir, `${label}.json`);
  let rows: any[] = [];
  if (only && existsSync(outPath)) {
    const prev = JSON.parse(readFileSync(outPath, "utf8"));
    if (!prev.note) rows = prev.rows ?? []; // keep earlier real rows, drop placeholders
  }

  console.log(`claude: ${CLAUDE_BIN}   reps: ${reps}`);
  for (const task of tasks) {
    process.stdout.write(`\n▶ [${label}] task ${task.id}: ${task.prompt}\n`);
    const runs: Usage[] = [];
    for (let i = 1; i <= reps; i++) {
      const { usage, text, diff } = runTask(task);
      runs.push(usage);
      writeFileSync(
        join(runsDir, `task${task.id}-rep${i}.md`),
        `# ${label} task ${task.id} rep ${i}\n\nGrade: ${task.grade}\n\n## Agent result\n\n${text}\n\n## Diff\n\n\`\`\`diff\n${diff}\`\`\`\n\n## Usage\n\n\`\`\`json\n${JSON.stringify(usage, null, 2)}\n\`\`\`\n`
      );
      console.log(
        `  rep ${i}: in=${usage.input_tokens} out=${usage.output_tokens} cache_read=${usage.cache_read_input_tokens} cache_create=${usage.cache_creation_input_tokens} total=${usage.total_tokens} turns=${usage.num_turns} $${usage.cost_usd.toFixed(4)}`
      );
    }
    const totals = runs.map((r) => r.total_tokens);
    const row = {
      task: task.id,
      reps: runs.length,
      median_total_tokens: median(totals),
      min_total_tokens: Math.min(...totals),
      max_total_tokens: Math.max(...totals),
      median_output_tokens: median(runs.map((r) => r.output_tokens)),
      median_cost_usd: median(runs.map((r) => Math.round(r.cost_usd * 1e6))) / 1e6,
      runs,
    };
    const idx = rows.findIndex((r) => r.task === task.id);
    if (idx >= 0) rows[idx] = row;
    else rows.push(row);
    console.log(
      `  median total=${row.median_total_tokens} (range ${row.min_total_tokens}–${row.max_total_tokens})`
    );
    console.log(`  grade (check ${runsDir}): ${task.grade}`);
  }

  rows.sort((a, b) => a.task - b.task);
  const totals = {
    total_tokens: rows.reduce((a, r) => a + r.median_total_tokens, 0),
    min_total_tokens: rows.reduce((a, r) => a + r.min_total_tokens, 0),
    max_total_tokens: rows.reduce((a, r) => a + r.max_total_tokens, 0),
    output_tokens: rows.reduce((a, r) => a + r.median_output_tokens, 0),
    cost_usd: rows.reduce((a, r) => a + r.median_cost_usd, 0),
  };
  writeFileSync(
    outPath,
    JSON.stringify(
      // mode: how the A/B toggle was applied (set by run-all.sh via EVAL_MODE), so
      // the deck can say what was actually measured. Not `note` — that marks placeholders.
      { label, mode: process.env.EVAL_MODE || undefined, recorded_at: new Date().toISOString(), rows, totals },
      null,
      2
    ) + "\n"
  );
  console.log(`\nwrote ${outPath}  (sum of per-task medians: ${totals.total_tokens} tokens)`);
}

main();
