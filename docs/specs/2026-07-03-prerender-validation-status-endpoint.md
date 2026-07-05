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
  "startedAt": "2026-07-03T10:00:00.000Z",   // optional ISO string
  "completedAt": "2026-07-03T11:40:00.000Z"   // optional ISO string or null
}
```

Handler (`opportunitiesController.patchPrerenderValidation`):

1. Validate `siteId` / `opportunityId` are UUIDs.
2. `Site.findById` → 404 if missing; access-control check → 403.
3. `Opportunity.findById` → 404 if missing or `siteId` mismatch.
4. Validate `status` is one of the enum values → 400 otherwise.
5. **Merge**: `setData({ ...getData(), prerenderValidation: { ...existing, status, startedAt?, completedAt? } })`.
6. `save()` → 200 with the updated opportunity DTO.

The `prerenderValidation` shape stored on `opportunity.data`:

```json
{ "status": "...", "startedAt": "<ISO>", "completedAt": "<ISO|null>" }
```

## Lifecycle (written by the tool)

- Run begins → `{ status: "in_progress", startedAt: now, completedAt: null }`
- Run ends → `{ status: "completed_success|completed_fail|error", completedAt: now }`

## Success Criteria

- Endpoint updates only `data.prerenderValidation`; other `data` fields preserved.
- Invalid status → 400; unknown site/opp → 404; unauthorized → 403.
- 100% coverage on the new controller method.
