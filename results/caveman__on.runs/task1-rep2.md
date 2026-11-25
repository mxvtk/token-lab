# caveman__on task 1 rep 2

Grade: "GET /api/health returns {status:'ok'}"

## Agent result

Change is a 3-line no-DB health route — no service boundaries, no DB queries, no feature flags, no UI. No blocking guardrails apply.

Done. `GET /api/health` added at `api/src/index.ts:16`, returns `{"status":"ok"}` with HTTP 200, registered before the user routes.

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
  "output_tokens": 626,
  "cache_read_input_tokens": 136747,
  "cache_creation_input_tokens": 20976,
  "total_tokens": 158357,
  "cost_usd": 0.1290981,
  "num_turns": 4
}
```
