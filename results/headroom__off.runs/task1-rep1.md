# headroom__off task 1 rep 1

Grade: "GET /api/health returns {status:'ok'}"

## Agent result

The change is already applied. For this minimal health endpoint (no DB calls, no UI, no flags, no service boundaries), none of the blocking guardrails apply — it's a plain `res.json` with no cross-cutting concerns.

`GET /api/health` is registered at `api/src/index.ts:16`, before the DB-dependent routes, returning `{"status":"ok"}` with HTTP 200. Done.

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
  "output_tokens": 899,
  "cache_read_input_tokens": 128666,
  "cache_creation_input_tokens": 18244,
  "total_tokens": 147817,
  "cost_usd": 0.1615728,
  "num_turns": 4
}
```
