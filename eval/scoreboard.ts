#!/usr/bin/env node
/**
 * Scoreboard: per-optimization A/B. For each optimization we run the SAME query
 * with it OFF and with it ON, and report the difference. Nothing is cumulative —
 * each row isolates one optimization against its own matched control.
 *
 * Reads results/<opt>__off.json and results/<opt>__on.json for each optimization.
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(__dirname, "..", "results");

const OPTS: [string, string][] = [
  ["headroom", "Headroom"],
  ["headroom_long", "Headroom long"],
  ["headroom_chain", "Headroom chat"],
  ["caveman", "Caveman"],
  ["caveman_long", "Caveman long"],
  ["caveman_chain", "Caveman chat"],
  ["config", "Config"],
  ["cli", "CLI vs MCP"],
];

function pad(s: string | number, n: number) {
  return String(s).padEnd(n);
}
type Side = { total: number; min: number; max: number; reps: number; tasks: string; empty: boolean };

function load(label: string): Side {
  const none = { total: 0, min: 0, max: 0, reps: 0, tasks: "", empty: true };
  const f = join(RESULTS, `${label}.json`);
  if (!existsSync(f)) return none;
  const d = JSON.parse(readFileSync(f, "utf8"));
  if (d.note || !d.rows || d.rows.length === 0 || !d.totals || !d.totals.total_tokens) return none;
  return {
    total: d.totals.total_tokens,
    min: d.totals.min_total_tokens ?? d.totals.total_tokens,
    max: d.totals.max_total_tokens ?? d.totals.total_tokens,
    reps: Math.min(...d.rows.map((r: any) => r.reps ?? 1)),
    tasks: d.rows.map((r: any) => r.task).join(","),
    empty: false,
  };
}

function main() {
  console.log("");
  console.log("Same query, measured OFF vs ON — one isolated A/B per optimization.\n");
  console.log("Totals are sums of per-task medians; [min–max] across reps.\n");
  console.log(
    pad("Optimization", 14) + pad("OFF", 26) + pad("ON", 26) + pad("Saved", 10) + pad("%", 6) + "Note"
  );
  console.log("-".repeat(100));
  let any = false;
  for (const [key, name] of OPTS) {
    const off = load(`${key}__off`);
    const on = load(`${key}__on`);
    if (off.empty || on.empty) {
      console.log(pad(name, 14) + pad("—", 26) + pad("—", 26) + pad("—", 10) + pad("—", 6));
      continue;
    }
    if (off.tasks !== on.tasks) {
      console.log(pad(name, 14) + `not comparable: OFF covers tasks [${off.tasks}], ON covers [${on.tasks}]`);
      continue;
    }
    any = true;
    const saved = off.total - on.total;
    const pct = off.total > 0 ? `${Math.round((saved / off.total) * 100)}%` : "—";
    const overlap = on.max >= off.min && off.max >= on.min;
    const notes = [`n=${Math.min(off.reps, on.reps)}`];
    if (overlap) notes.push("ranges overlap: within noise");
    const cell = (s: Side) => `${s.total} [${s.min}–${s.max}]`;
    console.log(
      pad(name, 14) + pad(cell(off), 26) + pad(cell(on), 26) + pad(saved, 10) + pad(pct, 6) + notes.join(", ")
    );
  }
  console.log("");
  if (!any) {
    console.log("No A/B pairs recorded yet. Run:  npm run eval:all");
    console.log("(each optimization needs both <opt>__off and <opt>__on)\n");
  }
}

main();
