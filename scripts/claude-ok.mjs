// Reads `claude -p … --output-format json` on stdin; exits 0 only if the call
// succeeded. Handles both shapes: one result object, or an array of events.
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  try {
    const parsed = JSON.parse(raw);
    const events = Array.isArray(parsed) ? parsed : [parsed];
    const r = [...events].reverse().find((e) => e && e.type === "result");
    process.exit(r && r.is_error === false ? 0 : 1);
  } catch {
    process.exit(1);
  }
});
