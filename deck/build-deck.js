// Builds the monday-branded workshop deck (editable .pptx).
// Run: node build-deck.js   ->   token-spend-workshop.pptx
// The scoreboard slide auto-fills from ../results/<opt>__off.json / __on.json
// when real A/B numbers exist (run `npm run eval:all` first); otherwise shows "—".
const pptxgen = require("pptxgenjs");
const fs = require("fs");
const nodePath = require("path");

// Toggle methods proven NOT to toggle anything — never shown as a result.
// headroom-axcli-mcp: headless `claude -p` sessions get no axcli compression, so OFF = ON
// (verified 2026-11-25).
const INVALID_MODES = new Set(["headroom-axcli-mcp"]);
// List price per MTok of the model the eval runs (`--model sonnet` resolved to
// claude-sonnet-4-6 in these runs), from platform.claude.com/docs/en/about-claude/pricing
// (checked 2026-11-25): cache read = 0.1x input; cache write at the 1-hour rate (2x
// input) — Claude Code's recorded cost_usd matches that rate to the cent on every rep
// of headroom_chain__off, not the 5-minute 1.25x rate.
// Used to price MEASURED token counts with vs without prompt caching; recorded
// cost_usd is still what every cost-change figure uses.
const PRICE = { input: 3, cacheWrite: 6, cacheRead: 0.30, output: 15 };
function loadResult(label) {
  try {
    const f = nodePath.join(__dirname, "..", "results", `${label}.json`);
    const d = JSON.parse(fs.readFileSync(f, "utf8"));
    if (d.note || !d.rows || d.rows.length === 0 || !d.totals || !d.totals.total_tokens) return null;
    if (INVALID_MODES.has(d.mode)) return null;
    return d;
  } catch { return null; }
}
// Read a real result from results/<label>.json, or null if not measured yet.
// total = sum of per-task medians; min/max = spread across reps.
function resultTotal(label) {
  const d = loadResult(label);
  if (!d) return null;
  const t = d.totals;
  return {
    total: t.total_tokens,
    min: t.min_total_tokens ?? t.total_tokens,
    max: t.max_total_tokens ?? t.total_tokens,
    reps: Math.min(...d.rows.map((r) => r.reps ?? 1)),
    tasks: d.rows.map((r) => r.task).join(","),
  };
}
// Per-run medians/shares for a single-task result (the findings slide), or null.
function runStats(label) {
  const d = loadResult(label);
  if (!d || d.rows.length !== 1 || !d.rows[0].runs?.length) return null;
  const runs = d.rows[0].runs;
  const med = (k) => { const s = runs.map((r) => r[k]).sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const sum = (k) => runs.reduce((a, r) => a + (r[k] ?? 0), 0);
  // cost_usd is trustworthy only when per step — older chat results summed a
  // cumulative session tally and overcount.
  const costOk = d.cost_accounting === "session-delta";
  // per-run values, median across reps (one outlier rep must not move the per-request arithmetic)
  const medOf = (f) => { const s = runs.map(f).sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const inSide = (r) => r.input_tokens + r.cache_read_input_tokens + r.cache_creation_input_tokens;
  const price = (r) => (r.input_tokens * PRICE.input + r.cache_read_input_tokens * PRICE.cacheRead + r.cache_creation_input_tokens * PRICE.cacheWrite + r.output_tokens * PRICE.output) / 1e6;
  const priceNoCache = (r) => (inSide(r) * PRICE.input + r.output_tokens * PRICE.output) / 1e6;
  return {
    total: d.totals.total_tokens, out: med("output_tokens"), turns: med("num_turns"), cost: med("cost_usd"), costOk,
    cacheShare: sum("cache_read_input_tokens") / sum("total_tokens"), outShare: sum("output_tokens") / sum("total_tokens"),
    // per-run medians, for per-request arithmetic in the speaker notes
    m: { input: medOf(inSide), perReq: medOf((r) => inSide(r) / r.num_turns), cacheWrite: medOf((r) => r.cache_creation_input_tokens), output: medOf((r) => r.output_tokens), turns: med("num_turns"),
      uncached: medOf((r) => r.input_tokens), cacheRead: medOf((r) => r.cache_read_input_tokens) },
    sumInSide: runs.reduce((a, r) => a + inSide(r), 0), reps: runs.length,
    // list price of the median run, with caching (as billed) and without (every input-side token at the input rate)
    caching: { withCache: medOf(price), noCache: medOf(priceNoCache), recorded: costOk ? sum("cost_usd") / runs.length : null },
  };
}
// signed % change from a to b, e.g. "−24%" / "+7%"
const chg = (a, b) => { const v = Math.round(((b - a) / a) * 100); return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v)}%`; };
// Returns display strings — real numbers or "—". `noise` = OFF and ON ranges overlap,
// so the difference isn't distinguishable from run-to-run variance.
function abRow(key) {
  const off = resultTotal(`${key}__off`), on = resultTotal(`${key}__on`);
  if (off == null || on == null || off.tasks !== on.tasks) return { off: "—", on: "—", saved: "—", pct: "—", noise: false, meta: null };
  const saved = off.total - on.total;
  const noise = on.max >= off.min && off.max >= on.min;
  return {
    off: off.total.toLocaleString(), on: on.total.toLocaleString(),
    saved: `${saved.toLocaleString()} (${Math.round((saved / off.total) * 100)}%)${noise ? "*" : ""}`,
    pct: `${Math.round((saved / off.total) * 100)}%`, noise, win: saved > 0 && !noise,
    meta: { reps: Math.min(off.reps, on.reps), tasks: off.tasks },
  };
}

// ---- monday brand tokens ----
const BG = "0B0B12";          // near-black
const BG2 = "15162A";         // deep indigo panel
const CARD = "1C1E36";        // card surface
const WHITE = "FFFFFF";
const MUTE = "A8A9C0";        // muted lavender-grey
const PURPLE = "6164FF";
const PURPLE_L = "8A99FF";
const GREEN = "00C875";
const YELLOW = "FFCB00";
const RED = "FF3D57";
const HEAD = "Poppins";
const BODY = "Poppins";

const p = new pptxgen();
p.defineLayout({ name: "W", width: 13.333, height: 7.5 });
p.layout = "W";
p.author = "M";
p.title = "Minimizing LLM Token Spend";

const W = 13.333, H = 7.5, M = 0.7;

function bg(s, color) { s.background = { color: color || BG }; }

// three monday dots motif
function dots(s, x, y, r) {
  r = r || 0.12;
  const cols = [PURPLE, YELLOW, GREEN, RED];
  cols.forEach((c, i) => s.addShape(p.ShapeType.ellipse, {
    x: x + i * (r * 2 + 0.1), y, w: r * 2, h: r * 2, fill: { color: c }, line: { type: "none" }
  }));
}

function wordmark(s, x, y) {
  s.addText("monday.com", { x, y, w: 2.2, h: 0.3, fontFace: HEAD, fontSize: 11, color: MUTE, bold: true, align: "right", isTextBox: true, margin: 0 });
}

function eyebrow(s, text, color) {
  s.addText(text, { x: M, y: 0.62, w: 8, h: 0.35, fontFace: HEAD, fontSize: 12, color: color || PURPLE_L, bold: true, charSpacing: 2, isTextBox: true, margin: 0 });
}

function title(s, text, w) {
  s.addText(text, { x: M, y: 1.0, w: w || 11.9, h: 1.0, fontFace: HEAD, fontSize: 34, color: WHITE, bold: true, isTextBox: true, margin: 0, lineSpacingMultiple: 1.0 });
}

// numbered badge card for a lever
function leverBadge(s, x, y, n, color) {
  s.addShape(p.ShapeType.roundRect, { x, y, w: 0.9, h: 0.9, rectRadius: 0.16, fill: { color }, line: { type: "none" } });
  s.addText(String(n), { x, y, w: 0.9, h: 0.9, fontFace: HEAD, fontSize: 36, color: "0B0B12", bold: true, align: "center", valign: "middle", isTextBox: true, margin: 0 });
}

function card(s, x, y, w, h) {
  s.addShape(p.ShapeType.roundRect, { x, y, w, h, rectRadius: 0.1, fill: { color: CARD }, line: { type: "none" } });
}

// ========== S1 COVER ==========
let s = p.addSlide(); bg(s);
s.addShape(p.ShapeType.roundRect, { x: W - 4.6, y: 0, w: 5.2, h: 8.2, rectRadius: 0, fill: { color: BG2 }, line: { type: "none" }, rotate: 12 });
dots(s, M, 1.0, 0.14);
s.addText("AI Engineering Workshop  ·  ~50 min", { x: M, y: 1.75, w: 9, h: 0.4, fontFace: HEAD, fontSize: 14, color: PURPLE_L, bold: true, isTextBox: true, margin: 0 });
s.addText("Spend Less,\nShip More", { x: M, y: 2.25, w: 9, h: 2.2, fontFace: HEAD, fontSize: 60, color: WHITE, bold: true, isTextBox: true, margin: 0, lineSpacingMultiple: 0.98 });
s.addText("Minimizing LLM token spend when coding with AI agents", { x: M, y: 4.75, w: 8.6, h: 0.7, fontFace: BODY, fontSize: 18, color: MUTE, isTextBox: true, margin: 0 });
wordmark(s, W - 2.9, H - 0.7);

// ========== S1b ABOUT ME (second, as in the presented deck) ==========
const ME = nodePath.join(__dirname, "me.jpg");
s = p.addSlide(); bg(s);
s.addShape(p.ShapeType.roundRect, { x: 0, y: 0, w: 5.6, h: H, rectRadius: 0, fill: { color: BG2 }, line: { type: "none" } });
s.addImage({ path: ME, x: 1.15, y: 1.55, w: 3.3, h: 3.3, rounding: true });
dots(s, 1.15, 5.25, 0.13);
s.addText("YOUR HOST", { x: 6.2, y: 1.7, w: 6, h: 0.35, fontFace: HEAD, fontSize: 12, color: PURPLE_L, bold: true, charSpacing: 2, isTextBox: true, margin: 0 });
s.addText("Maksym Voitko", { x: 6.2, y: 2.1, w: 6.4, h: 0.9, fontFace: HEAD, fontSize: 40, color: WHITE, bold: true, isTextBox: true, margin: 0 });
s.addText("Software Engineer · monday.com", { x: 6.2, y: 3.05, w: 6.4, h: 0.5, fontFace: BODY, fontSize: 18, color: MUTE, isTextBox: true, margin: 0 });
s.addText([{ text: "Building with AI agents every day — and keeping the token bill honest.", options: {} }],
  { x: 6.2, y: 3.75, w: 6.3, h: 1.0, fontFace: BODY, fontSize: 16, color: WHITE, isTextBox: true, margin: 0, lineSpacingMultiple: 1.2 });
s.addShape(p.ShapeType.roundRect, { x: 6.2, y: 4.95, w: 2.6, h: 0.55, rectRadius: 0.1, fill: { color: CARD }, line: { color: PURPLE, width: 1.2 } });
s.addText("mxvtk.dev", { x: 6.2, y: 4.95, w: 2.6, h: 0.55, fontFace: HEAD, fontSize: 15, color: PURPLE_L, bold: true, align: "center", valign: "middle", isTextBox: true, margin: 0, hyperlink: { url: "https://mxvtk.dev" } });
wordmark(s, W - 2.9, H - 0.55);

// ========== S2 WHY ==========
s = p.addSlide(); bg(s);
eyebrow(s, "WHY IT MATTERS");
title(s, "Where your tokens go");
const w2 = (W - 2 * M - 0.5) / 2;
[["Context in", "Everything you load into the window — history, files, tool schemas — is paid for on every single turn.", PURPLE],
 ["Agent reads", "What the agent opens to do the job. Blind exploration re-reads the repo again and again.", PURPLE_L]
].forEach((c, i) => {
  const x = M + i * (w2 + 0.5);
  card(s, x, 2.3, w2, 2.9);
  s.addShape(p.ShapeType.roundRect, { x: x + 0.45, y: 2.75, w: 0.5, h: 0.5, rectRadius: 0.1, fill: { color: c[2] }, line: { type: "none" } });
  s.addText(c[0], { x: x + 1.15, y: 2.78, w: w2 - 1.5, h: 0.5, fontFace: HEAD, fontSize: 20, color: WHITE, bold: true, valign: "middle", isTextBox: true, margin: 0 });
  s.addText(c[1], { x: x + 0.45, y: 3.5, w: w2 - 0.9, h: 1.4, fontFace: BODY, fontSize: 15, color: MUTE, isTextBox: true, margin: 0, lineSpacingMultiple: 1.15 });
});
s.addText([{ text: "Goal:  ", options: { bold: true, color: WHITE } }, { text: "cut the tokens, keep the same results.", options: { color: PURPLE_L } }],
  { x: M, y: 5.7, w: 11.9, h: 0.6, fontFace: HEAD, fontSize: 20, isTextBox: true, margin: 0 });
wordmark(s, W - 2.9, H - 0.55);

// ========== S2b THE CONTEXT WINDOW IS A BOX ==========
s = p.addSlide(); bg(s);
eyebrow(s, "THE MENTAL MODEL");
title(s, "The context window is a box");
s.addText("…and the engineer is its package manager.", { x: M, y: 1.72, w: 11.9, h: 0.45, fontFace: BODY, fontSize: 18, color: MUTE, italic: true, isTextBox: true, margin: 0 });
(() => {
  const bx = M, by = 2.55, bw = W - 2 * M, bh = 1.05;
  const segs = [["system", 0.12, PURPLE, WHITE], ["tool defs", 0.17, PURPLE_L, "0B0B12"], ["CLAUDE.md", 0.12, RED, WHITE], ["skills", 0.09, YELLOW, "0B0B12"], ["conversation", 0.35, GREEN, "0B0B12"]];
  let cx = bx;
  segs.forEach(([lab, frac, col, tc]) => {
    const w = bw * frac;
    s.addShape(p.ShapeType.roundRect, { x: cx, y: by, w: w - 0.05, h: bh, rectRadius: 0.06, fill: { color: col }, line: { type: "none" } });
    s.addText(lab, { x: cx, y: by, w: w - 0.05, h: bh, fontFace: HEAD, fontSize: frac < 0.1 ? 10 : 13, color: tc, bold: true, align: "center", valign: "middle", isTextBox: true, margin: 0 });
    cx += w;
  });
  const roomW = bx + bw - cx;
  s.addShape(p.ShapeType.roundRect, { x: cx, y: by, w: roomW, h: bh, rectRadius: 0.06, fill: { color: CARD }, line: { color: MUTE, width: 1, dashType: "dash" } });
  s.addText("…room to work", { x: cx, y: by, w: roomW, h: bh, fontFace: HEAD, fontSize: 11, color: MUTE, align: "center", valign: "middle", isTextBox: true, margin: 0 });
  s.addText("0", { x: bx, y: by + bh + 0.04, w: 1, h: 0.3, fontFace: BODY, fontSize: 11, color: MUTE, isTextBox: true, margin: 0 });
  s.addText("context limit →", { x: bx + bw - 3, y: by + bh + 0.04, w: 3, h: 0.3, fontFace: BODY, fontSize: 11, color: MUTE, align: "right", isTextBox: true, margin: 0 });
})();
card(s, M, 4.6, W - 2 * M, 1.7);
s.addText([{ text: "“Don't pay for what you don't use” ", options: { bold: true, color: WHITE } }, { text: "isn't a nice-to-have — it's the whole game.", options: { color: PURPLE_L } }],
  { x: M + 0.5, y: 4.85, w: W - 2 * M - 1, h: 0.75, fontFace: HEAD, fontSize: 22, isTextBox: true, margin: 0, lineSpacingMultiple: 1.0 });
s.addText("Everything on the left competes with the work on the right. Your whole codebase doesn't fit — neither does your wiki.", { x: M + 0.5, y: 5.6, w: W - 2 * M - 1, h: 0.5, fontFace: BODY, fontSize: 14, color: MUTE, isTextBox: true, margin: 0 });
s.addText("Analogy: Daisy Hollman — Code with Claude, London 2026", { x: M, y: H - 0.55, w: 7, h: 0.3, fontFace: BODY, fontSize: 11, color: MUTE, isTextBox: true, margin: 0 });
wordmark(s, W - 2.9, H - 0.55);

// ========== S2c PACKAGING CODE vs CONTEXT ==========
s = p.addSlide(); bg(s);
eyebrow(s, "WHY IT'S DIFFERENT");
title(s, "Packaging code ≠ packaging context");
const pkgW = (W - 2 * M - 0.5) / 2;
function pkgCard(x, heading, headColor, rows, markColor, markIsCheck) {
  card(s, x, 2.4, pkgW, 3.8);
  s.addText(heading, { x: x + 0.5, y: 2.75, w: pkgW - 1, h: 0.6, fontFace: HEAD, fontSize: 22, color: headColor, bold: true, isTextBox: true, margin: 0 });
  rows.forEach((r, i) => {
    const ry = 3.6 + i * 0.78;
    s.addShape(p.ShapeType.ellipse, { x: x + 0.5, y: ry, w: 0.34, h: 0.34, fill: { color: markColor }, line: { type: "none" } });
    s.addText(markIsCheck ? "✓" : "!", { x: x + 0.5, y: ry, w: 0.34, h: 0.34, fontFace: HEAD, fontSize: 15, color: "0B0B12", bold: true, align: "center", valign: "middle", isTextBox: true, margin: 0 });
    s.addText(r, { x: x + 1.05, y: ry - 0.08, w: pkgW - 1.5, h: 0.5, fontFace: BODY, fontSize: 15.5, color: WHITE, valign: "middle", isTextBox: true, margin: 0 });
  });
}
pkgCard(M, "Packaging code", GREEN, ["Disk + RAM are roomy and scaling", "Dependencies are cheap", "“Just vendor it” is often fine"], GREEN, true);
pkgCard(M + pkgW + 0.5, "Packaging context", RED, ["Space is tiny and fixed", "Every token competes with the task", "“Just include it” is almost never fine"], RED, false);
s.addText("Analogy: Daisy Hollman — Code with Claude, London 2026", { x: M, y: H - 0.55, w: 7, h: 0.3, fontFace: BODY, fontSize: 11, color: MUTE, isTextBox: true, margin: 0 });
wordmark(s, W - 2.9, H - 0.55);

// ========== S2d SKILLS vs MCP ==========
s = p.addSlide(); bg(s);
eyebrow(s, "BUILD THE CHEAP THING");
title(s, "Skills vs. MCP");
s.addText("Already have a CLI for the thing? A skill that drives it is usually less code and fewer moving parts than standing up an MCP server.", { x: M, y: 1.95, w: 6.0, h: 1.5, fontFace: BODY, fontSize: 17, color: WHITE, isTextBox: true, margin: 0, lineSpacingMultiple: 1.2 });
s.addShape(p.ShapeType.roundRect, { x: M, y: 3.9, w: 6.0, h: 1.9, rectRadius: 0.1, fill: { color: CARD }, line: { type: "none" } });
s.addText("Reach for MCP only when:", { x: M + 0.4, y: 4.2, w: 5.2, h: 0.5, fontFace: HEAD, fontSize: 16, color: YELLOW, bold: true, isTextBox: true, margin: 0 });
s.addText("there's no CLI to drive, or you need the portability.", { x: M + 0.4, y: 4.75, w: 5.2, h: 0.9, fontFace: BODY, fontSize: 15.5, color: WHITE, isTextBox: true, margin: 0, lineSpacingMultiple: 1.2 });
const rX = M + 6.5, rW = W - M - rX;
card(s, rX, 1.95, rW, 3.85);
s.addText("Skills are just files", { x: rX + 0.5, y: 2.25, w: rW - 1, h: 0.55, fontFace: HEAD, fontSize: 20, color: WHITE, bold: true, isTextBox: true, margin: 0 });
s.addText("Description", { x: rX + 0.5, y: 3.0, w: rW - 1, h: 0.4, fontFace: HEAD, fontSize: 16, color: GREEN, bold: true, isTextBox: true, margin: 0 });
s.addText("Always loaded — cheap (a paragraph, not a line).", { x: rX + 0.5, y: 3.42, w: rW - 1, h: 0.5, fontFace: BODY, fontSize: 14.5, color: MUTE, isTextBox: true, margin: 0 });
s.addText("Full SKILL.md + assets", { x: rX + 0.5, y: 4.15, w: rW - 1, h: 0.4, fontFace: HEAD, fontSize: 16, color: PURPLE_L, bold: true, isTextBox: true, margin: 0 });
s.addText("Loaded only when invoked — you pay per use.", { x: rX + 0.5, y: 4.57, w: rW - 1, h: 0.5, fontFace: BODY, fontSize: 14.5, color: MUTE, isTextBox: true, margin: 0 });
wordmark(s, W - 2.9, H - 0.55);

// ========== S3 THE EVAL ==========
s = p.addSlide(); bg(s);
eyebrow(s, "HOW WE PROVE IT");
title(s, "Measure, don't guess");
const steps = [
  ["TS app", "React + Express + Postgres, all in Docker", PURPLE],
  ["Fixed tasks", "Small edit, long answer, long chat — same prompts every run", PURPLE_L],
  ["Tokens + answer", "Saved per run, so each one can be graded", GREEN],
  ["OFF vs ON", "Median of 3 runs per side", YELLOW],
];
const sw = (W - 2 * M - 3 * 0.4) / 4;
steps.forEach((c, i) => {
  const x = M + i * (sw + 0.4);
  card(s, x, 2.5, sw, 2.6);
  s.addText(String(i + 1), { x: x + 0.3, y: 2.75, w: 1, h: 0.7, fontFace: HEAD, fontSize: 30, color: c[2], bold: true, isTextBox: true, margin: 0 });
  s.addText(c[0], { x: x + 0.3, y: 3.5, w: sw - 0.6, h: 0.7, fontFace: HEAD, fontSize: 17, color: WHITE, bold: true, isTextBox: true, margin: 0, lineSpacingMultiple: 1.0 });
  s.addText(c[1], { x: x + 0.3, y: 4.15, w: sw - 0.6, h: 0.8, fontFace: BODY, fontSize: 12.5, color: MUTE, isTextBox: true, margin: 0, lineSpacingMultiple: 1.1 });
  if (i < 3) s.addText("→", { x: x + sw + 0.02, y: 2.5, w: 0.36, h: 2.6, fontFace: HEAD, fontSize: 20, color: MUTE, align: "center", valign: "middle", isTextBox: true, margin: 0 });
});
s.addText("One optimization at a time — and check the toggle really flipped before trusting the number.", { x: M, y: 5.6, w: 11.9, h: 0.5, fontFace: BODY, fontSize: 15, color: MUTE, isTextBox: true, margin: 0 });
wordmark(s, W - 2.9, H - 0.55);

// ========== S4 $20 PLAN ==========
s = p.addSlide(); bg(s);
eyebrow(s, "CONSTRAINT");
title(s, "Built for the $20 plan");
s.addText("The cheapest Claude plan has a 5-hour window. The whole workshop fits inside it.", { x: M, y: 1.85, w: 11.9, h: 0.5, fontFace: BODY, fontSize: 15, color: MUTE, isTextBox: true, margin: 0 });
const budget = [
  ["Sonnet, not Opus", "Opus drains the window and has a tighter weekly cap. Set it once.", PURPLE],
  ["No invented numbers", "Every figure comes from a real run; the agent's answers are saved next to it.", GREEN],
  ["~2 live runs each", "Participants only spend budget in the two hands-on sections.", YELLOW],
];
const bw = (W - 2 * M - 2 * 0.5) / 3;
budget.forEach((c, i) => {
  const x = M + i * (bw + 0.5);
  card(s, x, 2.6, bw, 2.8);
  s.addShape(p.ShapeType.ellipse, { x: x + 0.4, y: 3.0, w: 0.4, h: 0.4, fill: { color: c[2] }, line: { type: "none" } });
  s.addText(c[0], { x: x + 0.4, y: 3.55, w: bw - 0.8, h: 0.6, fontFace: HEAD, fontSize: 17, color: WHITE, bold: true, isTextBox: true, margin: 0 });
  s.addText(c[1], { x: x + 0.4, y: 4.15, w: bw - 0.8, h: 1.1, fontFace: BODY, fontSize: 13.5, color: MUTE, isTextBox: true, margin: 0, lineSpacingMultiple: 1.15 });
});
wordmark(s, W - 2.9, H - 0.55);

// ========== S5 FOUR LEVERS ==========
s = p.addSlide(); bg(s);
eyebrow(s, "THE PLAN");
title(s, "Four levers");
const levers = [
  ["1", "Headroom", "Compress tool outputs before they reach the model", "Demo", PURPLE],
  ["2", "Caveman", "Compress the model's output", "Demo", PURPLE_L],
  ["3", "Config", "Stop the agent re-learning the repo", "Hands-on", GREEN],
  ["4", "CLI over MCP", "Unload the tools you don't use", "Hands-on", YELLOW],
];
const gw = (W - 2 * M - 0.5) / 2, gh = 1.75;
levers.forEach((c, i) => {
  const x = M + (i % 2) * (gw + 0.5);
  const y = 2.3 + Math.floor(i / 2) * (gh + 0.4);
  card(s, x, y, gw, gh);
  s.addShape(p.ShapeType.roundRect, { x: x + 0.35, y: y + 0.42, w: 0.9, h: 0.9, rectRadius: 0.16, fill: { color: c[4] }, line: { type: "none" } });
  s.addText(c[0], { x: x + 0.35, y: y + 0.42, w: 0.9, h: 0.9, fontFace: HEAD, fontSize: 34, color: "0B0B12", bold: true, align: "center", valign: "middle", isTextBox: true, margin: 0 });
  s.addText(c[1], { x: x + 1.5, y: y + 0.42, w: gw - 2.7, h: 0.5, fontFace: HEAD, fontSize: 20, color: WHITE, bold: true, isTextBox: true, margin: 0 });
  s.addText(c[2], { x: x + 1.5, y: y + 0.95, w: gw - 1.8, h: 0.6, fontFace: BODY, fontSize: 13.5, color: MUTE, isTextBox: true, margin: 0, lineSpacingMultiple: 1.1 });
  s.addText(c[3], { x: x + gw - 1.25, y: y + 0.45, w: 0.95, h: 0.35, fontFace: HEAD, fontSize: 10.5, color: c[4], bold: true, align: "right", isTextBox: true, margin: 0 });
});
wordmark(s, W - 2.9, H - 0.55);

// ---- lever detail slide helper ----
const LEVERS = [];   // exported to slide-text.json (Google Slides copy)
function leverSlide(n, name, color, mode, lead, points, footer, notes) {
  LEVERS.push({ n, name, mode, lead, points, footer, notes });
  const s = p.addSlide(); bg(s);
  if (notes) s.addNotes(notes);
  leverBadge(s, M, 0.7, n, color);
  s.addText("LEVER " + n + "  ·  " + mode.toUpperCase(), { x: M + 1.15, y: 0.72, w: 8, h: 0.3, fontFace: HEAD, fontSize: 12, color: color, bold: true, charSpacing: 2, isTextBox: true, margin: 0 });
  s.addText(name, { x: M + 1.15, y: 1.0, w: 10, h: 0.7, fontFace: HEAD, fontSize: 32, color: WHITE, bold: true, isTextBox: true, margin: 0 });
  s.addText(lead, { x: M, y: 2.25, w: 11.4, h: 0.8, fontFace: BODY, fontSize: 18, color: PURPLE_L, isTextBox: true, margin: 0, lineSpacingMultiple: 1.15 });
  card(s, M, 3.35, W - 2 * M, 2.5);
  s.addText(points.map((t, i) => ({ text: t, options: { bullet: { indent: 18 }, color: WHITE, breakLine: i < points.length - 1, paraSpaceAfter: 10 } })),
    { x: M + 0.5, y: 3.65, w: W - 2 * M - 1.0, h: 1.9, fontFace: BODY, fontSize: 15.5, color: WHITE, isTextBox: true, margin: 0, lineSpacingMultiple: 1.1 });
  s.addText(footer, { x: M, y: 6.05, w: 11.9, h: 0.5, fontFace: HEAD, fontSize: 14, color: MUTE, italic: true, isTextBox: true, margin: 0 });
  wordmark(s, W - 2.9, H - 0.55);
  return s;
}

// ---- speaker notes: every figure computed from results/ (same verdict rule as the scoreboard) ----
const tok = (x) => Math.round(x).toLocaleString("en-US");
const usd2 = (x) => `$${x.toFixed(2)}`;
const pct1 = (x) => { const v = x * 100; return `${v < 10 ? v.toFixed(1) : Math.round(v)}%`; };
const times = (x) => `${Number.isInteger(x) ? x : x.toFixed(1)}×`;
// price ratios from PRICE, so "0.1×" etc. are never typed by hand
const RATE = { read: PRICE.cacheRead / PRICE.input, write: PRICE.cacheWrite / PRICE.input, outVsRead: PRICE.output / PRICE.cacheRead };
const NOT_YET = "not measured yet";
// One A/B row as a sentence, plus the stats the notes reason from. null = not measured.
function noteRow(k, name) {
  const ab = abRow(k), off = runStats(`${k}__off`), on = runStats(`${k}__on`);
  if (!ab.meta || !off || !on) return { k, name, ok: false, line: `${name}: ${NOT_YET}.` };
  const verdict = ab.meta.reps < 2 ? "unclear, 1 rep" : ab.noise ? "within noise" : on.total < off.total ? "saves" : "overhead";
  // extra input-side tokens per model request: only meaningful when both sides made the same number of requests
  // per-request figures are per-run medians of input/turns, so a small turn gap (19 vs 20) still compares;
  // a large one (4 vs 6) mixes different requests and is left out
  const sameTurns = Math.abs(on.m.turns - off.m.turns) / Math.max(on.m.turns, off.m.turns) <= 0.1;
  const perReq = sameTurns ? on.m.perReq - off.m.perReq : null;
  const line = `${name}: ${off.total.toLocaleString()} → ${on.total.toLocaleString()} tokens (${chg(off.total, on.total)}, ${verdict}), `
    + `turns ${off.turns} → ${on.turns}, ${usd2(off.caching.withCache)} → ${usd2(on.caching.withCache)} at list price (${chg(off.caching.withCache, on.caching.withCache)}).`;
  return { k, name, ok: true, ab, off, on, verdict, perReq, line };
}
const signedTok = (x) => `${x >= 0 ? "+" : "−"}${tok(Math.abs(x))}`;
const measuredHead = (rows) => {
  const ok = rows.find((r) => r.ok);
  return `MEASURED (facilitator run, Sonnet, n=${ok ? ok.ab.meta.reps : "—"} per side; tokens = median, $ = measured tokens at list price):\n`
    + rows.map((r) => `• ${r.line}`).join("\n");
};
// The reference long chat (task 7): its OFF side shows how big a request gets late in a session.
const CHAT = ["cli_chain", "headroom_chain", "caveman_chain"].map((k) => runStats(`${k}__off`)).find(Boolean);
// (the findings card "Long chats live on the prompt cache" reads the same CHAT, so both quote one run)
// one lever's own long chat (OFF side), so each note quotes the run it reports
const chatLine = (key) => {
  const c = runStats(`${key}__off`);
  return c
    ? `This lever's 6-message chat (OFF side, median run) made ~${Math.round(c.m.turns)} model requests; each carried ~${tok(c.m.perReq)} input tokens on average, and ${pct1(c.cacheShare)} of all its tokens were cache reads.`
    : "The long-chat rows are not measured yet.";
};
const COMPOUND_RULE = `Rule of thumb: anything added to every request costs (tokens × requests) and grows with the chat; anything that removes a request saves that request's whole context, which is largest late in a chat. Cache reads bill at ${times(RATE.read)} input, cache writes at ${times(RATE.write)}.`;

