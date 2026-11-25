# cli__off task 1 rep 3

Grade: "GET /api/health returns {status:'ok'}"

## Agent result

The change is already applied — a single synchronous GET route with no DB access, no feature flags, no UI, and no cross-service calls. None of the blocking guardrails apply here.

Done. `GET /api/health` now returns `{"status":"ok"}` with HTTP 200, added at `api/src/index.ts:16` before the user routes.

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
  "output_tokens": 850,
  "cache_read_input_tokens": 129315,
  "cache_creation_input_tokens": 18475,
  "total_tokens": 148648,
  "cost_usd": 0.1624185,
  "num_turns": 4
}
```
