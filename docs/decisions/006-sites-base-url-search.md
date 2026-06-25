# ADR-006: Substring Base-URL Search on `GET /sites`

## Status
Accepted

## Context
The Experience Success Studio back-office UbI ("Backoffice") Sites page let operators find a site
to manage. Its only mechanism was to **load every site** (`GET /sites`, cursor-paginated at 500/page)
into the browser and filter client-side. With ~18k sites that meant ~36 **sequential** cursor
requests (each page's cursor is only known after the previous response resolves) — a 15–22s blank
load before the table was usable. See SITES-47203.

`GET /sites` had no server-side search: only cursor pagination, an exact `GET /sites/by-base-url/:baseURL`
lookup, and an exact `GET /sites/:siteId` lookup. So "find the site whose URL contains `icici`"
forced the full client-side bulk load.

Two facts shaped the decision:

- **Cursor pagination cannot be parallelized.** You cannot issue page _N+1_ without page _N_'s
  cursor, and `GET /sites` exposes neither offset nor a total count. So the sequential walk is
  inherent — the fix is to *not load everything*, not to page faster.
- **The data layer migrated from DynamoDB to PostgreSQL (via PostgREST).** `spacecat-shared-data-access`
  now backs `Site` with PostgREST and its collection query API supports `ilike`/`like`/`contains`
  filters and offset pagination. On DynamoDB a substring search would have been a full-partition
  scan (anti-pattern); on Postgres `ILIKE '%…%'` is a normal, cheap query.

## Decision
Add an optional **`baseUrlLike`** query parameter to `GET /sites`:

`GET /sites?baseUrlLike=<substring>&limit=<N>`

- Maps to `Site.all({}, { where: (s) => s.ilike('baseURL', '%<escaped>%'), limit: N+1, order: 'asc' })`.
  No `spacecat-shared-data-access` change was required — the `ilike` `where` path already exists.
- **Validation:** `baseUrlLike` must be ≥ 3 characters (trimmed); LIKE wildcards (`%`, `_`, `\`) in
  user input are escaped so callers cannot inject wildcards.
- **Top-N + "more exists":** `limit` defaults to 50, capped at `MAX_LIMIT` (500). We fetch `N+1` rows
  and trim to `N`; the extra row drives `pagination.hasMore`, which the UI surfaces as a
  "refine your search" hint. Response shape: `{ sites: [...], pagination: { limit, hasMore } }`.
- **Authorization is unchanged** — the new branch runs after the existing admin / S2S `site:readAll`
  check. Non-admin (org-scoped) callers continue to receive `403` on `GET /sites`; the Backoffice
  client falls back to the org-scoped sites endpoint (a small, bounded set) and filters it
  client-side. The complex org/delegated-sites endpoint was intentionally left untouched.

## Alternatives considered

- **Client-side progressive rendering** (render pages as they stream in). Rejected: it only traded
  the blank spinner for ~15s of a churning, re-sorting table, and never addressed the root cause —
  shipping ~18k rows to the browser. (This was an earlier PR, since abandoned.)
- **Parallel page fetching.** Impossible: cursor pagination has no offset/total, so pages must be
  sequential. Even hypothetically, ~36 concurrent 500-row reads carry 429 / DB-load risk for
  negligible benefit.
- **Prefix-only search (`begins_with`).** This was the *DynamoDB-idiomatic* option (efficient on the
  `baseURL` sort key). It is moot now that the backend is Postgres, and substring is the better UX
  (matches anywhere, so the stored `https://`/`www.` prefix doesn't get in the way).
- **Dedicated search index (OpenSearch).** Correct for large-scale fuzzy/multi-field search, but
  heavy infrastructure and unjustified for an internal tool at this scale.

## Consequences
- The Backoffice **Sites page** drops the bulk-load (and its two rarely-used dropdown filters): it now
  searches by base-URL substring or looks a site up by exact ID. See OneAdobe/experience-success-studio-backoffice#332.
  (The legacy `getSites` bulk walk still backs `LLMOptimizerData.js` — eliminating that is tracked as a
  separate follow-up; this ADR does not address it.)
- **Deploy ordering.** The Backoffice client always sends `limit`, so an *older* API deployment would
  ignore `baseUrlLike` and return unfiltered cursor results. To avoid silent wrong results, the search
  response echoes `pagination.baseUrlLike`; the client treats a missing/mismatched echo as "search
  unsupported" and surfaces an error. Deploy the API before (or with) the Backoffice change.
- **No trigram index yet.** `base_url` has a UNIQUE btree but no `pg_trgm` GIN index, so a leading-wildcard
  `ILIKE '%…%'` is a sequential scan. At ~18k small rows this is single-digit-ms in Postgres and only
  matches cross the wire, so it is acceptable for now. **Deferred follow-up:** add
  `CREATE EXTENSION pg_trgm` + a GIN trigram index on `sites.base_url` (owned by `mysticat-data-service`)
  if/when table growth or latency warrants index-accelerated substring search.
- The contract is additive and backward-compatible: existing cursor-paginated and legacy flat-array
  behavior of `GET /sites` is unchanged.

## References
- SITES-47203
- API change: this PR (adobe/spacecat-api-service)
- Backoffice consumer: OneAdobe/experience-success-studio-backoffice#332