const NOTES = {};
{
  const rows = [noteRow("headroom", "Edit (task 1)"), noteRow("headroom_long", "Review (task 6)"), noteRow("headroom_chain", "Chat (task 7)")];
  const [edit, , chat] = rows;
  const why = [];
  if (edit.ok && edit.on.turns > edit.off.turns) why.push(`On the edit, ON took ${edit.off.turns} → ${edit.on.turns} turns; every extra turn re-reads the whole context, which outweighed what compression saved. The result files don't record tool calls, so which step repeated isn't measured.`);
  if (chat.ok) why.push(`In the chat, cache writes went ${tok(chat.off.m.cacheWrite)} → ${tok(chat.on.m.cacheWrite)} per run while tokens went ${chg(chat.off.total, chat.on.total)}${chat.ab.noise ? " (within noise)" : ""}. That fits earlier messages changing between requests: the cached prefix is then written again at ${times(RATE.write)} input instead of read at ${times(RATE.read)}.`);
  NOTES.headroom = [
    "WHAT IT DOES: a local proxy between Claude Code and the API that rewrites tool results, logs and JSON into shorter forms before the model sees them.",
    measuredHead(rows),
    "WHY IT DOES OR DOESN'T WORK: " + (why.join(" ") || NOT_YET + "."),
    "DOES IT COMPOUND AS CONVERSATIONS GROW? Only if the compressed context stays byte-stable. Then the smaller context is re-read more cheaply on every later request, and the saving grows with the chat. If it rewrites turns the model already saw, each rewrite re-buys the cache, and that grows with the chat too, against you. "
      + (chat.ok ? `Our chat: tokens ${chg(chat.off.total, chat.on.total)}, list price ${chg(chat.off.caching.withCache, chat.on.caching.withCache)}.` : ""),
    `TAKEAWAY: ${rows.some((r) => r.ok && r.ab.win) ? "it saved on some rows here" : "not a win on this repo"}. Try it on log- or JSON-heavy sessions and judge it on cost, not on token count.`,
    chatLine("headroom_chain"),
  ].join("\n\n");
}
{
  const rows = [noteRow("caveman", "Edit (task 1)"), noteRow("caveman_long", "Review (task 6)"), noteRow("caveman_chain", "Chat (task 7)")];
  const [edit, , chat] = rows;
  const outs = rows.filter((r) => r.ok).map((r) => `${r.name.split(" ")[0].toLowerCase()} ${chg(r.off.out, r.on.out)}`).join(", ");
  const why = rows.some((r) => r.ok)
    ? `Output ${rows.filter((r) => r.ok).every((r) => r.on.out < r.off.out) ? "fell on every row" : "changed"} (${outs}), but output is a small slice of the bill: ${edit.ok ? `${pct1(edit.off.outShare)} of the edit's tokens` : ""}${edit.ok && chat.ok ? ", " : ""}${chat.ok ? `${pct1(chat.off.outShare)} of the chat's` : ""}. `
      + (edit.ok && edit.perReq != null ? `With it ON, requests carried more input — the ruleset rides along on every one: ${signedTok(edit.perReq)} input tokens per request on the edit` : "")
      + (chat.ok && chat.perReq != null ? `, ${signedTok(chat.perReq)} on the chat` : "") + "."
    : NOT_YET + ".";
  const compound = chat.ok && chat.perReq != null
    ? `No, not in tokens. The ruleset is paid on every request; the saving is paid once per answer. Over the ~${Math.round(chat.on.m.turns)}-request chat that is ${signedTok(chat.perReq * chat.on.m.turns)} input tokens against ${tok(chat.off.m.output - chat.on.m.output)} output tokens saved, and the gap widens with every message. In dollars ${Math.abs(chat.on.caching.withCache / chat.off.caching.withCache - 1) <= 0.05 ? "it roughly cancels" : chat.on.caching.withCache < chat.off.caching.withCache ? "it comes out ahead" : "it still loses"}, because an output token costs ${times(RATE.outVsRead)} a cache read: ${usd2(chat.off.caching.withCache)} → ${usd2(chat.on.caching.withCache)} per chat (${chg(chat.off.caching.withCache, chat.on.caching.withCache)}).`
    : NOT_YET + ".";
  NOTES.caveman = [
    "WHAT IT DOES: a plugin whose hook adds a ruleset telling the model to answer tersely.",
    measuredHead(rows),
    "WHY IT DOES OR DOESN'T WORK: " + why,
    "DOES IT COMPOUND AS CONVERSATIONS GROW? " + compound,
    "TAKEAWAY: shorter answers, not a smaller bill. Use it if your team likes reading terse output.",
    chatLine("caveman_chain"),
  ].join("\n\n");
}
{
  const r = noteRow("config", "Edit (task 1)");
  const why = r.ok
    ? `One fewer turn (${r.off.turns} → ${r.on.turns}): CLAUDE.md told the agent where things are, so it skipped a step of looking around. The result files don't record tool calls, so which step was skipped isn't measured. The config itself costs little: cache writes ${signedTok(r.on.m.cacheWrite - r.off.m.cacheWrite)} tokens per run.`
    : NOT_YET + ".";
  const compound = r.ok
    ? `Yes. Its cost is a small fixed prefix, cached and re-read at ${times(RATE.read)} input. Its saving is skipped requests, and a skipped request saves that request's whole context: ~${tok(r.off.m.perReq)} tokens per request on this edit. In a chat the context only grows until it is compacted, so the same skipped step is worth more the later it happens (per-request sizes aren't recorded, so how much more isn't measured). The Config chat row isn't measured yet.`
    : NOT_YET + ".";
  NOTES.config = [
    "WHAT IT DOES: a lean CLAUDE.md (commands, conventions, where things live) plus permissions.deny for generated output, fixtures and lockfiles. Claude Code does not read .claudeignore.",
    measuredHead([r]),
    "CAVEATS: task 1 only. That ON side was CLAUDE.md alone; today's ON side adds permissions.deny, not measured yet. A second run on another machine found Config within noise on tasks 1–4.",
    "WHY IT DOES OR DOESN'T WORK: " + why,
    "DOES IT COMPOUND AS CONVERSATIONS GROW? " + compound,
    "TAKEAWAY: do this first, it costs minutes. Then measure it on your own repo.",
    COMPOUND_RULE,
  ].join("\n\n");
}
{
  const rows = [noteRow("cli", "Edit (task 1)"), noteRow("cli_long", "Review (task 6)"), noteRow("cli_chain", "Chat (task 7)")];
  const per = rows.filter((r) => r.ok && r.perReq != null);
  const chat = rows[2];
  // OFF = MCP loaded, ON = CLI; so MCP's cost per request = OFF − ON
  const mcpPerReq = (r) => -r.perReq;
  const allNoise = rows.every((r) => r.ok && r.verdict === "within noise");
  const share = (r) => Math.abs(r.perReq) / r.off.m.perReq;
  const why = per.length
    ? `Current Claude Code defers MCP tool schemas (ToolSearch): only tool names sit in the prompt, and a full schema loads only when the agent asks for it. With both servers loaded, input per request changed by ${per.map((r) => `${signedTok(mcpPerReq(r))} on the ${r.name.split(" ")[0].toLowerCase()}`).join(", ")} (median per run), at most ${pct1(Math.max(...per.map(share)))} of a request. That is not thousands of schema tokens, and it is smaller than the rep-to-rep spread, so the sign isn't meaningful.`
    : NOT_YET + ".";
  const compound = chat.ok && chat.perReq != null
    ? `Barely, on this setup. The tool list is part of every request's prefix, so whatever it costs is paid (tokens × requests), read from cache at ${times(RATE.read)} input. Scaled over the ~${Math.round(chat.off.m.turns)}-request chat, the measured per-request difference comes to ${signedTok(mcpPerReq(chat) * chat.off.m.turns)} tokens, inside the noise: there is no per-request overhead here large enough to compound. What does grow fast is tool output: every result stays in the context and is re-read on every later request, so a verbose tool call early in a chat is paid ~${Math.round(chat.off.m.turns)} times. A client that doesn't defer schemas pays the full schemas on every request instead; that case isn't measured here.`
    : `Yes, linearly: the tool list is part of every request's prefix, so it costs (tokens × requests). The chat row is ${NOT_YET}.`;
  const takeaway = allNoise
    ? "TAKEAWAY: on current Claude Code an idle MCP server is cheap; MCP vs CLI was within noise on all three tasks. Pick by what returns smaller results: trimmed gh/psql output or a lean MCP tool. Unload servers you don't use."
    : "TAKEAWAY: measure it on your repo; the rows above aren't all within noise.";
  NOTES.cli = [
    "WHAT IT DOES: OFF = only the GitHub and Postgres MCP servers loaded (--strict-mcp-config, so nobody's own servers leak in). ON = no MCP servers; the agent uses gh and psql through Bash.",
    measuredHead(rows),
    "WHY IT DOES OR DOESN'T WORK: " + why,
    "DOES IT COMPOUND AS CONVERSATIONS GROW? " + compound,
    takeaway,
    COMPOUND_RULE,
  ].join("\n\n");
}

