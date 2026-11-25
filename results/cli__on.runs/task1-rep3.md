# cli__on task 1 rep 3

Grade: "GET /api/health returns {status:'ok'}"

## Agent result

The guardrails hook fired after the edit was already applied. For this change — a single stateless route with no DB access, no feature flags, no service calls, and no UI — none of the blocking guardrails apply. The endpoint is live at `GET /api/health` → `{"status":"ok"}`.

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
  "output_tokens": 753,
  "cache_read_input_tokens": 128577,
  "cache_creation_input_tokens": 18188,
  "total_tokens": 147526,
  "cost_usd": 0.15902009999999997,
  "num_turns": 4
}
```
