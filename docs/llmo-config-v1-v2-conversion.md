# LLMO config V1 ↔ V2 conversion

V1 = site-level LLMO config (S3 per site). V2 = org-level customer config (S3 per org).  
Mapper: `src/support/customer-config-mapper.js` (`convertV1ToV2`, `convertV2ToV1`).

**Reversibility:** The conversions are bidirectional and lossless for the fields we preserve. You can switch between editing V1 (per-site) and V2 (per-org) configs seamlessly. When you save either one, the other is updated automatically so both stay in sync (see sync in `src/support/llmo-config-sync.js`). Brands in V2 must have `v1SiteId` (or matching `baseUrl`) set for their linked site so sync knows which V1 config to update.

## Preserved for round-trip (v1* fields on V2)

V1-only data with no real V2 equivalent, stashed under a v1-prefixed name so round-trip doesn’t lose it:

- **Category:** `v1CategoryUrls`, `v1Regions`
- **Brand:** `v1SiteId`, `baseUrl` (which site this brand came from; set when syncing from v1)

## Dropped in V1 → V2 (and why)

| Field | Why dropped |
|-------|-------------|
| `entities` | Never used; safe to drop. |
| `questions` | Never used; safe to drop. |
| `brands.aliases[].aliasMode` | No equivalent in v2; not used anywhere, so safe to drop. v2→v1 sets `'extend'` so v1 shape is valid. (Alias strings are carried: one v1 entry with N names → N v2 brandAlias entries.) |