// ---- per-lever detail slides: OFF → ON per task, every cell computed from results/ ----
// Headroom's own counters, from results/<label>.headroom-metrics.txt (Prometheus text, a
// /metrics snapshot before and after the run). The counters are cumulative across runs,
// so each figure is after − before. null when the file is missing.
function proxyMetrics(label) {
  try {
    const t = fs.readFileSync(nodePath.join(__dirname, "..", "results", `${label}.headroom-metrics.txt`), "utf8");
    const [before, after] = t.split("# /metrics after");
    if (after == null) return null;
    const val = (s, name) => { const m = s.match(new RegExp(`^${name} ([\\d.e+]+)$`, "m")); return m ? Number(m[1]) : 0; };
    const d = (name) => val(after, name) - val(before, name);
    return { requests: d("headroom_requests_total"), input: d("headroom_tokens_input_total"), saved: d("headroom_tokens_saved_total"),
      busts: d("headroom_cache_bust_total"), bustLost: d("headroom_cache_bust_tokens_lost_total") };
  } catch { return null; }
}
const DETAILS = [];
const DETAIL_TASKS = [["", "Edit (task 1)"], ["_long", "Review (task 6)"], ["_chain", "Chat (task 7)"]];
const arrow = (a, b, f) => `${f(a)} → ${f(b)} (${a ? chg(a, b) : "—"})`;
function detailRows(key) {
  const rows = DETAIL_TASKS.map(([sfx, name]) => noteRow(key + sfx, name));
  const col = (fn) => rows.map((r) => (r.ok ? fn(r) : "—"));
  return {
    rows,
    header: ["Median per run", ...rows.map((r) => r.name)],
    body: [
      ["Total tokens", ...col((r) => arrow(r.off.total, r.on.total, tok))],
      ["Uncached input", ...col((r) => arrow(r.off.m.uncached, r.on.m.uncached, tok))],
      ["Cache read", ...col((r) => arrow(r.off.m.cacheRead, r.on.m.cacheRead, tok))],
      ["Cache write", ...col((r) => arrow(r.off.m.cacheWrite, r.on.m.cacheWrite, tok))],
      ["Output", ...col((r) => arrow(r.off.m.output, r.on.m.output, tok))],
      ["Model requests", ...col((r) => arrow(r.off.m.turns, r.on.m.turns, (x) => String(x)))],
      ["$ at list price", ...col((r) => arrow(r.off.caching.withCache, r.on.caching.withCache, usd2))],
      ["Verdict (tokens)", ...col((r) => r.verdict)],
    ],
    verdictColor: rows.map((r) => (!r.ok ? MUTE : r.verdict === "saves" ? GREEN : r.verdict === "overhead" ? RED : MUTE)),
  };
}
const DETAIL_FOOT = `OFF → ON (change), median of each side's runs, so the parts don't sum to the total. $ prices the measured tokens at list price per MTok: `
  + `input $${PRICE.input}, cache read $${PRICE.cacheRead.toFixed(2)}, cache write $${PRICE.cacheWrite}, output $${PRICE.output}. Verdict: "within noise" = OFF and ON ranges overlap.`;
