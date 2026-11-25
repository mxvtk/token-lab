# cli__off task 1 rep 1

Grade: "GET /api/health returns {status:'ok'}"

## Agent result

The edit is already applied. For this change — a single synchronous route with no DB call, no UI, no feature flags — none of the blocking guardrails are relevant (no service calls, no SELECT *, no Vibe components, no accessibility surface).

Done. `GET /api/health` now returns `{"status":"ok"}` with HTTP 200.

## Diff

```diff
diff --git a/api/src/index.ts b/api/src/index.ts
index 6165a7f..0cf87e0 100644
--- a/api/src/index.ts
+++ b/api/src/index.ts
@@ -12,6 +12,10 @@ app.use((_req, res, next) => {
   next();
 });
 
+app.get("/api/health", (_req, res) => {
+  res.json({ status: "ok" });
+});
+
 // List all users.
 app.get("/api/users", async (_req, res) => {
   const { rows } = await pool.query(
```

## Usage

```json
{
  "input_tokens": 8,
  "output_tokens": 742,
  "cache_read_input_tokens": 128773,
  "cache_creation_input_tokens": 18211,
  "total_tokens": 147734,
  "cost_usd": 0.1590519,
  "num_turns": 4
}
```
