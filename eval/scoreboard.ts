#!/usr/bin/env node
/**
 * Print the scoreboard: one row per label, totals side by side.
 * Reads every results/<label>.json. Order follows the workshop flow.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(__dirname, "..", "results");

const ORDER = ["baseline", "headroom", "caveman", "config", "cli"];

function pad(s: string | number, n: number) {
  return String(s).padEnd(n);
}

function main() {
  if (!existsSync(RESULTS)) {
    console.error("no results/ directory yet — run the eval first.");
    process.exit(1);
  }
  const files = readdirSync(RESULTS).filter((f) => f.endsWith(".json"));
  const byLabel = new Map<string, any>();
  for (const f of files) {
    const data = JSON.parse(readFileSync(join(RESULTS, f), "utf8"));
    byLabel.set(data.label, data);
  }
  const labels = [
    ...ORDER.filter((l) => byLabel.has(l)),
    ...[...byLabel.keys()].filter((l) => !ORDER.includes(l)),
  ];

  console.log("");
  console.log(
    pad("label", 12) + pad("in_tok", 10) + pad("out_tok", 10) + pad("total", 10) + "vs base"
  );
  console.log("-".repeat(52));
  let base: number | null = null;
  for (const label of labels) {
    const t = byLabel.get(label).totals;
    if (base === null) base = t.total_tokens;
    const pct =
      base && base > 0 ? `${Math.round((1 - t.total_tokens / base) * 100)}%` : "-";
    console.log(
      pad(label, 12) +
        pad(t.input_tokens, 10) +
        pad(t.output_tokens, 10) +
        pad(t.total_tokens, 10) +
        pct
    );
  }
  console.log("");
}

main();
