# headroom__off task 1 rep 3

Grade: "GET /api/health returns {status:'ok'}"

## Agent result

The change is a single new route with no DB calls, no feature flags, no UI, and no service-to-service HTTP — none of the blocking guardrails apply here.

`GET /api/health` is now at `api/src/index.ts:15`, placed before the DB-dependent routes so it stays responsive even if the database is down.

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
  "output_tokens": 878,
  "cache_read_input_tokens": 128444,
  "cache_creation_input_tokens": 18171,
  "total_tokens": 147501,
  "cost_usd": 0.1607532,
  "num_turns": 4,
  "permission_denials": 0
}
```
