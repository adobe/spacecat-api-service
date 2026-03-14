# Onboarding Compatibility with Mysticat Blackboard

Research date: 2026-03-11

## Context

LLMO and ASO onboarding commands in spacecat-api-service create sites/orgs and trigger
initial audits. As individual audits migrate from the legacy stack (spacecat-audit-worker)
to mysticat's blackboard (fact-based producers), we need to understand compatibility.

**Terminology:** Mysticat is the product/platform name. Mystique is the service/codebase
that implements the blackboard (fact-based audit system). This document uses "blackboard"
to refer to the Mystique-powered audit execution engine.

**Key insight:** Migration is per-audit, not per-site. A site can have some audits running
on legacy and others on the blackboard simultaneously. Sites exist in a shared Aurora
database independent of which stack executes their audits.

## Architecture Overview

### Shared Data Layer

Both stacks share the same Aurora PostgreSQL database (owned by mysticat-data-service):

```
Aurora (shared):
  sites.id (UUID)            -- SpaceCat site, primary entity
  sites.base_url             -- Canonical URL
  organizations.id           -- Multi-tenant container
  organizations.ims_org_id   -- Adobe IMS org
  entitlements               -- Product code + tier
  site_enrollments           -- Links sites to entitlements
```

### Blackboard-Specific Tables

The blackboard adds its own tables in the same database:

```
Blackboard (mystique-owned):
  control_site_config        -- Scan scheduling, overrides, v2_migrated flag
  control_tier_definition    -- Product/tier goal configs (composite PK: product_code, tier)
  control_scan               -- Scan execution records
  facts                      -- Observations, derived, assertions (scope: org/site/page)
  fact_dependencies          -- DAG edges for cascade
```

### Site Identity

The blackboard uses SpaceCat's `site.id` (UUID as string) as its primary site reference.
No separate identifier. `control_site_config.site_id` IS the Aurora `sites.id`.

### Per-Audit Migration via Goal Configs

Migration is controlled per-goal (not per-site) through `TierDefinition.goal_configs`:

```json
[
  {"key": "a_broken_links", "enabled": true, "page_limit": 50},
  {"key": "d_cwv", "enabled": true},
  {"key": "a_seo_opportunities", "enabled": false}
]
```

The `v2_migrated` flag on `SiteConfig` is site-level gating only - it controls whether
the blackboard scheduler picks up the site at all. Individual goals are enabled/disabled
within the tier definition.

### Goal Selection Cascade

```
TierDefinition.goal_configs  (per product_code + tier, defaults)
  -> SiteConfig.goal_overrides  (per-site, not yet implemented)
    -> ScanRequest.goal_overrides  (per-scan API overrides)
      = effective goals to execute
```

`ExecutionPlanBuilder` walks the DAG from goal facts backwards, collects dependencies,
checks the producer registry, and topologically sorts. Only facts with registered
producers execute.

## What Works (No Changes Needed)

