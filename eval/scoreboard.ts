#!/usr/bin/env node
/**
 * Scoreboard: per-optimization A/B. For each optimization we run the SAME query
 * with it OFF and with it ON, and report the difference. Nothing is cumulative —
 * each row isolates one optimization against its own matched control.
 *
 * Reads <dir>/<opt>__off.json and <dir>/<opt>__on.json for each optimization, where
 * <dir> is $RESULTS_DIR, else results/local/ (your runs) if it has any, else
 * results/ (the facilitator's baseline).
 *
 * Each row gets a verdict:
 *   ▼ saves     ON used fewer tokens and the OFF/ON ranges don't overlap
 *   ▲ overhead  ON used more tokens and the ranges don't overlap
 *   ≈ noise     the ranges overlap, so the difference isn't measurable at this n
 *   ? unclear   fewer than 2 reps on a side: no range, so noise can't be judged
 * Colour only on a terminal (NO_COLOR turns it off, FORCE_COLOR turns it on).
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, relative } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const LOCAL = join(ROOT, "results", "local");
const RESULTS = process.env.RESULTS_DIR
  ? resolve(ROOT, process.env.RESULTS_DIR)
  : existsSync(LOCAL) && readdirSync(LOCAL).some((f) => f.endsWith(".json"))
    ? LOCAL
    : join(ROOT, "results");

const OPTS: [string, string][] = [
  ["headroom", "Headroom"],
  ["headroom_long", "Headroom long"],
  ["headroom_chain", "Headroom chat"],
  ["caveman", "Caveman"],
  ["caveman_long", "Caveman long"],
  ["caveman_chain", "Caveman chat"],
  ["config", "Config"],
  ["cli", "CLI vs MCP"],
  ["cli_long", "CLI vs MCP long"],
  ["cli_chain", "CLI vs MCP chat"],
];

const COLOR = process.env.FORCE_COLOR ? true : !process.env.NO_COLOR && !!process.stdout.isTTY;
const paint = (code: string) => (s: string) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = paint("32"), red = paint("31"), yellow = paint("33"), dim = paint("2"), bold = paint("1");

const n = (x: number) => x.toLocaleString("en-US");
const signed = (x: number) => (x > 0 ? "+" : x < 0 ? "−" : "±") + n(Math.abs(x));
const pad = (s: string, w: number) => s.padEnd(w);
const lpad = (s: string, w: number) => s.padStart(w);

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

type Verdict = "saves" | "overhead" | "noise" | "unclear";
const W = { name: 17, side: 28, delta: 18 };

function main() {
  const rel = relative(ROOT, RESULTS);
  const where = rel.startsWith("..") ? RESULTS : rel;
  const whose = RESULTS === LOCAL ? "your runs" : RESULTS === join(ROOT, "results") ? "facilitator baseline" : "";
  console.log("");
  console.log(bold(`Scoreboard — ${where}/`) + (whose ? dim(`  (${whose})`) : ""));
  console.log(dim("Same task, each optimization OFF then ON. Tokens: median per side [min–max across reps], cache reads included."));
  console.log("");
  if (OPTS.every(([key]) => load(`${key}__off`).empty || load(`${key}__on`).empty)) {
    console.log("No A/B pairs recorded yet. Run:  npm run eval:all");
    console.log(dim("(each optimization needs both <opt>__off and <opt>__on)"));
    console.log("");
    return;
  }
  console.log(
    "  " + pad("", 2) + pad("Optimization", W.name) + lpad("OFF", W.side - 2) + "  " + lpad("ON", W.side - 2) + "  " +
      lpad("ON vs OFF", W.delta) + "   Verdict"
  );
  console.log("  " + dim("─".repeat(2 + W.name + W.side * 2 + W.delta + 22)));

  const missing: string[] = [];
  const byVerdict: Record<Verdict, string[]> = { saves: [], overhead: [], noise: [], unclear: [] };
  for (const [key, name] of OPTS) {
    const off = load(`${key}__off`);
    const on = load(`${key}__on`);
    if (off.empty || on.empty) {
      missing.push(name);
      continue;
    }
    if (off.tasks !== on.tasks) {
      console.log("  " + pad("?", 2) + pad(name, W.name) + yellow(`not comparable: OFF covers tasks [${off.tasks}], ON covers [${on.tasks}]`));
      continue;
    }
    const delta = on.total - off.total; // negative = fewer tokens with it ON
    const pct = off.total > 0 ? Math.round((delta / off.total) * 100) : 0;
    const overlap = on.max >= off.min && off.max >= on.min;
    const reps = Math.min(off.reps, on.reps);
    // one rep per side = min equals max, so the ranges are points and almost
    // never overlap: any difference would look real
    const verdict: Verdict = reps < 2 ? "unclear" : overlap ? "noise" : delta < 0 ? "saves" : "overhead";
    const pctTxt = `${pct > 0 ? "+" : pct < 0 ? "−" : "±"}${Math.abs(pct)}%`;
    byVerdict[verdict].push(`${name} ${pctTxt}`);

    const cell = (s: Side) => `${n(s.total)} ${dim(`[${n(s.min)}–${n(s.max)}]`)}`;
    const cellW = (s: Side) => `${n(s.total)} [${n(s.min)}–${n(s.max)}]`.length; // visible width
    const side = (s: Side) => " ".repeat(Math.max(0, W.side - 2 - cellW(s))) + cell(s);
    const deltaTxt = lpad(`${signed(delta)}  ${lpad(pctTxt, 5)}`, W.delta);
    const bar = "█".repeat(Math.min(12, Math.round(Math.abs(pct) / 5))); // one block per 5%
    const [icon, tint, label] =
      verdict === "saves" ? ["▼", green, `saves ${n(-delta)} tokens  ${bar}`]
      : verdict === "overhead" ? ["▲", red, `overhead +${n(delta)} tokens  ${bar}`]
      : verdict === "noise" ? ["≈", yellow, "within noise (ranges overlap)"]
      : ["?", dim, "1 rep per side: can't tell from noise"];
    console.log(
      "  " + tint(pad(icon, 2)) + pad(name, W.name) + side(off) + "  " + side(on) + "  " +
        tint(deltaTxt) + "   " + tint(label) + "  " + dim(`n=${reps}`)
    );
  }

  console.log("");
  const line = (icon: string, tint: (s: string) => string, title: string, items: string[]) =>
    console.log("  " + tint(`${icon} ${pad(title, 10)}`) + (items.length ? items.join(", ") : dim("none")));
  line("▼", green, "Saves", byVerdict.saves);
  line("▲", red, "Overhead", byVerdict.overhead);
  line("≈", yellow, "Noise", byVerdict.noise);
  if (byVerdict.unclear.length) line("?", dim, "Unclear", byVerdict.unclear);
  if (missing.length) console.log("  " + dim(`· ${pad("Not run", 10)}${missing.join(", ")}`));
  console.log("");
  console.log(dim("  ▼/▲ = ON used fewer/more tokens and the OFF and ON ranges don't overlap. ≈ = they overlap: no measurable difference."));
  if (byVerdict.unclear.length) console.log(dim("  ? = only 1 rep on a side; run with 2+ reps (the default is 3) to judge noise."));
  console.log("");
}

main();
