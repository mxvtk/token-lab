# headroom__on task 1 rep 3

Grade: "GET /api/health returns {status:'ok'}"

## Agent result

The change is already applied. For a one-liner health endpoint with no DB access, feature flags, UI, or inter-service calls, none of the blocking guardrails apply.

`★ Insight ─────────────────────────────────────`
Using `_req` (underscore prefix) for the unused request parameter is a TypeScript/ESLint convention that explicitly signals the parameter is intentionally ignored — avoids a `no-unused-vars` lint error without disabling the rule.
`─────────────────────────────────────────────────`

`GET /api/health` now returns `{"status":"ok"}` with HTTP 200. Done.

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
  "input_tokens": 9,
  "output_tokens": 1062,
  "cache_read_input_tokens": 165977,
  "cache_creation_input_tokens": 18986,
  "total_tokens": 186034,
  "cost_usd": 0.17966609999999997,
  "num_turns": 5,
  "permission_denials": 0
}
```