function detailSlide(n, name, color, key, side) {
  const t = detailRows(key);
  const d = { n, name, eyebrow: `LEVER ${n}  ·  DETAILED STATS`, title: `${name}: the numbers`, header: t.header, body: t.body, verdictColor: t.verdictColor, side, footer: DETAIL_FOOT };
  DETAILS.push(d);
  const s = p.addSlide(); bg(s);
  leverBadge(s, M, 0.7, n, color);
  s.addText(d.eyebrow, { x: M + 1.15, y: 0.72, w: 8, h: 0.3, fontFace: HEAD, fontSize: 12, color, bold: true, charSpacing: 2, isTextBox: true, margin: 0 });
  s.addText(d.title, { x: M + 1.15, y: 1.0, w: 10, h: 0.7, fontFace: HEAD, fontSize: 32, color: WHITE, bold: true, isTextBox: true, margin: 0 });
  const colW = [1.9, 2.2, 2.2, 2.2];
  const cellOpt = (i, c) => ({ fontFace: c === 0 || i === 0 ? HEAD : BODY, fontSize: 10.5, bold: c === 0 || i === 0, valign: "middle", margin: [0, 6, 0, 6],
    color: i === 0 ? MUTE : c === 0 ? WHITE : i === t.body.length ? t.verdictColor[c - 1] : MUTE, fill: { color: i % 2 === 1 ? CARD : BG } });
  const rows = [t.header, ...t.body].map((r, i) => r.map((text, c) => ({ text, options: cellOpt(i, c) })));
  s.addTable(rows, { x: M, y: 2.0, w: colW.reduce((a, b) => a + b), colW, rowH: 0.42, border: { type: "none" } });
  card(s, 9.45, 2.0, W - M - 9.45, 3.78);
  s.addText(side.head, { x: 9.65, y: 2.15, w: W - M - 9.85, h: 0.4, fontFace: HEAD, fontSize: 13, color, bold: true, isTextBox: true, margin: 0 });
  s.addText(side.lines.map((l, i) => ({ text: l, options: { breakLine: i < side.lines.length - 1, paraSpaceAfter: 8 } })),
    { x: 9.65, y: 2.6, w: W - M - 9.85, h: 3.05, fontFace: BODY, fontSize: 11, color: WHITE, valign: "top", isTextBox: true, margin: 0, lineSpacingMultiple: 1.05 });
  s.addText(d.footer, { x: M, y: 6.05, w: 11.9, h: 0.55, fontFace: BODY, fontSize: 10, color: MUTE, isTextBox: true, margin: 0 });
  wordmark(s, W - 2.9, H - 0.55);
}
// Headroom side card: what the proxy itself counted on the ON runs, next to what the API billed
const HEADROOM_SIDE = (() => {
  const lines = [];
  const seen = [];
  DETAIL_TASKS.forEach(([sfx, name]) => {
    const pm = proxyMetrics(`headroom${sfx}__on`), on = runStats(`headroom${sfx}__on`);
    if (!pm || !on || !pm.input) { lines.push(`${name}: ${NOT_YET}.`); return; }
    lines.push(`${name}: ${tok(pm.requests)} requests, ${tok(pm.saved)} of ${tok(pm.input)} input tokens saved (${pct1(pm.saved / pm.input)}), ${tok(pm.busts)} cache busts.`);
    seen.push(pct1(pm.input / on.sumInSide));
  });
  if (seen.length) lines.push(`The proxy counted ${seen.join(" / ")} of the input-side tokens the API billed for the same runs, so its "saved" is a share of a smaller base.`);
  return { head: "What the proxy reports (ON runs)", lines };
})();
// Caveman side card: output saved vs input added, per run
const CAVEMAN_SIDE = (() => {
  const rows = DETAIL_TASKS.map(([sfx, name]) => noteRow(`caveman${sfx}`, name));
  const lines = rows.map((r) => (r.ok
    ? `${r.name}: output ${signedTok(r.on.m.output - r.off.m.output)}, input side ${signedTok(r.on.m.input - r.off.m.input)} per run.`
    : `${r.name}: ${NOT_YET}.`));
  const ok = rows.filter((r) => r.ok);
  if (ok.length) lines.push(`Output is ${ok.map((r) => pct1(r.off.outShare)).join(" / ")} of all tokens (OFF). An output token costs ${times(RATE.outVsRead)} a cache read, so $ can drop while tokens rise.`);
  return { head: "Output saved vs input added", lines };
})();

