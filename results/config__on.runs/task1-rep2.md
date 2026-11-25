# config__on task 1 rep 2

Grade: "GET /api/health returns {status:'ok'}"

## Agent result

Done. Added to `api/src/index.ts:16`:

```ts
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});
```

Hits `GET /api/health` → `{"status":"ok"}` with HTTP 200. No DB dependency, so it responds even if Postgres is down.

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
  "input_tokens": 7,
  "output_tokens": 478,
  "cache_read_input_tokens": 92382,
  "cache_creation_input_tokens": 18328,
  "total_tokens": 111195,
  "cost_usd": 0.1448736,
  "num_turns": 3
}
```
