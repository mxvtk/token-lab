# config__off task 1 rep 3

Grade: "GET /api/health returns {status:'ok'}"

## Agent result

The edit is already applied. For this change — a single synchronous route returning a static JSON object — none of the blocking guardrails apply (no DB queries, no feature flags, no UI, no service-to-service calls).

`GET /api/health` is live at `api/src/index.ts:16`, placed before the DB-dependent routes so it responds even when the database is unavailable.

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
  "output_tokens": 895,
  "cache_read_input_tokens": 128931,
  "cache_creation_input_tokens": 18390,
  "total_tokens": 148224,
  "cost_usd": 0.1624683,
  "num_turns": 4
}
```