// ========== S6-9 LEVERS (each of the first two followed by its detail slide) ==========
leverSlide(1, "Headroom", PURPLE, "Demo",
  "A drop-in proxy that compresses tool outputs, logs and JSON before they reach the model — the bulky inputs coding agents rack up.",
  ["Run Claude Code through it: 'headroom wrap' — zero code changes", "Compresses tool / assistant messages; your prompts are untouched", "'headroom dashboard' shows live token savings", "Open source: headroomlabs-ai/headroom"],
  "Vendor's own benchmark: ~20% for coding agents, 60-95% for JSON. We measure our own.", NOTES.headroom);
detailSlide(1, "Headroom", PURPLE, "headroom", HEADROOM_SIDE);
leverSlide(2, "Caveman plugin", PURPLE_L, "Demo",
  "Compress the model's output and reasoning verbosity — same technical accuracy, far fewer words.",
  ["Enable the plugin; re-run a task", "Eyeball before / after: same result, shorter answers", "Savings land on the output line only — check the total too"],
  "Attacks: verbose model output. Its own ruleset is extra context on every turn.", NOTES.caveman);
detailSlide(2, "Caveman", PURPLE_L, "caveman", CAVEMAN_SIDE);
leverSlide(3, "Config", GREEN, "Hands-on",
  "A tight project config stops the agent re-discovering the repo every session. Lowest effort — measure what it saves on your repo.",
  ["Write a lean CLAUDE.md: commands, conventions, where things live", "Deny reads of generated output, fixtures, lockfiles (permissions.deny — Claude Code ignores .claudeignore)", "The agent stops paying the 're-learn the repo' tax"],
  "Attacks: poor defaults and reading the wrong files.", NOTES.config);
