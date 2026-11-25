# headroom__on task 1 rep 2

Grade: "GET /api/health returns {status:'ok'}"

## Agent result

`★ Insight ─────────────────────────────────────`
Using `_req` (underscore prefix) signals intentionally unused parameters — a TypeScript/ESLint convention that suppresses "unused variable" warnings without disabling the rule globally.
`─────────────────────────────────────────────────`

Done. Added `GET /api/health` at `api/src/index.ts`, placed before the existing routes so it responds without touching the database.

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
  "input_tokens": 12,
  "output_tokens": 1126,
  "cache_read_input_tokens": 278008,
  "cache_creation_input_tokens": 19770,
  "total_tokens": 298916,
  "cost_usd": 0.21894840000000002,
  "num_turns": 9,
  "permission_denials": 0
}
```
