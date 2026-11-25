# caveman__on task 1 rep 3

Grade: "GET /api/health returns {status:'ok'}"

## Agent result

Done. `GET /api/health` added at `api/src/index.ts:16`, placed before DB routes so it responds even when the pool is unavailable.

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
  "output_tokens": 537,
  "cache_read_input_tokens": 136321,
  "cache_creation_input_tokens": 20752,
  "total_tokens": 157618,
  "cost_usd": 0.1734873,
  "num_turns": 4
}
```
