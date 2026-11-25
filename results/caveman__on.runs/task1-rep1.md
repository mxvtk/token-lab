# caveman__on task 1 rep 1

Grade: "GET /api/health returns {status:'ok'}"

## Agent result

Health endpoint is trivial — no DB, no feature flags, no UI, no service boundaries. No guardrails apply. Done: `GET /api/health` returns `{"status":"ok"}` at `api/src/index.ts:16`.

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
  "output_tokens": 619,
  "cache_read_input_tokens": 136922,
  "cache_creation_input_tokens": 21075,
  "total_tokens": 158624,
  "cost_usd": 0.17683559999999998,
  "num_turns": 4
}
```