leverSlide(4, "CLI over MCP", YELLOW, "Hands-on",
  "Every loaded MCP server adds its tools to every request. Current Claude Code sends only the names and loads a schema on use, so the cost is small but paid on every turn.",
  ["Use gh and psql instead of GitHub / Postgres MCP servers", "Unload servers you don't use: their tool list rides along on every request", "Measure it on your own client: one that sends full schemas every turn wasn't measured here"],
  "Attacks: tool definitions in every request, and chatty tool output.", NOTES.cli);

// ========== S10 SCOREBOARD (filled live — NO pre-filled numbers) ==========
s = p.addSlide(); bg(s);
eyebrow(s, "RESULTS");
title(s, "The scoreboard");
const SC_SUB = "Same query, each optimization OFF then ON (Sonnet). Each row is one isolated A/B, filled from results/.";
s.addText(SC_SUB, { x: M, y: 1.85, w: 11.9, h: 0.5, fontFace: BODY, fontSize: 15, color: MUTE, isTextBox: true, margin: 0 });
// header row: Optimization | Before (off) | After (on) | Saved
const scX = M, scW = 7.7, rowH = 0.38, cols = [0.37, 0.22, 0.22, 0.19];
function scCell(x, y, w, txt, color, bold) {
  s.addText(txt, { x, y, w, h: rowH, fontFace: bold ? HEAD : BODY, fontSize: 11, color: color, bold: !!bold, valign: "middle", isTextBox: true, margin: 0.06 });
}
let ry = 2.4;
const scMeta = [];
// Every computed string the two results slides render, written to slide-text.json so
// the Google Slides copy of the deck is filled from the same computation (no retyping).
const EXPORT = { overview: levers.map(([n, name, line, mode]) => ({ n, name, line, mode })), levers: LEVERS, details: DETAILS, scoreboard: { rows: [], footnote: "" }, findings: [] };
scCell(scX + 0.15, ry, scW * cols[0], "Optimization", MUTE, true);
scCell(scX + scW * cols[0], ry, scW * cols[1], "Before (off)", MUTE, true);
scCell(scX + scW * (cols[0] + cols[1]), ry, scW * cols[2], "After (on)", MUTE, true);
scCell(scX + scW * (cols[0] + cols[1] + cols[2]), ry, scW * cols[3], "Saved", MUTE, true);
ry += rowH;
[["Headroom", "headroom"], ["Headroom (long answer)", "headroom_long"], ["Headroom (long chat)", "headroom_chain"],
 ["Caveman", "caveman"], ["Caveman (long answer)", "caveman_long"], ["Caveman (long chat)", "caveman_chain"],
 ["Config", "config"], ["CLI vs MCP", "cli"], ["CLI vs MCP (long answer)", "cli_long"], ["CLI vs MCP (long chat)", "cli_chain"]].forEach(([label, key], i) => {
  const ab = abRow(key);
  if (i % 2 === 0) s.addShape(p.ShapeType.roundRect, { x: scX, y: ry, w: scW, h: rowH, rectRadius: 0.05, fill: { color: CARD }, line: { type: "none" } });
  scCell(scX + 0.15, ry, scW * cols[0], label, WHITE, true);
  scCell(scX + scW * cols[0], ry, scW * cols[1], ab.off, MUTE);
  scCell(scX + scW * (cols[0] + cols[1]), ry, scW * cols[2], ab.on, MUTE);
  scCell(scX + scW * (cols[0] + cols[1] + cols[2]), ry, scW * cols[3], ab.saved, ab.win ? GREEN : MUTE);
  if (ab.meta) scMeta.push({ label, key, ...ab.meta, noise: ab.noise });
  EXPORT.scoreboard.rows.push({ label, off: ab.off, on: ab.on, saved: ab.saved, win: !!ab.win });
  ry += rowH;
});
// Footnote generated from the results files — what was actually measured.
if (scMeta.length) {
  const reps = Math.min(...scMeta.map((m) => m.reps));
  // Name the task per row only when rows differ (e.g. the long-answer Caveman row).
  const TASK_NAME = { "1": "small edit", "6": "written code review, no edits", "7": "6-message conversation in one session" };
  const byTask = {};
  scMeta.forEach((m) => (byTask[m.tasks] = byTask[m.tasks] || []).push(m.label));
  const taskKeys = Object.keys(byTask);
  const taskTxt = taskKeys.length === 1
    ? `task ${taskKeys[0]}`
    : taskKeys.map((t) => `${byTask[t].join(", ")} = task ${t}${TASK_NAME[t] ? ` (${TASK_NAME[t]})` : ""}`).join("; ");
  const notes = [`Total tokens (input + output + cache read + cache write), median of ${reps} runs per side; ${taskTxt}.`];
  const hrRows = scMeta.filter((m) => m.label.startsWith("Headroom")).map((m) => m.key);
  if (hrRows.length) {
    // Say how the Headroom toggle was applied, from the results files themselves
    // (every Headroom row must agree, or the footnote says so).
    const modeOf = (side) => {
      const ms = new Set(hrRows.map((k) => {
        try { return JSON.parse(fs.readFileSync(nodePath.join(__dirname, "..", "results", `${k}__${side}.json`), "utf8")).mode; } catch { return undefined; }
      }));
      return ms.size === 1 ? [...ms][0] : undefined;
    };
    const mOff = modeOf("off"), mOn = modeOf("on");
    const HR_MODE_TEXT = {
      "headroom-proxy": "Headroom = traffic routed through headroom proxy, passthrough (--no-optimize) vs optimizing.",
      "headroom-proxy-bedrock": "Headroom = traffic routed through headroom proxy (Bedrock passthrough to the local gateway), --mode token, --no-optimize vs optimizing.",
    };
    if (mOff && mOff === mOn && HR_MODE_TEXT[mOn]) notes.push(HR_MODE_TEXT[mOn]);
    else notes.push("Headroom toggle method not recorded — re-run eval:all.");
  } else {
    notes.push("Headroom: not measured yet (proxy A/B pending).");
  }
  if (scMeta.some((m) => m.noise)) notes.push("* OFF and ON ranges overlap — within run-to-run noise.");
  EXPORT.scoreboard.footnote = notes.join("  ");
  s.addText(notes.join("  "), { x: scX, y: ry + 0.1, w: scW + 0.6, h: 0.7, fontFace: BODY, fontSize: 10, color: MUTE, isTextBox: true, margin: 0 });
}
// honest callout — method, not a fabricated result
card(s, 9.1, 2.6, 3.5, 3.4);
s.addShape(p.ShapeType.ellipse, { x: 10.5, y: 2.95, w: 0.7, h: 0.7, fill: { color: PURPLE }, line: { type: "none" } });
const SC_CALL = { head: "Same query,\noff vs on", body: "Each optimization measured on its own. Re-run eval:all to get yours — mileage varies by repo and task." };
EXPORT.scoreboard.sub = SC_SUB; EXPORT.scoreboard.callout = SC_CALL;
s.addText(SC_CALL.head, { x: 9.1, y: 3.85, w: 3.5, h: 1.0, fontFace: HEAD, fontSize: 22, color: WHITE, bold: true, align: "center", isTextBox: true, margin: 0, lineSpacingMultiple: 1.0 });
s.addText(SC_CALL.body, { x: 9.3, y: 4.95, w: 3.1, h: 1.1, fontFace: BODY, fontSize: 13, color: MUTE, align: "center", isTextBox: true, margin: 0, lineSpacingMultiple: 1.15 });
wordmark(s, W - 2.9, H - 0.55);

