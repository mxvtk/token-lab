// Prints every recorded A/B pair (read-only). Usage: node scripts/results-summary.mjs
// Reads $RESULTS_DIR, else results/local/ (your runs) if it has any, else results/ (baseline).
import { readFileSync, existsSync, readdirSync } from "node:fs";
const DIR = process.env.RESULTS_DIR
  || (existsSync("results/local") && readdirSync("results/local").some((f) => f.endsWith(".json")) ? "results/local" : "results");
console.log(`reading ${DIR}/`);
const keys = ["headroom", "headroom_long", "headroom_chain", "caveman", "caveman_long", "caveman_chain", "config", "cli"];
const med = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
let spent = 0;
for (const k of keys) {
  const out = [k];
  for (const side of ["off", "on"]) {
    const f = `${DIR}/${k}__${side}.json`;
    if (!existsSync(f)) { out.push(`${side}: missing`); continue; }
    const d = JSON.parse(readFileSync(f, "utf8"));
    const r = d.rows[0], runs = r.runs;
    const c = runs.reduce((a, x) => a + x.cost_usd, 0);
    spent += c;
    out.push(`${side}: task=${r.task} n=${r.reps} total=${r.median_total_tokens} [${r.min_total_tokens}-${r.max_total_tokens}] out=${med(runs.map((x) => x.output_tokens))} cache_read=${med(runs.map((x) => x.cache_read_input_tokens))} turns=${med(runs.map((x) => x.num_turns))} median_cost=$${d.totals.cost_usd.toFixed(3)} spent=$${c.toFixed(2)} mode=${d.mode} claude=${d.claude_version ?? "?"} at=${d.recorded_at.slice(0, 16)}Z`);
  }
  console.log(out.join("\n   "));
}
console.log(`spent across all recorded runs: $${spent.toFixed(2)}`);
