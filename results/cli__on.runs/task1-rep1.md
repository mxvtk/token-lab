# cli__on task 1 rep 1

Grade: "GET /api/health returns {status:'ok'}"

## Agent result

The change is a single new route with no DB calls, no feature flags, and no UI — none of the blocking guardrails apply here.

`GET /api/health` is now live at `api/src/index.ts:16`, placed before the DB-dependent routes so it stays reachable even if the database is down.

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
  "output_tokens": 815,
  "cache_read_input_tokens": 117364,
  "cache_creation_input_tokens": 14524,
  "total_tokens": 132711,
  "cost_usd": 0.1346022,
  "num_turns": 4,
  "permission_denials": 0
}
```