// ========== S10b FINDINGS (every figure computed from results/ — none typed) ==========
s = p.addSlide(); bg(s);
eyebrow(s, "FINDINGS");
title(s, "What the numbers say");
(() => {
  const pctOf = (x) => { const v = x * 100; return `${v < 10 ? v.toFixed(1) : Math.round(v)}%`; };
  const pair = (k) => ({ ab: abRow(k), off: runStats(`${k}__off`), on: runStats(`${k}__on`) });
  const MISSING = { big: "—", color: MUTE, body: "Not measured yet — run npm run eval:all -- --long." };
  const cards = [];
  // biggest real (non-noise) win across the measured rows
  const winners = ["caveman", "caveman_long", "caveman_chain", "config", "cli", "cli_long", "cli_chain", "headroom", "headroom_long", "headroom_chain"]
    .map((k) => ({ k, ab: abRow(k), off: resultTotal(`${k}__off`), on: resultTotal(`${k}__on`) }))
    .filter((r) => r.ab.win).sort((a, b) => (b.off.total - b.on.total) / b.off.total - (a.off.total - a.on.total) / a.off.total);
  const cfg = pair("config");
  // Same "within noise" rule as the scoreboard, and the range instead of a bare %:
  // one facilitator run on one task is not a promise for anyone else's repo.
  const rng = (t) => `${t.min.toLocaleString()}–${t.max.toLocaleString()}`;
  const cfgT = { off: resultTotal("config__off"), on: resultTotal("config__on") };
  cards.push(cfg.ab.meta && cfg.off && cfg.on ? {
    head: cfg.ab.noise ? "Config: within noise" : winners[0]?.k === "config" ? "Config: biggest win in our run" : "Config",
    big: cfg.ab.noise ? `${cfg.ab.pct} (noise)` : `${cfg.ab.pct} fewer`, color: cfg.ab.win ? GREEN : MUTE,
    body: `Task ${cfg.ab.meta.tasks}, n=${cfg.ab.meta.reps}: ${rng(cfgT.off)} → ${rng(cfgT.on)} tokens, turns ${cfg.off.turns} → ${cfg.on.turns}. Facilitator run — yours may vary.`,
  } : { head: "Config", ...MISSING });
  const cv = pair("caveman");
  cards.push(cv.ab.meta && cv.off && cv.on ? {
    head: "Caveman: shorter answers…", big: `${chg(cv.off.out, cv.on.out)} output`, color: YELLOW,
    body: `…but total tokens ${chg(cv.off.total, cv.on.total)}${cv.ab.noise ? " (within noise)" : ""}: its ruleset is extra context on every turn.`,
  } : { head: "Caveman", ...MISSING });
  const cc = pair("caveman_chain");
  cards.push(cc.ab.meta && cc.off && cc.on ? {
    head: "Caveman in a long chat", big: `${chg(cc.off.out, cc.on.out)} output`, color: YELLOW,
    body: `${cc.off.costOk && cc.on.costOk ? `Cost ${chg(cc.off.cost, cc.on.cost)}` : `Tokens ${chg(cc.off.total, cc.on.total)}`}: output is only ${pctOf(cc.off.outShare)} of a long chat's tokens.`,
  } : { head: "Caveman in a long chat", ...MISSING });
  const usd = (x) => `$${x.toFixed(2)}`;
  const ccc = CHAT?.caching;
  cards.push(CHAT ? {
    head: "Long chats live on the prompt cache", big: `${pctOf(CHAT.cacheShare)} cache reads`, color: PURPLE_L,
    body: `Reads bill at ${times(RATE.read)} input: ${usd(ccc.withCache)} per 6-message chat cached vs ${usd(ccc.noCache)} uncached (${chg(ccc.noCache, ccc.withCache)}), Sonnet list price. Keep the prefix stable; compact, don't restart.`,
  } : { head: "Long chats live on the prompt cache", ...MISSING });
  // CLI vs MCP: lead with the long chat when measured (where a per-request cost adds up),
  // and say what loading the MCP servers cost per request (OFF = MCP loaded).
  const cliRows = [["cli", "edit"], ["cli_long", "review"], ["cli_chain", "chat"]].map(([k, name]) => ({ name, r: noteRow(k, name) })).filter((x) => x.r.ok);
  const cliLead = cliRows.find((x) => x.name === "chat") || cliRows[0];
  cards.push(cliLead ? {
    head: `CLI vs MCP: ${cliLead.name}${cliLead.r.ab.noise ? ", within noise" : ""}`, big: `${chg(cliLead.r.off.total, cliLead.r.on.total)} tokens`,
    color: cliLead.r.ab.win ? GREEN : MUTE,
    body: `${cliRows.map((x) => `${x.name} ${chg(x.r.off.total, x.r.on.total)}${x.r.ab.noise ? "*" : ""}`).join(", ")} (* = noise).`
      + (cliLead.r.perReq != null ? ` With MCP loaded, input per request differed by ${signedTok(-cliLead.r.perReq)} tokens: names only, schemas load on use.` : ""),
  } : { head: "CLI vs MCP", ...MISSING });
  // Headroom: all three rows, plus what the proxy itself says it compressed during ON
  // (delta of headroom_tokens_saved_total in results/<row>__on.headroom-metrics.txt).
  // { saved, runs }: tokens_saved delta from /metrics, and the number of requests the
  // compression pipeline ran on (header line written by run-all.sh hr_row).
  const hrProxy = (label) => {
    try {
      const t = fs.readFileSync(nodePath.join(__dirname, "..", "results", `${label}.headroom-metrics.txt`), "utf8");
      const [before, after] = t.split("# /metrics after");
      const val = (s) => Number((s.match(/^headroom_tokens_saved_total\s+([\d.e+]+)/m) || [])[1] ?? NaN);
      const v = val(after) - (val(before) || 0);
      const runs = Number((t.match(/pipeline ran on (\d+) requests/) || [])[1] ?? NaN);
      return { saved: Number.isFinite(v) ? v : null, runs: Number.isFinite(runs) ? runs : null };
    } catch { return { saved: null, runs: null }; }
  };
  const HR_ROWS = [["headroom", "edit"], ["headroom_long", "review"], ["headroom_chain", "chat"]]
    .map(([k, name]) => ({ k, name, ab: abRow(k), off: resultTotal(`${k}__off`), on: resultTotal(`${k}__on`), proxy: hrProxy(`${k}__on`) }))
    .filter((r) => r.ab.meta);
  if (HR_ROWS.length) {
    const best = [...HR_ROWS].sort((a, b) => (b.off.total - b.on.total) / b.off.total - (a.off.total - a.on.total) / a.off.total)[0];
    const anyWin = HR_ROWS.some((r) => r.ab.win);
    // A row where ON cost more and the ranges don't overlap is a real loss, not noise —
    // the card must lead with it rather than with the best (noise-level) row.
    const losses = HR_ROWS.filter((r) => !r.ab.noise && r.on.total > r.off.total);
    const worst = [...losses].sort((a, b) => (a.off.total - a.on.total) / a.off.total - (b.off.total - b.on.total) / b.off.total)[0];
    const proxySaved = HR_ROWS.reduce((a, r) => a + (r.proxy.saved ?? 0), 0);
    const pipeRuns = HR_ROWS.every((r) => r.proxy.runs != null) ? HR_ROWS.reduce((a, r) => a + r.proxy.runs, 0) : null;
    const proxyLine = pipeRuns != null
      ? `Proxy compressed ${Math.round(proxySaved).toLocaleString()} tokens over ${pipeRuns} requests it inspected.`
      : `Proxy's own /metrics: ${Math.round(proxySaved).toLocaleString()} tokens compressed.`;
    cards.push({
      head: anyWin ? `Headroom: best on the ${best.name}` : worst ? `Headroom: the ${worst.name} cost more` : proxySaved === 0 ? "Headroom: nothing to squeeze here" : "Headroom: within noise here",
      big: `${chg((anyWin || !worst ? best : worst).off.total, (anyWin || !worst ? best : worst).on.total)} tokens`, color: anyWin ? GREEN : MUTE,
      body: `${HR_ROWS.map((r) => `${r.name} ${chg(r.off.total, r.on.total)}${r.ab.noise ? "*" : ""}`).join(", ")} (* = noise). ${proxyLine}`,
    });
  } else {
    cards.push({ head: "Headroom", ...MISSING, body: "Not measured yet — run npm run eval:all -- --only headroom --long." });
  }
  EXPORT.findings = cards.map(({ head, big, body }) => ({ head, big, body }));
  const gap = 0.35, cw = (W - 2 * M - 2 * gap) / 3, ch = 2.05;
  cards.forEach((c, i) => {
    const x = M + (i % 3) * (cw + gap), y = 2.2 + Math.floor(i / 3) * (ch + 0.25);
    card(s, x, y, cw, ch);
    s.addText(c.big, { x: x + 0.3, y: y + 0.2, w: cw - 0.6, h: 0.62, fontFace: HEAD, fontSize: 28, color: c.color, bold: true, isTextBox: true, margin: 0 });
    s.addText(c.head, { x: x + 0.3, y: y + 0.85, w: cw - 0.6, h: 0.38, fontFace: HEAD, fontSize: 14, color: WHITE, bold: true, isTextBox: true, margin: 0 });
    s.addText(c.body, { x: x + 0.3, y: y + 1.22, w: cw - 0.6, h: 0.78, fontFace: BODY, fontSize: 11.5, color: MUTE, isTextBox: true, margin: 0, lineSpacingMultiple: 1.05 });
  });
})();
s.addText("Computed from results/ at build time — Sonnet, median per side; each run's answer and diff are in results/*.runs/.", { x: M, y: H - 0.55, w: 9.2, h: 0.3, fontFace: BODY, fontSize: 10, color: MUTE, isTextBox: true, margin: 0 });
wordmark(s, W - 2.9, H - 0.55);

