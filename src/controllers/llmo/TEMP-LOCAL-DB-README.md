# TEMPORARY: Local Database Routing for URL Inspector

> **This file and the related code changes are temporary scaffolding for local
> development. Remove everything once testing is complete.**

## What This Does

When `POSTGREST_URL_LOCAL` is set in your `.env`, all URL Inspector endpoints
query your **local** PostgREST/Postgres instead of the remote CloudFront-backed
database. Every other endpoint continues to use the remote database as usual.

Affected endpoints:

- `GET /org/:spaceCatId/brands/:brandId/url-inspector/stats`
- `GET /org/:spaceCatId/brands/:brandId/url-inspector/owned-urls`
- `GET /org/:spaceCatId/brands/:brandId/url-inspector/trending-urls`
- `GET /org/:spaceCatId/brands/:brandId/url-inspector/cited-domains`
- `GET /org/:spaceCatId/brands/:brandId/url-inspector/url-details`
- `GET /org/:spaceCatId/brands/:brandId/url-inspector/domain-details`
- `GET /org/:spaceCatId/brands/:brandId/url-inspector/filter-options`

## How to Use

### 1. Start the local database

```bash
cd mysticat-data-service
make setup        # starts Postgres + PostgREST and runs migrations + seeds
```

Verify PostgREST is up (the Docker container maps internal port 3000 to **host
port 4000**):

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:4000/
# Should print 200
```

### 2. Configure spacecat-api-service

Add these two lines to your **`.env`** (they are already there if you set them
up previously — just make sure the port matches):

```bash
# TEMP: Local DB routing
POSTGREST_URL_LOCAL=http://localhost:4000
POSTGREST_API_KEY_LOCAL=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoicG9zdGdyZXN0X3dyaXRlciJ9.qEUB9zeY8WHpgyyRRBgs5th4WY98pJfUudtCwImM4H4
```

> **Tip:** To switch back to the remote database without removing the lines,
> just comment them out:
>
> ```bash
> # POSTGREST_URL_LOCAL=http://localhost:4000
> # POSTGREST_API_KEY_LOCAL=...
> ```

### 3. Start the API service

```bash
cd spacecat-api-service
npm start
```

You should see this log line on startup, confirming the local client is active:

```
TEMP: Local PostgREST client initialized for URL Inspector
```

### 4. Verify it works

Hit any URL Inspector endpoint. For example:

```bash
curl 'http://localhost:3002/org/<orgId>/brands/all/url-inspector/stats?siteId=<siteId>&startDate=2026-02-16&endDate=2026-03-08' \
  -H 'Authorization: Bearer <your-jwt>'
```

## Files Modified

All temporary code is marked with `// TEMP: Local DB routing` comments.

| File | What changed |
|------|-------------|
| `src/support/data-access.js` | Creates a second `PostgrestClient` when `POSTGREST_URL_LOCAL` is set and attaches it to `context.localPostgrestClient` |
| `src/controllers/llmo/llmo-url-inspector.js` | Prefers `context.localPostgrestClient` over `Site.postgrestService` for the URL Inspector client |
| `.env` *(local only)* | Two new env vars: `POSTGREST_URL_LOCAL`, `POSTGREST_API_KEY_LOCAL` |

## How to Remove (When Done)

### 1. Find all temporary code

```bash
git grep "TEMP: Local DB routing"
```

### 2. Remove from `src/support/data-access.js`

- Delete the `import { PostgrestClient }` line and its TEMP comments
- Delete the entire `const wrappedFn = ...` block (including the `if (env.POSTGREST_URL_LOCAL)` block inside it)
- Change `return dataAccessV3(wrappedFn)(request, context);` back to `return dataAccessV3(fn)(request, context);`

### 3. Remove from `src/controllers/llmo/llmo-url-inspector.js`

- Change line 49 from:
  ```js
  const client = context.localPostgrestClient || Site?.postgrestService;
  ```
  back to:
  ```js
  const client = Site?.postgrestService;
  ```
- Delete the `// TEMP` and `// END TEMP` comment lines around it

### 4. Remove from `.env`

Delete these lines:

```bash
# TEMP: Local DB routing
POSTGREST_URL_LOCAL=http://localhost:4000
POSTGREST_API_KEY_LOCAL=...
```

### 5. Delete this file

```bash
rm src/controllers/llmo/TEMP-LOCAL-DB-README.md
```

### 6. Verify clean removal

```bash
git grep "TEMP: Local DB routing"   # should return nothing
git grep "localPostgrestClient"      # should return nothing
```
