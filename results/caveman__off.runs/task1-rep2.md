# caveman__off task 1 rep 2

Grade: "GET /api/health returns {status:'ok'}"

## Agent result

The hook fired after the edit was already applied. For this change — a single synchronous route with no DB access, no UI, no feature flags, and no service calls — none of the blocking guardrails are relevant. The endpoint is done.

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
  "output_tokens": 847,
  "cache_read_input_tokens": 129201,
  "cache_creation_input_tokens": 18541,
  "total_tokens": 148597,
  "cost_usd": 0.1627353,
  "num_turns": 4
}
```