// ========== S12 HIRING ==========
s = p.addSlide(); bg(s);
s.addShape(p.ShapeType.roundRect, { x: W - 4.4, y: -1, w: 5.6, h: 9.6, rectRadius: 0, fill: { color: BG2 }, line: { type: "none" }, rotate: 10 });
dots(s, M, 1.1, 0.14);
eyebrow(s, "WE'RE HIRING");
s.addText("monday.com is hiring\nin Warsaw", { x: M, y: 1.75, w: 9, h: 1.9, fontFace: HEAD, fontSize: 46, color: WHITE, bold: true, isTextBox: true, margin: 0, lineSpacingMultiple: 1.0 });
s.addText("Like what you saw? Come build this kind of thing with us.", { x: M, y: 3.9, w: 8.4, h: 0.6, fontFace: BODY, fontSize: 18, color: MUTE, isTextBox: true, margin: 0 });
s.addShape(p.ShapeType.roundRect, { x: M, y: 4.8, w: 7.2, h: 0.75, rectRadius: 0.12, fill: { color: CARD }, line: { color: PURPLE, width: 1.2 } });
s.addText("monday.com/careers  ·  Warsaw", { x: M + 0.1, y: 4.8, w: 7.0, h: 0.75, fontFace: HEAD, fontSize: 17, color: PURPLE_L, bold: true, align: "center", valign: "middle", isTextBox: true, margin: 0, hyperlink: { url: "https://monday.com/careers?location=warsaw" } });
s.addText("Curious or want a referral? Reach out — my details are on the next slide.", { x: M, y: 5.85, w: 8.4, h: 0.6, fontFace: BODY, fontSize: 15, color: MUTE, italic: true, isTextBox: true, margin: 0 });
wordmark(s, W - 2.9, H - 0.55);

// ========== S13 SOCIALS ==========
s = p.addSlide(); bg(s);
eyebrow(s, "LET'S CONNECT");
title(s, "Find me online");
const socials = [
  ["LinkedIn", "/in/mvoitko", "https://www.linkedin.com/in/mvoitko/", PURPLE],
  ["Threads", "@m_voitko", "https://www.threads.com/@m_voitko", PURPLE_L],
  ["Instagram", "@m_voitko", "https://instagram.com/m_voitko", RED],
  ["Telegram", "forgottendatashadows", "https://t.me/forgottendatashadows", PURPLE_L],
  ["X", "@mxvtk1", "https://x.com/mxvtk1", WHITE],
  ["Website", "mxvtk.dev", "https://mxvtk.dev", GREEN],
];
const scw = (W - 2 * M - 2 * 0.4) / 3, sch = 1.5;
socials.forEach((c, i) => {
  const x = M + (i % 3) * (scw + 0.4);
  const y = 2.5 + Math.floor(i / 3) * (sch + 0.4);
  s.addShape(p.ShapeType.roundRect, { x, y, w: scw, h: sch, rectRadius: 0.12, fill: { color: CARD }, line: { type: "none" }, hyperlink: { url: c[2] } });
  s.addShape(p.ShapeType.ellipse, { x: x + 0.4, y: y + 0.4, w: 0.42, h: 0.42, fill: { color: c[3] }, line: { type: "none" } });
  s.addText(c[0], { x: x + 1.05, y: y + 0.36, w: scw - 1.3, h: 0.5, fontFace: HEAD, fontSize: 18, color: WHITE, bold: true, valign: "middle", isTextBox: true, margin: 0 });
  s.addText(c[1], { x: x + 0.4, y: y + 0.92, w: scw - 0.7, h: 0.45, fontFace: BODY, fontSize: 14, color: MUTE, isTextBox: true, margin: 0, hyperlink: { url: c[2] } });
});
wordmark(s, W - 2.9, H - 0.55);

// ========== S14 CLOSE: LESSONS (not "use these four") ==========
// No figures here on purpose: the results slides carry the numbers.
s = p.addSlide(); bg(s, BG);
s.addShape(p.ShapeType.roundRect, { x: -1, y: H - 1.9, w: W + 2, h: 3.0, rectRadius: 0, fill: { color: BG2 }, line: { type: "none" }, rotate: -6 });
eyebrow(s, "LESSONS");
title(s, "What we learned");
const LESSONS = {
  title: "What we learned",
  cards: [
    ["Don't trust plugin benchmarks", "A vendor's headline number is measured on its tasks, not yours. Treat it as a hypothesis to test.", RED],
    ["Build your own eval", "Fixed tasks, OFF vs ON, several reps per side — and check the toggle really flipped.", GREEN],
    ["Results vary per model", "Model, transport, Claude Code version and repo all move the number. Re-measure when one changes.", PURPLE_L],
    ["Tokens aren't quality", "Nothing here grades the answers yet. A cheaper run with a wrong answer isn't a saving.", YELLOW],
  ],
  line: "Measure on your repo first — then keep only what wins there.",
};
const lw = (W - 2 * M - 3 * 0.35) / 4;
LESSONS.cards.forEach(([head, body, col], i) => {
  const x = M + i * (lw + 0.35);
  card(s, x, 2.25, lw, 2.75);
  s.addShape(p.ShapeType.roundRect, { x: x + 0.3, y: 2.55, w: 0.42, h: 0.42, rectRadius: 0.08, fill: { color: col }, line: { type: "none" } });
  s.addText(head, { x: x + 0.3, y: 3.1, w: lw - 0.6, h: 0.75, fontFace: HEAD, fontSize: 16, color: WHITE, bold: true, isTextBox: true, margin: 0, lineSpacingMultiple: 1.0 });
  s.addText(body, { x: x + 0.3, y: 3.85, w: lw - 0.6, h: 1.05, fontFace: BODY, fontSize: 12.5, color: MUTE, isTextBox: true, margin: 0, lineSpacingMultiple: 1.1 });
});
s.addText(LESSONS.line, { x: M, y: 5.3, w: 11.9, h: 0.5, fontFace: BODY, fontSize: 17, color: PURPLE_L, isTextBox: true, margin: 0 });
s.addText("Thank you", { x: M, y: 6.2, w: 6, h: 0.6, fontFace: HEAD, fontSize: 24, color: WHITE, bold: true, isTextBox: true, margin: 0 });
wordmark(s, W - 2.9, H - 0.6);
EXPORT.lessons = { title: LESSONS.title, cards: LESSONS.cards.map(([head, body]) => ({ head, body })), line: LESSONS.line };

// ========== S15 Q&A (last) ==========
const QA = {
  eyebrow: "Q&A",
  title: "Questions?",
  sub: "Ask about the eval, the numbers, or how to measure your own repo.",
  link: "github.com/mxvtk/token-lab",
  url: "https://github.com/mxvtk/token-lab",
};
s = p.addSlide(); bg(s, BG);
s.addShape(p.ShapeType.roundRect, { x: -1, y: H - 1.9, w: W + 2, h: 3.0, rectRadius: 0, fill: { color: BG2 }, line: { type: "none" }, rotate: -6 });
s.addText(QA.eyebrow, { x: M, y: 1.25, w: 8, h: 0.35, fontFace: HEAD, fontSize: 14, color: PURPLE_L, bold: true, charSpacing: 2, isTextBox: true, margin: 0 });
s.addText(QA.title, { x: M, y: 1.65, w: 11.9, h: 1.5, fontFace: HEAD, fontSize: 72, color: WHITE, bold: true, isTextBox: true, margin: 0 });
s.addText(QA.sub, { x: M, y: 3.3, w: 11.9, h: 0.6, fontFace: BODY, fontSize: 20, color: MUTE, isTextBox: true, margin: 0 });
s.addShape(p.ShapeType.roundRect, { x: M, y: 4.2, w: 5.2, h: 0.7, rectRadius: 0.12, fill: { color: CARD }, line: { color: PURPLE, width: 1.2 } });
s.addText(QA.link, { x: M, y: 4.2, w: 5.2, h: 0.7, fontFace: HEAD, fontSize: 17, color: PURPLE_L, bold: true, align: "center", valign: "middle", isTextBox: true, margin: 0, hyperlink: { url: QA.url } });
dots(s, M, 5.55, 0.13);
wordmark(s, W - 2.9, H - 0.6);
EXPORT.qa = QA;

fs.writeFileSync(nodePath.join(__dirname, "slide-text.json"), JSON.stringify(EXPORT, null, 2) + "\n");
p.writeFile({ fileName: nodePath.join(__dirname, "token-spend-workshop.pptx") }).then(f => console.log("WROTE", f));
