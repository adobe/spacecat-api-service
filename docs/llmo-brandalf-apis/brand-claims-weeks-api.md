# Brand Claims Weeks API

Lists the ISO weeks (`YYYY-Www`) for which a Brand Claims run exists for a site, newest first. Used to populate a week selector in the Brand Claims UI so a customer can view historical runs instead of only the latest one.

Unlike the Brand Presence weeks API (which derives weeks from a database execution-date range), Brand Claims runs are delivered to S3 by the Mystique `claims_extraction` pipeline and stored per ISO week at `brand_claims/llmo/{siteId}/{YYYY-Www}/data.json.gz`. This endpoint lists those week folders directly via a single `ListObjectsV2` call (`Delimiter: '/'`), so no database is involved.

---

## API Paths

| Method | Path | Description |
|--------|------|-------------|
| GET | `/sites/:siteId/llmo/brand-claims/weeks` | Available Brand Claims weeks for the site |

**Path parameters:**
- `siteId` — Site ID (UUID)

---

## Query Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | integer | `15` | Maximum number of weeks to return, newest first. Clamped to `[1, 52]`. A missing or non-numeric value falls back to the default (no 400). |

---

## Query Details

The handler lists the site prefix `brand_claims/llmo/{siteId}/` with `Delimiter: '/'` and collects the common-prefix folders that match `^\d{4}-W\d{2}$`. Because there is one folder per ISO week, the result stays far under the 1000-prefix S3 page limit (~19 years), so pagination is intentionally omitted; a truncated listing is logged as a warning. Zero-padded `YYYY-Www` sorts lexicographically, so the folders are sorted as strings descending (newest first) and then sliced to `limit`.

**Data source:** S3 bucket `S3_BUCKET_NAME` (e.g. `spacecat-prod-importer`), prefix `brand_claims/llmo/{siteId}/`.

---

## Response Shape

```json
{
  "siteId": "9ae8877a-bbf3-407d-9adb-d6a72ce3c5e3",
  "weeks": ["2026-W17", "2026-W16", "2026-W15"],
  "count": 3
}
```

- `weeks` — ISO week identifiers (`YYYY-Www`), newest first, at most `limit` entries.
- `count` — number of weeks returned (equals `weeks.length`, not the total available).

`Cache-Control: private, max-age=7200` is set (read-only endpoint).

---

## Fetching a week's data

A returned week is passed straight back to the Brand Claims fetch endpoint:

```
GET /sites/{siteId}/llmo/brand-claims?week=2026-W17
```

`?week=<YYYY-Www>` keys that week's folder directly. A `?date=<YYYY-MM-DD>` alternative (any date within the week) is also accepted; `week` wins when both are set. With no selector, the latest week is served. See the OpenAPI spec (`llmo-brand-claims`) for full details.

---

## Sample URLs

**Default (up to 15 weeks):**
```
GET /sites/9ae8877a-bbf3-407d-9adb-d6a72ce3c5e3/llmo/brand-claims/weeks
```

**Limit to the 4 most recent weeks:**
```
GET /sites/9ae8877a-bbf3-407d-9adb-d6a72ce3c5e3/llmo/brand-claims/weeks?limit=4
```

---

## Access Control

- Requires LLMO product access for the site (same `getSiteAndValidateLlmo` gate as the other `/sites/:siteId/llmo/*` read endpoints).
- The site must be resolvable and the caller must belong to its organization.

---

## Error Responses

| Status | Condition |
|--------|-----------|
| 400 | Invalid `siteId` (not a UUID) |
| 400 | S3 storage is not configured for this environment (missing client/bucket, or `NoSuchBucket`) |
| 400 | LLMO is not enabled for the site |
| 403 | Caller does not have access to the site |
| 404 | Site not found |
| 500 | Server-side S3 error (e.g. `AccessDenied`, `SlowDown`) — details logged, not returned |
| 200 | Success (`weeks` is `[]` when no runs exist yet) |

---

## Related APIs

- [Brand Presence Weeks API](brand-presence-weeks-api.md) — the analogous week selector for Brand Presence (DB-derived).
- [Agentic Traffic Weeks API](agentic-traffic-weeks-api.md) — week selector for Agentic Traffic.

---

## Authentication

Requires valid authentication (JWT, IMS, or scoped API key with `site:read`) with access to the site's organization.
