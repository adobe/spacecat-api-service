# Prerender Validation Status Endpoint

- **Status:** Proposed
- **Date:** 2026-07-03
- **Jira:** LLMO-5857

## Problem

Prerender validation (verifying that edge-optimized pages serve the prerendered
content correctly) runs in an external tool (tokowaka `llmo-prerender-api`) that
loops the site's top URLs and compares S3-prerendered HTML against live
edge-rendered HTML. Today the run's outcome is not visible in SpaceCat.

The tool needs to record validation lifecycle state on the prerender
`Opportunity` so it is queryable in SpaceCat: whether validation is in progress,
and whether it succeeded, failed, or errored — along with start/end timestamps.

The generic `PATCH /sites/:siteId/opportunities/:opportunityId` endpoint
**replaces** the entire `data` object (`opportunity.setData(data)`), so an
external caller would have to read-modify-write the full `data` blob and risk
clobbering fields written by the prerender audit.

## Goals

- A dedicated endpoint that updates **only** `data.prerenderValidation`, merging
  server-side so no other `data` field is touched.
- Validate the status against a fixed enum.
- Reuse the existing opportunities controller (auth, access control, DTO).

## Non-Goals

- No orchestration, URL selection, or comparison logic (stays in the tool).
- No change to audit-worker.

## Design

New route (opportunity sub-resource):

```
PATCH /sites/:siteId/opportunities/:opportunityId/prerender-validation
```

Body:

```json
{
  "status": "in_progress | completed_success | completed_fail | error",
  "startedAt": "2026-07-03T10:00:00.000Z",   // optional ISO 8601 string or null
  "completedAt": "2026-07-03T11:40:00.000Z",  // optional ISO 8601 string or null
  "reason": "waf_block:403"                    // optional string or null
}
```

Handler (`opportunitiesController.patchPrerenderValidation`):

1. Validate `siteId` / `opportunityId` are UUIDs.
2. `Site.findById` → 404 if missing; access-control check → 403.
3. `Opportunity.findById` → 404 if missing or `siteId` mismatch.
4. Validate `status` is one of the enum values → 400 otherwise.
5. Validate `startedAt`/`completedAt`, if provided, are `null` or a full ISO 8601
   date-time string (regex-gated, then `Date.parse`-checked) → 400 otherwise.
6. Validate `reason`, if provided, is a `string` or `null` → 400 otherwise.
7. **Merge**: `setData({ ...getData(), prerenderValidation: { ...existing, status, startedAt?, completedAt?, reason } })`.
   Unlike `startedAt`/`completedAt` (only updated when the caller sends them),
   `reason` is **always** overwritten — set to `null` when absent — since it
   describes the *current* status, not something to carry over. This prevents a
   stale failure reason from a previous run leaking into a later success.
8. `save()` → 200 with the updated opportunity DTO.

The `prerenderValidation` shape stored on `opportunity.data`:

```json
{ "status": "...", "startedAt": "<ISO|null>", "completedAt": "<ISO|null>", "reason": "<string|null>" }
```

## Lifecycle (written by the tool)

- Run begins → `{ status: "in_progress", startedAt: now, completedAt: null }`
- Run ends successfully → `{ status: "completed_success", completedAt: now }` (reason cleared to `null`)
- Run ends in failure (e.g. bot/WAF block detected) → `{ status: "completed_fail", completedAt: now, reason: "waf_block:<code>" }`

## Success Criteria

- Endpoint updates only `data.prerenderValidation`; other `data` fields preserved.
- Invalid status → 400; invalid `startedAt`/`completedAt`/`reason` → 400;
  unknown site/opp → 404; unauthorized → 403.
- 100% coverage on the new controller method.
