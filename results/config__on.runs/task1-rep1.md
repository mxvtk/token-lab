# config__on task 1 rep 1

Grade: "GET /api/health returns {status:'ok'}"

## Agent result

The health endpoint is in place. The change is a single static route with no DB calls, no feature flags, and no external services — none of the blocking guardrails apply here.

`★ Insight ─────────────────────────────────────`
Express routes are matched in registration order. Placing `/api/health` before `/api/users/:id` ensures the string `"health"` is never accidentally captured by the `:id` parameter (Express would have matched it as an id lookup otherwise).
`─────────────────────────────────────────────────`

`GET /api/health` now returns `{"status":"ok"}` with HTTP 200. Restart the container (`docker compose up -d`) to pick up the change.

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
  "output_tokens": 740,
  "cache_read_input_tokens": 92645,
  "cache_creation_input_tokens": 18354,
  "total_tokens": 111746,
  "cost_usd": 0.1490385,
  "num_turns": 3
}
```
