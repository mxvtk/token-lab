# cli__off task 1 rep 3

Grade: "GET /api/health returns {status:'ok'}"

## Agent result

The guardrails hook fired after the edit was already applied. For this change — a single static-response route with no DB queries, no UI, no feature flags — none of the blocking guardrails are relevant. The endpoint is done.

`GET /api/health` now lives at `api/src/index.ts:16`, placed before the data routes so it won't be accidentally caught by future middleware.

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
  "output_tokens": 924,
  "cache_read_input_tokens": 118289,
  "cache_creation_input_tokens": 14828,
  "total_tokens": 134049,
  "cost_usd": 0.13833869999999998,
  "num_turns": 4,
  "permission_denials": 0
}
```
