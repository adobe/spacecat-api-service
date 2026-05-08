# Agentic Traffic Has-Data API

Fast existence check that tells the caller whether any agentic traffic records exist for a site. Used by the Postgres-backed Agentic Traffic dashboard to decide whether to show the no-data onboarding overlay — without waiting for all parallel data queries to settle.

---

## API Path

| Method | Path | Description |
|--------|------|-------------|
| GET | `/sites/:siteId/agentic-traffic/has-data` | Returns `{ hasData: boolean }` for the site |

**Path parameters:**
- `siteId` — Site UUID

---

## Query Parameters

None. No date range or filter parameters are accepted.

---

## Data Source

Single PostgREST table query with `limit(1)` — no RPC required:

```javascript
client.from('agentic_traffic')
  .select('traffic_date')
  .eq('site_id', siteId)
  .limit(1)
```

`hasData` is `true` if at least one row is returned, `false` otherwise.

---

## Response Shape

```json
{ "hasData": true }
```

| Field | Type | Description |
|-------|------|-------------|
| `hasData` | boolean | `true` if the site has any agentic traffic records, `false` otherwise |

---

## Sample URLs

```
GET /sites/c2473d89-e997-458d-a86d-b4096649c12b/agentic-traffic/has-data
```

---

## Error Responses

| Status | Condition |
|--------|-----------|
| 400 | PostgREST not configured (`DATA_SERVICE_PROVIDER` ≠ `postgres`) |
| 400 | Site or organization not found |
| 403 | User does not belong to the site's organization |
| 500 | PostgREST query error |

---

## Authentication & Access

- Requires LLMO product access for the site's organization (`hasLlmoOrganizationAccess`)
- Route is listed in `REQUIRED_CAPABILITIES`

---

## Related APIs

- [Agentic Traffic API](./agentic-traffic-api.md) — KPIs, trend, and grouping by region/category/page-type/status
- [Agentic Traffic Weeks API](./agentic-traffic-weeks-api.md) — ISO weeks with data, for the date picker
- [Agentic Traffic by URL API](./agentic-traffic-by-url-api.md) — Per-URL breakdown, user-agent breakdown, URL movers
