# caveman__off task 1 rep 3

Grade: "GET /api/health returns {status:'ok'}"

## Agent result

The change is a single synchronous route handler with no DB queries, no feature flags, no UI components, and no service calls — none of the blocking guardrails apply here.

`GET /api/health` is now registered at `api/src/index.ts:16`, placed before the DB-dependent routes so it stays reachable even if the database is unavailable.

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
  "output_tokens": 840,
  "cache_read_input_tokens": 129196,
  "cache_creation_input_tokens": 18542,
  "total_tokens": 148586,
  "cost_usd": 0.1626348,
  "num_turns": 4
}
```
