// Is a plugin (default caveman@claude-community) installable from a configured marketplace?
//   node scripts/caveman-avail.mjs [plugin@marketplace] [--why]
// Exit 0 = available. Checks the marketplace's manifest on disk first (works even
// when another configured marketplace is broken and `plugin list --available`
// fails), then falls back to `claude plugin list --json --available`.
// --why prints what was found on stderr, for the setup warning.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const why = args.includes("--why");
const id = args.find((a) => !a.startsWith("--")) ?? "caveman@claude-community";
const [name, market] = id.split("@");
const claude = process.env.CLAUDE_BIN || "claude";
const notes = [];
const run = (...a) => execFileSync(claude, a, { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] });
const errText = (e) => String(e.stderr || e.message || e).trim().split("\n").slice(-2).join(" | ");

// Old Claude Code (e.g. 2.0.x) has no `plugin list`, no --json and no --scope, and
// rejects today's community marketplace schema — nothing below can work there.
const help = (...a) => { try { return run(...a, "--help"); } catch (e) { return String(e.stdout || ""); } };
if (!/--available/.test(help("plugin", "list")) || !/--scope/.test(help("plugin", "install"))) {
  let v = "?";
  try { v = run("--version").trim().replace(" (Claude Code)", ""); } catch {}
  if (why) console.error(`      Claude Code ${v} is too old for the plugin commands the eval uses (plugin list --json, install --scope) — run: claude update`);
  process.exit(2);
}

let found = false;
try {
  const mks = JSON.parse(run("plugin", "marketplace", "list", "--json"));
  notes.push(`configured marketplaces: ${mks.map((m) => m.name).join(", ") || "(none)"}`);
  const mk = mks.find((m) => m.name === market);
  if (!mk) notes.push(`marketplace "${market}" is not configured`);
  else {
    try {
      const man = JSON.parse(readFileSync(join(mk.installLocation, ".claude-plugin", "marketplace.json"), "utf8"));
      found = (man.plugins ?? []).some((p) => p.name === name);
      notes.push(`"${market}" manifest: ${(man.plugins ?? []).length} plugins, ${name} ${found ? "listed" : "NOT listed (stale? run: claude plugin marketplace update " + market + ")"}`);
    } catch (e) {
      notes.push(`"${market}" manifest unreadable at ${mk.installLocation}: ${errText(e)}`);
    }
  }
} catch (e) {
  notes.push(`claude plugin marketplace list failed: ${errText(e)}`);
}

if (!found) {
  try {
    const out = JSON.parse(run("plugin", "list", "--json", "--available"));
    found = (out.available ?? []).some((p) => p.pluginId === id);
    if (!found) notes.push(`not in \`claude plugin list --available\``);
  } catch (e) {
    notes.push(`claude plugin list --json --available failed: ${errText(e)}`);
  }
}

if (why && !found) for (const n of notes) console.error(`      ${n}`);
process.exit(found ? 0 : 1);
