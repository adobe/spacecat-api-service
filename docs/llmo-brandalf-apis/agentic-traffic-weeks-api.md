# Agentic Traffic Weeks API

Returns the list of ISO weeks for which a site has agentic traffic data. Powers the `ContinuousWeekPicker` custom-weeks time range option in the Agentic Traffic UI.

The response is derived from the earliest and latest `traffic_date` in the `agentic_traffic` table for the site — two PostgREST queries in parallel — and then the full ISO week range between those dates is generated.

---

## API Path

| Method | Path | Description |
|--------|------|-------------|
| GET | `/sites/:siteId/agentic-traffic/weeks` | Available ISO weeks for the site |

**Path parameters:**
- `siteId` — Site UUID

---

## Query Parameters

None. No date range or filter parameters are accepted — this endpoint always returns all weeks for which any data exists.

---

## Data Source

Two parallel PostgREST queries against `agentic_traffic`:

```javascript
// Earliest date
client.from('agentic_traffic').select('traffic_date')
  .eq('site_id', siteId).order('traffic_date', { ascending: true }).limit(1)

// Latest date
client.from('agentic_traffic').select('traffic_date')
  .eq('site_id', siteId).order('traffic_date', { ascending: false }).limit(1)
```

The ISO weeks between `minDate` and `maxDate` (inclusive) are then generated. Each week entry includes the start (Monday) and end (Sunday) dates.

---

## Response Shape

```json
{
  "weeks": [
    {
      "week": "2026-W11",
      "startDate": "2026-03-09",
      "endDate": "2026-03-15"
    },
    {
      "week": "2026-W10",
      "startDate": "2026-03-02",
      "endDate": "2026-03-08"
    },
    {
      "week": "2026-W09",
      "startDate": "2026-02-23",
      "endDate": "2026-03-01"
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `week` | string | ISO week identifier in `YYYY-Wnn` format |
| `startDate` | string (YYYY-MM-DD) | Monday of the ISO week |
| `endDate` | string (YYYY-MM-DD) | Sunday of the ISO week |

Weeks are returned in **descending order** (most recent first). If the site has no traffic data, `weeks` is an empty array.

---

## Sample URLs

**All weeks for a site:**
```
GET /sites/c2473d89-e997-458d-a86d-b4096649c12b/agentic-traffic/weeks
```

---

## Error Responses

| Status | Condition |
|--------|-----------|
| 400 | PostgREST not configured (`DATA_SERVICE_PROVIDER` ≠ `postgres`) |
| 400 | Site or organization not found |
| 400 | PostgREST query error fetching min/max dates |
| 403 | User does not belong to the site's organization |
| 200 | No data — `weeks` will be `[]` |

---

## Authentication & Access

- Requires LLMO product access for the site's organization (`hasLlmoOrganizationAccess`)
- Route is listed in `REQUIRED_CAPABILITIES`

---

## Related APIs

- [Agentic Traffic API](./agentic-traffic-api.md) — KPIs, trend, and grouping by region/category/page-type/status
- [Agentic Traffic Filter Dimensions API](./agentic-traffic-filter-dimensions-api.md) — Available filter values
- [Brand Presence Weeks API](./brand-presence-weeks-api.md) — Equivalent weeks endpoint for Brand Presence
