# cli__on task 1 rep 3

Grade: "GET /api/health returns {status:'ok'}"

## Agent result

The edit is already applied. For this minimal change — a single synchronous GET route with no DB access, no feature flags, no UI — none of the blocking guardrails apply.

`GET /api/health` is live at line 16 in `api/src/index.ts`, returning `{"status":"ok"}` with HTTP 200.

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
  "output_tokens": 853,
  "cache_read_input_tokens": 117434,
  "cache_creation_input_tokens": 14553,
  "total_tokens": 132848,
  "cost_usd": 0.13536720000000002,
  "num_turns": 4,
  "permission_denials": 0
}
```
