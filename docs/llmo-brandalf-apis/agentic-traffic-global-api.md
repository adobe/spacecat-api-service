# Agentic Traffic Global API

Cross-site weekly hit totals from the `agentic_traffic_global` table in mysticat-data-service. This is an admin/S2S endpoint — it is not site-scoped and does not apply per-org access filters.

- **GET** — Read weekly totals (admin or LLMO org access required)
- **POST** — Upsert a weekly total (admin or S2S consumer only)

---

## API Paths

| Method | Path | Description |
|--------|------|-------------|
| GET | `/llmo/agentic-traffic/global` | List global weekly agentic traffic totals |
| POST | `/llmo/agentic-traffic/global` | Create or update a weekly total |

---

## GET `/llmo/agentic-traffic/global`

### Query Parameters

| Parameter | Type | Constraints | Default | Description |
|-----------|------|------------|---------|-------------|
| `year` | integer | 2000–9999 | — | Filter to a specific year |
| `week` | integer | 1–53 | — | Filter to a specific ISO week number |
| `limit` | integer | 1–520 | 52 | Maximum number of rows to return |

Parameters are read from the raw query string. Non-integer values for `year`, `week`, or `limit` return 400.

Results are ordered by `year DESC, week DESC` (most recent first).

### Response

```json
[
  {
    "id": "019cb903-1184-7f92-8325-f9d1176af316",
    "year": 2026,
    "week": 11,
    "hits": 4820000,
    "createdAt": "2026-03-16T00:00:00.000Z",
    "updatedAt": "2026-03-16T08:12:34.000Z",
    "updatedBy": "spacecat-api-service"
  }
]
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | string (UUID) | Row identifier |
| `year` | number | Calendar year |
| `week` | number | ISO week number (1–53) |
| `hits` | number | Total agentic traffic hits across all sites for this week |
| `createdAt` | string (ISO 8601) | Row creation timestamp |
| `updatedAt` | string (ISO 8601) | Last update timestamp |
| `updatedBy` | string \| null | IMS user ID or `spacecat-api-service` for automated upserts |

### Access

- Requires `report:read` capability
- Valid for admins and users with LLMO organization access (`validateGlobalAgenticTrafficReadAccess`)

### Sample URLs

**Last 52 weeks (default):**
```
GET /llmo/agentic-traffic/global
```

**Specific year:**
```
GET /llmo/agentic-traffic/global?year=2026
```

**Specific week:**
```
GET /llmo/agentic-traffic/global?year=2026&week=11
```

---

## POST `/llmo/agentic-traffic/global`

Creates or updates the weekly total for a `(year, week)` pair. Uses an upsert with `ON CONFLICT (year, week)`.

### Request Body

```json
{
  "year": 2026,
  "week": 11,
  "hits": 4820000
}
```

| Field | Type | Required | Constraints | Description |
|-------|------|----------|------------|-------------|
| `year` | integer | Yes | 2000–9999 | Calendar year |
| `week` | integer | Yes | 1–53 | ISO week number |
| `hits` | integer | Yes | ≥ 0 | Total hit count for the week |

The request body must be a JSON object. Non-integer values or out-of-range values return 400.

`updatedBy` is set server-side from the authenticated user's IMS profile (`user_id` or `sub`), falling back to `spacecat-api-service`.

### Response

Returns the upserted row in the same shape as the GET response:

```json
{
  "id": "019cb903-1184-7f92-8325-f9d1176af316",
  "year": 2026,
  "week": 11,
  "hits": 4820000,
  "createdAt": "2026-03-16T00:00:00.000Z",
  "updatedAt": "2026-03-16T08:12:34.000Z",
  "updatedBy": "ABC1234@AdobeID"
}
```

### Access

- Requires `report:write` capability
- Restricted to **admins** or **S2S consumers** (`accessControlUtil.hasAdminAccess() || context.s2sConsumer`)
- Regular authenticated users receive 403

---

## Error Responses

| Status | Condition |
|--------|-----------|
| 400 | `year`, `week`, or `limit` is not a valid integer |
| 400 | `year`, `week`, or `limit` is out of range |
| 400 | Request body is missing or not a JSON object (POST) |
| 400 | `year`, `week`, or `hits` missing or invalid (POST) |
| 403 | Authenticated user is not an admin or S2S consumer (POST) |
| 403 | User does not have LLMO org access (GET) |
| 503 | PostgREST not configured (`DATA_SERVICE_PROVIDER` ≠ `postgres`) |

---

## Authentication & Access Summary

| Endpoint | Required |
|----------|----------|
| `GET /llmo/agentic-traffic/global` | `report:read` + admin or LLMO org access |
| `POST /llmo/agentic-traffic/global` | `report:write` + admin or S2S consumer |

---

## Related APIs

- [Agentic Traffic API](./agentic-traffic-api.md) — Site-scoped KPIs and breakdowns
- [Agentic Traffic by URL API](./agentic-traffic-by-url-api.md) — Per-URL breakdown, user-agent breakdown, URL movers