See [Compatibility Analysis](#compatibility-analysis) below for the full compatibility matrix.

## Legacy Dispatch Pipeline (spacecat-jobs-dispatcher)

Understanding the full legacy pipeline is critical because onboarding plugs into it:

```
EventBridge (cron)
  -> spacecat-jobs-dispatcher (Lambda)
    -> Configuration.findLatest() (DynamoDB)
    -> For each job matching interval:
      -> configuration.isHandlerEnabledForSite(auditType, site)
      -> If enabled AND not sandbox: send SQS message
        -> { type: auditType, siteId: site.getId() }
  -> spacecat-audit-worker (SQS consumer)
    -> Executes audit, stores in LatestAudit
```

### How onboarding connects

1. Onboarding calls `configuration.enableHandlerForSite(auditType, site)` - writes to
   DynamoDB Configuration model
2. Jobs-dispatcher calls `Configuration.findLatest()` on every invocation (no caching)
3. Audits handler calls `isHandlerEnabledForSite(auditType, site)` per site
4. If enabled, dispatches SQS message to audits queue
5. Audit workers consume and execute

### Key details

- **Trigger**: AWS EventBridge rules, one per interval (45 intervals: daily, weekly, etc.)
- **Fan-out**: One SQS message per (auditType, siteId) pair
- **Queue routing**: By job group (audits, scrapes, reports, imports), not per audit type
- **Handler types**: Different enablement checks per handler:
  - Audits: `isHandlerEnabledForSite(type, site)` - binary per site
  - Imports: `site.getConfig().getImports()` - from site config
  - Reports: `isHandlerEnabledForSite` or `isHandlerEnabledForOrg`
  - Scrapes: `getEnabledSiteIdsForHandler(type)` - array of site IDs
- **Immediate triggers**: Onboarding ALSO sends direct SQS messages for initial audits
  (doesn't wait for next cron cycle)

### Compatibility implication

The jobs-dispatcher is the **ongoing scheduling mechanism** for legacy audits. It's
separate from onboarding's initial SQS triggers but uses the same Configuration model.

When an audit type migrates to the blackboard:
- Its handler is removed from `spacecat-audit-worker`'s `HANDLERS` registry
- The audit worker returns 404 + error log for that type (SQS retries exhaust, hits DLQ)
- The blackboard's control service runs it independently on its own schedule
- The audit type remains "enabled" in the Configuration model (onboarding still writes it)

This is **noisy but not broken** for scheduled dispatch. The real gap is the **timing of
initial audits** - onboarding expects immediate execution, but the blackboard runs on
its own schedule.

## Blackboard Control API (On-Demand Scans)

The Control API provides on-demand scan triggering that can solve the timing gap:

### Scan endpoints

| Endpoint | Method | Response | Use case |
|----------|--------|----------|----------|
| `/v1/control/sites/{site_id}/scan` | POST | 202 + scan_id | Single site (onboarding) |
| `/v1/control/tiers/{tier_id}/scan` | POST | 200 + stats | All sites in tier |
| `/v1/control/tenants/{org_id}/scan` | POST | 200 + stats | All sites in org |

### Scan request options

```json
{
  "page_limit": 50,
  "skip_observations": false,
  "force_recompute": false,
  "goal_overrides": {
    "d_cwv": {"enabled": true},
    "a_seo_opportunities": {"enabled": false}
  }
}
```

Plus query param: `?force_facts=d_cwv&force_facts=d_canonical_status`

### Key behaviors

- **Does NOT require SiteConfig** - scan endpoint reads site from Aurora directly
- **Does NOT check v2_migrated** - any site in Aurora can be scanned on demand
- **Async** - returns 202 immediately, scan runs in background
- **Poll for status** - `GET /v1/control/scans/{scan_id}`
- **Goal overrides** - can specify exactly which goals/facts to compute

### Authentication (current limitation)

The Control API uses **Okta OIDC** (browser session cookies) for all routes:

| Mechanism | Status | Notes |
|-----------|--------|-------|
| Okta OIDC session | Production | Browser-based, not suitable for service-to-service |
| API key | Not implemented | No API key auth path exists |
| JWT / service account | Not implemented | No service-to-service auth |
| Auth disabled | Dev only | `AUTH_ENABLED=false` env var |

**This is the primary blocker for spacecat-api-service calling the Control API.**
Service-to-service auth needs to be added to the Control API before onboarding can
trigger blackboard scans programmatically.

Options to resolve:
1. **Add API key auth** to Control API (preferred - matches SpaceCat patterns)
2. **Add JWT/service account** support to Control API
3. **Shared SQS queue** - Control API consumes scan-request messages (avoids HTTP auth)
4. **Direct DB write** - NOT RECOMMENDED. spacecat-api-service writes to control tables
   directly. Bypasses Mystique validation logic, creates dual-writer risk (two services
   owning the same tables), and expands the attack surface by requiring direct DB
   credentials in spacecat-api-service

## Compatibility Analysis

### What works today (no changes needed)

| Concern | Status | Why |
|---------|--------|-----|
| Org/Site creation | OK | Both stacks read from shared Aurora |
| Entitlement + SiteEnrollment | OK | Product code + tier used by both stacks |
| DRS (llmo-data-retrieval) | OK | Reads site config via SpaceCat API, no audit dependency |
| Site config fields | OK | Stored on SpaceCat site document |
| Brand profile agent | OK | Runs via Step Functions, independent |
| Legacy audit enablement | OK | Harmless for migrated types (worker 404s, DLQ absorbs) |
| Jobs-dispatcher scheduling | OK | Harmless for migrated types (same 404/DLQ behavior) |

### What's noisy but functional

| Concern | Impact | Mitigation |
|---------|--------|------------|
| SQS messages for migrated types | Worker 404s, DLQ noise | Remove handler from dispatcher job list when migrated |
| Configuration enablement for migrated types | Writes to unused config | Harmless, can clean up later |

### What's actually broken

**1. Timing gap: onboarding expects immediate initial audits**

Onboarding sends SQS messages for immediate audit execution. For migrated types, the
audit worker 404s and nothing runs. The blackboard only runs audits on its own schedule
(via SiteScheduler cron or manual scan-now).

**Solution:** After onboarding, call `POST /v1/control/sites/{site_id}/scan` with
`goal_overrides` specifying only the migrated goals. This triggers immediate execution.

**Blocker:** Control API lacks service-to-service auth (see above).

**2. Ongoing scheduling for migrated types**

The blackboard's SiteScheduler only picks up sites with a `control_site_config` row
where `v2_migrated=true`. For newly onboarded sites, this row doesn't exist.

However, the scan-now endpoint does NOT require SiteConfig - it reads directly from
Aurora. So immediate scans work without SiteConfig, but scheduled ongoing scans don't.

**Solution:** Either:
- Create `control_site_config` during onboarding (requires Control API auth)
- Have the blackboard auto-create SiteConfig on first scan-now
- Pre-create SiteConfig rows for all sites via migration script

**3. Audit type to goal key mapping**

Legacy audit types (e.g., `broken-backlinks`) don't match blackboard goal keys (e.g.,
`d_verified_broken_backlinks`). Onboarding needs a mapping to know which `goal_overrides`
to pass when calling scan-now.

**Known mappings** (partial):
| Legacy Audit Type | Blackboard Goal/Fact(s) |
|-------------------|--------------------|
| cwv | d_cwv, a_cwv_recommendations |
| canonical | d_canonical_status |
| broken-backlinks | d_verified_broken_backlinks |
| scrape-top-pages | o_html, o_sitemap |
| headings | d_heading_structure |

**Impact:** Mapping needed for targeted scan-now calls. Without it, onboarding would
need to trigger a full scan (all goals) which may be heavier than needed.

**4. ASO Step Functions workflow depends on opportunity projections**

The ASO onboarding flow starts a Step Functions workflow (step 10) after triggering
initial audits. The `opportunity-status-processor` waits for a configurable period
(`WORKFLOW_WAIT_TIME_IN_SECONDS`), then checks for opportunities via
`site.getOpportunities()`. It maps audit types to expected opportunity types (e.g.,
cwv -> [cwv], forms-opportunities -> [form-accessibility, forms-opportunities]) and
also checks external dependencies (RUM, AHREFS, Scraping, GSC).

In the blackboard architecture, opportunities come from the projector service
(`mysticat-projector-service`) rather than from LatestAudit. If projector timing
differs from legacy audit timing, this processor may time out or report false
"missing opportunities."

The other three processors (`disable-import-audit-processor`, `demo-url-processor`,
`cwv-demo-suggestions-processor`) have no audit result dependency and are unaffected.

**Solution:** Ensure the projector service completes its fact-to-opportunity projection
within the configured `WORKFLOW_WAIT_TIME_IN_SECONDS`. If blackboard scans take longer
than legacy audits, the wait time may need to be increased.

### Audit Result Storage Compatibility

**LatestAudit no longer exists in the blackboard architecture.** The blackboard uses a
CQRS (Command Query Responsibility Segregation) pattern:

- **Write model:** Blackboard writes exclusively to `blackboard_fact` table (JSONB facts).
  Facts are the system of record.
- **Read model:** A separate projector service (`mysticat-projector-service`, TypeScript
  Lambda) listens to fact events via SNS/SQS and projects them into typed tables:
  - `projection_opportunity` - scoped by site/brand, typed by opportunity type
    (h1_optimization, broken_links, etc.), lifecycle status (active/resolved)
  - `projection_suggestion` - linked to opportunity, deterministic key, data/guidance/autofix
    as namespaced JSONB
  - `projection_lineage` - tracks which facts contributed to which suggestions
- **No LatestAudit write path exists** - there is no sync or fallback from facts to
  LatestAudit. The projector is the mandatory bridge.

**Legacy consumers that must migrate:**
- Slack `run-audit` / `site-info` commands - currently display LatestAudit results
- `opportunity-status-processor` (Step Functions) - checks for opportunities after
  ASO onboarding (already reads via `site.getOpportunities()`, but timing may change)
- Opportunity/suggestion pipeline - must read from projection tables instead
- LLMO dashboards - must read from projection tables instead

**Impact:** This is a significant migration concern. All consumers reading LatestAudit
need to be updated to read from the projection tables for migrated audit types. During
the transition period, consumers may need dual-read logic (LatestAudit for legacy types,
projection tables for blackboard types).

### What's low risk

| Concern | Risk | Notes |
|---------|------|-------|
| Brand scope hierarchy (LLMO) | Low | Blackboard producers can read brand from site config |
| SiteConfig discovery_method | Low | Scan-now doesn't need it; only scheduled scans do |

## DRS Integration (Two Independent Systems)

### Mystique DRS (blackboard-internal)

- `RealDRS` adapter submits scrape jobs, polls for completion, reads S3 results
- Control service triggers DRS via cascade policies (fact.* events)
- `ObservationBridge` converts DRS results into facts (o_html, o_markdown, etc.)
- `DRSJobPoller` uses SKIP LOCKED for HA-safe async polling
- Phase 1: submit jobs (status=waiting_drs), Phase 2: read S3 + store facts

### LLMO DRS (llmo-data-retrieval-service)

- Completely independent - ZERO imports of blackboard/mysticat code
- Has its own EventBridge-based scheduling (DynamoDB schedules table)
- Integration is entirely metadata-driven (SNS/SQS events + S3)
- Reads site config via SpaceCat API REST - safe regardless of audit stack
- No awareness of cascade policies, facts, or blackboard scheduling

**Key:** These are separate systems. Blackboard migration does not affect
llmo-data-retrieval-service as long as the SpaceCat API contract stays stable.

## Onboarding Flows

### LLMO (POST /llmo/onboard)

Source: `src/controllers/llmo/llmo-onboarding.js`

1. Create/find org by IMS Org ID
2. Create/find site by base URL
3. Create LLMO entitlement + enrollment (FREE_TRIAL)
4. Copy SharePoint template files
5. Update helix-query.yaml in GitHub
6. Enable audits: scrape-top-pages, headings, llm-blocked, canonical, hreflang,
   summarization, prerender, llm-error-pages, llmo-customer-analysis, wikipedia-analysis
7. Enable import: top-pages
8. Set site config: llmoBrand, llmoDataFolder, fetchConfig
9. Enqueue audit triggers to SQS (includes `trigger:llmo-onboarding-publish` sent to
   audits queue - note: this handler may not exist in spacecat-audit-worker; verify
   before assuming it runs)
10. Submit DRS prompt generation (non-blocking)

**Notes:**
- `llmo-customer-analysis` is enabled (step 6) but NOT triggered in step 9. It runs only
  after DRS prompt generation completes (triggered via SNS -> audit-worker, LLMO-1819)
- `brand-profile` agent is triggered by the Slack modal handler (`onboard-llmo-modal.js`)
  or the ASO controller wrapper, not by `performLlmoOnboarding` itself

### ASO (Slack /onboard site)

Source: `src/support/utils.js` (onboardSingleSite). See also [docs/onboard-workflow.md](onboard-workflow.md)
for the full onboarding workflow diagram.

1. Create/find site and org
2. Create ASO entitlement + enrollment (configurable tier)
3. Create/assign project
4. Set language, region, canonical URL
5. Enable imports from profile (traffic-analysis, rum-analytics, etc.)
6. Trigger import runs via SQS
7. Enable audits from profile (apex, cwv, canonical, etc.)
8. Trigger audit runs via SQS
9. Trigger brand-profile agent (non-blocking)
10. Start Step Functions workflow (`ONBOARD_WORKFLOW_STATE_MACHINE_ARN`) with four
    post-onboarding processors:
    - `opportunity-status-processor` - waits for audits to complete, then checks for
      expected opportunities via `site.getOpportunities()`. Maps audit types to expected
      opportunity types. Also checks external dependencies (RUM, AHREFS, Scraping, GSC).
      Compatibility concern: relies on opportunity projections (see issue #4 above).
    - `disable-import-audit-processor` - disables imports and audits that were enabled
      during onboarding (for non-scheduled runs). Prevents ongoing resource consumption.
    - `demo-url-processor` - generates Experience Cloud demo URL for the onboarded site.
    - `cwv-demo-suggestions-processor` - adds generic CWV suggestions to opportunities.
    - All processors run after a configurable wait time (`WORKFLOW_WAIT_TIME_IN_SECONDS`)

## Migration Path

### Prerequisites (blackboard team)

1. **Add service-to-service auth to Control API** - API key or JWT support so
   spacecat-api-service can call scan endpoints programmatically
2. **Pre-seed TierDefinitions** for LLMO and ASO product/tier combos with appropriate
   goal_configs
3. **Publish audit-type-to-goal mapping** - authoritative mapping from legacy audit type
   strings to blackboard goal keys

### Phase 1: Service-to-service auth + onboarding triggers blackboard scans

**Prerequisite: Add s2s auth to Control API** before any audit migration.

1. Maintain a mapping of `auditType -> goalKeys[]` (e.g., `cwv -> [d_cwv, a_cwv_recommendations]`)
2. During onboarding, for each audit type being enabled:
   - If type is in legacy list: send SQS message (existing behavior)
   - If type is in blackboard list: collect its goal keys
3. After all types processed, call `POST /v1/control/sites/{site_id}/scan` with
   `goal_overrides` containing only the collected blackboard goals
4. Scan-now does NOT require SiteConfig - it reads from Aurora directly

```js
// Pseudocode for onboarding
// NOTE: BLACKBOARD_MAPPING must be resolved before implementation. The authoritative
// mapping from legacy audit types to blackboard goal keys does not exist yet - it needs
// to be published by the blackboard team (see Open Questions #3).
const legacyTypes = [];
const blackboardGoals = {};

for (const auditType of enabledAudits) {
  if (BLACKBOARD_MAPPING[auditType]) {
    for (const goal of BLACKBOARD_MAPPING[auditType]) {
      blackboardGoals[goal] = { enabled: true };
    }
  } else {
    legacyTypes.push(auditType);
  }
}

// Legacy path (unchanged)
for (const type of legacyTypes) {
  await sqs.sendMessage(auditsQueue, { type, siteId });
}

// Blackboard path (new)
if (Object.keys(blackboardGoals).length > 0) {
  await controlApi.post(`/v1/control/sites/${siteId}/scan`, {
    goal_overrides: blackboardGoals
  });
}
```

### Phase 2: Make legacy pipeline resilient

When an audit type migrates to the blackboard:
1. Remove its handler from `spacecat-audit-worker`'s HANDLERS registry
2. Optionally remove it from jobs-dispatcher job list (reduces DLQ noise)
3. The Slack "run audit" command should gracefully handle migrated types (redirect
   to scan-now, or inform user the audit runs on the blackboard)

### Phase 3: Ongoing scheduling (when ready)

For sites that need scheduled blackboard scans (not just on-demand):
1. Create `control_site_config` during onboarding via Control API
2. Set `v2_migrated=true` so SiteScheduler picks it up
3. Or: have the blackboard auto-create SiteConfig on first scan-now request

The immediate timing gap is solved by Phase 1. The blackboard scheduler handles
ongoing runs once SiteConfig exists.

## Credential Lifecycle

When spacecat-api-service gains service-to-service access to the Control API, the
credential lifecycle must be managed:

- **Storage**: API keys or service account credentials stored in AWS Secrets Manager
  (SpaceCat pattern) or HashiCorp Vault (Adobe standard). Must not be committed to
  source code or environment variables directly.
- **Scope**: Credentials should be scoped to scan-triggering operations only (POST
  to scan endpoints). No broader Control API access (e.g., tier management, site config
  modification) should be granted.
- **Rotation cadence**: Follow Adobe security policy for key rotation. API keys should
  have an expiration and be rotatable without service downtime (e.g., support two active
  keys during rotation window).
- **Ownership**: The credential is owned by the spacecat-api-service team. The Control
  API team provisions the credential; the consumer team manages rotation and storage.

## Open Questions

1. **Auth mechanism** - What's the preferred service-to-service auth for Control API?
   API key (matches SpaceCat patterns) vs JWT vs shared SQS queue?
2. **Mapping ownership** - Should the audit-type-to-goal mapping live in spacecat-api-service
   (consumer), mystique (producer), or spacecat-shared (shared)?
3. **SiteConfig auto-creation** - Should `POST /sites/{site_id}/scan` auto-create a
   SiteConfig from Aurora data if one doesn't exist? This would simplify onboarding.
4. **TierDefinition seeding** - When will LLMO/ASO tier definitions be created?
5. **Slack "run audit" command** - Should it also learn to call scan-now for migrated types?
6. **DLQ noise tolerance** - Is it acceptable to leave migrated types in the dispatcher
   job list (worker 404s + DLQ), or should they be cleaned up proactively?
