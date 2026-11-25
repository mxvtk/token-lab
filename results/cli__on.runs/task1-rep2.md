# cli__on task 1 rep 2

Grade: "GET /api/health returns {status:'ok'}"

## Agent result

The change is a single stateless route with no DB access, feature flags, or UI — none of the blocking guardrails apply here.

Done. `GET /api/health` now returns `{"status":"ok"}` with HTTP 200, registered just before the user routes in `api/src/index.ts:16`.

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
  "output_tokens": 864,
  "cache_read_input_tokens": 116887,
  "cache_creation_input_tokens": 14306,
  "total_tokens": 132065,
  "cost_usd": 0.1338861,
  "num_turns": 4,
  "permission_denials": 0
}
```
