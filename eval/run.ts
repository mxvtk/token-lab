#!/usr/bin/env node
/**
 * token-lab eval runner.
 *
 * Drives Claude Code in headless mode against the repo and records token usage
 * per task. Headless (not a direct API call) so the run actually exercises the
 * CLAUDE.md config and whatever MCP/CLI setup is active — that's the whole point
 * of sections 4 and 5.
 *
 * Usage:
 *   npm run eval -- --label baseline --task 1   # one task (participants, live)
 *   npm run eval -- --label baseline            # full set (facilitator pre-run)
 *
 * Grading is manual/binary in the workshop: the runner prints each task's grade
 * hint and you mark pass/fail on the scoreboard. Token numbers are automatic.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

type Task = { id: number; prompt: string; grade: string };

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Tiny YAML reader for our simple tasks.yaml (no external deps). */
function loadTasks(): Task[] {
  const text = readFileSync(join(__dirname, "tasks.yaml"), "utf8");
  const tasks: Task[] = [];
  let cur: Partial<Task> | null = null;
  let key: "prompt" | "grade" | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (cur && key) (cur as any)[key] = buf.join(" ").trim();
    buf = [];
    key = null;
  };
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    const idm = line.match(/^\s*-\s*id:\s*(\d+)/);
    if (idm) {
      flush();
      if (cur) tasks.push(cur as Task);
      cur = { id: Number(idm[1]) };
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
  return tasks.filter((t) => t.prompt);
}

type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  total_tokens: number;
};

/** Run one task through `claude -p` and pull usage out of the JSON result. */
function runTask(task: Task): Usage {
  const res = spawnSync(
    "claude",
    ["-p", task.prompt, "--output-format", "json", "--model", "sonnet"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  if (res.status !== 0) {
    throw new Error(
      `claude exited ${res.status}: ${res.stderr || res.stdout}`
    );
  }
  const json = JSON.parse(res.stdout);
  // Claude Code's json output carries a usage object; shapes vary slightly by
  // version, so read defensively.
  const u = json.usage ?? json.result?.usage ?? {};
  const input = u.input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  const cache = u.cache_read_input_tokens ?? u.cache_read ?? 0;
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cache,
    total_tokens: input + output + cache,
  };
}

function main() {
  const label = arg("label") ?? "run";
  const only = arg("task");
  const all = loadTasks();
  const tasks = only ? all.filter((t) => String(t.id) === only) : all;
  if (tasks.length === 0) {
    console.error(`no tasks matched --task ${only}`);
    process.exit(1);
  }

  const resultsDir = join(ROOT, "results");
  mkdirSync(resultsDir, { recursive: true });
  const outPath = join(resultsDir, `${label}.json`);
  const existing =
    only && existsSync(outPath) ? JSON.parse(readFileSync(outPath, "utf8")) : { label, rows: [] };
  const rows: any[] = existing.rows ?? [];

  for (const task of tasks) {
    process.stdout.write(`\n▶ [${label}] task ${task.id}: ${task.prompt}\n`);
    const usage = runTask(task);
    const row = { task: task.id, ...usage };
    const idx = rows.findIndex((r) => r.task === task.id);
    if (idx >= 0) rows[idx] = row;
    else rows.push(row);
    console.log(
      `  in=${usage.input_tokens}  out=${usage.output_tokens}  cache=${usage.cache_read_input_tokens}  total=${usage.total_tokens}`
    );
    console.log(`  grade when checking: ${task.grade}`);
  }

  rows.sort((a, b) => a.task - b.task);
  const totals = rows.reduce(
    (acc, r) => ({
      input_tokens: acc.input_tokens + r.input_tokens,
      output_tokens: acc.output_tokens + r.output_tokens,
      total_tokens: acc.total_tokens + r.total_tokens,
    }),
    { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
  );
  writeFileSync(outPath, JSON.stringify({ label, rows, totals }, null, 2) + "\n");
  console.log(`\nwrote ${outPath}  (total tokens: ${totals.total_tokens})`);
}

main();
