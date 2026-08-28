#!/usr/bin/env node
/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

/* eslint-disable no-console */

/**
 * LLMO-7218 (AC5-AC7): fleet-wide idempotent reconciliation for the three recurring
 * prompt-suggestion pipelines (`prompt_generation_semrush`, `prompt_generation_agentic_traffic`,
 * `prompt_generation_synthetic_personas`) on every PAID LLMO site with an active Brand V2 brand.
 *
 * Onboarding, brand activation, and the trial->paid admin reaction (src/support/
 * prompt-suggestion-schedules.js) already provision these schedules as best-effort side-effects,
 * but a best-effort call can fail silently (DRS unavailable, a race, a pre-existing brand that
 * predates one of those call sites) and nothing self-heals — this is the fleet-wide backfill
 * named as a follow-up directly in that module's own docstring and in
 * src/controllers/llmo/prompt-suggestion-schedules.js's docstring ("a reconciler that backfills
 * PAID LLMO sites missing schedules").
 *
 * Scope (tier contract, see LLMO-7218 description):
 *   - "PAID Brand V2 and an active brand" = the site's current LLMO entitlement tier is PAID
 *     AND it has exactly one active, v2-onboarded brand (brands.site_id set, status='active') —
 *     resolved via the same getBrandBySite() the rest of the codebase uses (brands-storage.js),
 *     so this script's notion of "the active brand for a site" cannot drift from the app's own.
 *   - FREE_TRIAL / site-only sites are out of scope entirely (no site enumeration touches them).
 *   - This script NEVER creates a general DRS Brand Presence schedule: it only ever calls
 *     registerPromptSuggestionSchedule(), which hardcodes `enableBrandPresence: false` for
 *     every one of the three pipelines. That constraint holds by construction, not by any
 *     check added here.
 *   - A brand with no Semrush (sub-)workspace provisioned is NOT skipped or worked around here —
 *     its prompt-suggestion schedules are still reconciled normally, but the gap is reported
 *     separately (`semrushProvisioningIncomplete` in the summary) so it can be triaged on its
 *     own, per the ticket's "reported separately rather than bypassed" requirement.
 *
 * Detection-before-creation: for each in-scope site this script first reads DRS's own
 * `GET /schedules?site_id=<id>` (a plain authenticated GET, no client-side library call needed —
 * @adobe/spacecat-shared-drs-client has no read method for this) to find which of the three
 * provider_ids already have a schedule row, and only calls the idempotent
 * registerPromptSuggestionSchedule() for pipelines confirmed missing. This makes --dry-run a
 * real read-only report (accurate down to which pipeline is missing per site) rather than a
 * blind re-POST, and avoids needless load on DRS for the (expected to be large) majority of
 * sites that are already fully provisioned.
 *
 * Usage:
 *   POSTGREST_URL=<url> DRS_API_URL=<url> DRS_API_KEY=<key> \
 *     node scripts/reconcile-prompt-suggestion-schedules.mjs [options]
 *
 * Options:
 *   --execute            Actually create missing schedules. Default is a dry run: sites and
 *                         their missing pipelines are reported, nothing is written anywhere.
 *   --site-id UUID[,UUID...]
 *                         Only reconcile these site(s) (comma-separated). Useful to verify a
 *                         single site before a fleet-wide --execute run.
 *   --page-size N         Site.allByEnrollmentFiltered page size (default 200).
 *   --rate-limit-ms N     Sleep between sites, to keep the DRS GET/POST rate bounded on a large
 *                         fleet (default 100).
 *
 * Exit status:
 *   0  No unexpected failure (a site with no active brand, or already fully provisioned, is not
 *      a failure — it is the expected steady state this script converges toward).
 *   1  At least one unexpected failure, or a bad invocation.
 *
 * Get POSTGREST_URL / DRS_API_URL / DRS_API_KEY from the target env's Lambda configuration, same
 * as the other scripts in this directory:
 *   aws lambda get-function-configuration --function-name spacecat-api-service-<env> \
 *     --query 'Environment.Variables.[POSTGREST_URL,DRS_API_URL,DRS_API_KEY]'
 */

import { createDataAccess } from '@adobe/spacecat-shared-data-access';
import DrsClient from '@adobe/spacecat-shared-drs-client';
import { parseArgs } from 'node:util';
import { env, exit } from 'node:process';
import { getBrandBySite } from '../src/support/brands-storage.js';
import {
  PROMPT_SUGGESTION_PIPELINES,
  registerPromptSuggestionSchedule,
} from '../src/support/prompt-suggestion-schedules.js';

const DEFAULT_PAGE_SIZE = 200;
const DEFAULT_RATE_LIMIT_MS = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    execute: { type: 'boolean', default: false },
    'site-id': { type: 'string' },
    'page-size': { type: 'string' },
    'rate-limit-ms': { type: 'string' },
  },
});

function parseNumericOption(flag, raw, fallback, min) {
  if (raw === undefined) {
    return fallback;
  }
  const n = Number(raw);
  if (Number.isNaN(n) || n < min) {
    console.error(`ERROR: ${flag} must be a number >= ${min}, got "${raw}"`);
    exit(1);
  }
  return n;
}

const { execute } = values;
// page-size must be positive (a paginated query with a non-positive limit is nonsensical);
// rate-limit-ms may be 0 (an operator deliberately choosing no throttle), but not negative.
const pageSize = parseNumericOption('--page-size', values['page-size'], DEFAULT_PAGE_SIZE, 1);
const rateLimitMs = parseNumericOption('--rate-limit-ms', values['rate-limit-ms'], DEFAULT_RATE_LIMIT_MS, 0);
const siteIdFilter = values['site-id']
  ? new Set(values['site-id'].split(',').map((s) => s.trim()).filter(Boolean))
  : null;
if (siteIdFilter) {
  for (const id of siteIdFilter) {
    if (!UUID_RE.test(id)) {
      console.error(`ERROR: --site-id must be a UUID, got "${id}"`);
      exit(1);
    }
  }
}
if (!env.POSTGREST_URL) {
  console.error('ERROR: POSTGREST_URL is required');
  exit(1);
}
if (!env.DRS_API_URL || !env.DRS_API_KEY) {
  console.error('ERROR: DRS_API_URL and DRS_API_KEY are required');
  exit(1);
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
const log = console;
const dataAccess = createDataAccess({
  postgrestUrl: env.POSTGREST_URL,
  postgrestSchema: env.POSTGREST_SCHEMA,
  postgrestApiKey: env.POSTGREST_API_KEY,
}, log);
const { postgrestClient } = dataAccess.services;
const drsClient = DrsClient.createFrom({ env, log });
if (!drsClient.isConfigured()) {
  // registerPromptSuggestionSchedule silently no-ops (returns null, logs at DEBUG) when the
  // client considers itself unconfigured — without this gate, a malformed DRS_API_URL/KEY would
  // make an --execute run report "0 failures, 0 created" for the whole fleet, indistinguishable
  // from a genuinely fully-provisioned one. Delegate to the client's own canonical check rather
  // than re-deriving it from the raw env vars above, so this can't drift if isConfigured()'s
  // definition ever changes.
  console.error('ERROR: DRS client not configured (check DRS_API_URL/DRS_API_KEY)');
  exit(1);
}

const sleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

/**
 * Reads DRS's own schedule list for a site and returns the set of provider_ids that already
 * have a schedule row (any status), so callers can compute exactly which of the three
 * prompt-suggestion pipelines are missing without calling the (mutating) createSchedule path.
 * Not exposed by @adobe/spacecat-shared-drs-client, so this issues the same authenticated GET
 * the client's own private #request would (x-api-key header, JSON body) directly.
 * @param {string} siteId
 * @returns {Promise<Set<string>>}
 */
async function fetchExistingProviderIds(siteId) {
  const base = env.DRS_API_URL.replace(/\/+$/, '');
  const response = await fetch(`${base}/schedules?site_id=${siteId}`, {
    headers: { 'x-api-key': env.DRS_API_KEY },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    // Truncated: this is an ops script whose output an operator is likely to paste into a
    // ticket or Slack thread, so an unexpectedly verbose DRS error body should not ride along
    // unbounded.
    const body = (await response.text()).slice(0, 500);
    throw new Error(`DRS GET /schedules?site_id=${siteId} failed: ${response.status} - ${body}`);
  }
  const { schedules } = await response.json();
  // Fail loudly on an unexpected response shape rather than silently treating it as "no
  // schedules exist" — that would make a dry run under-report and an --execute run blindly
  // re-create schedules that already exist (harmless per createSchedule's own idempotency, but
  // it would silently defeat the whole point of reading first).
  if (!Array.isArray(schedules)) {
    throw new Error(`DRS GET /schedules?site_id=${siteId} returned an unexpected shape (schedules is not an array)`);
  }
  const existing = new Set();
  for (const schedule of schedules) {
    for (const providerId of schedule.provider_ids ?? []) {
      existing.add(providerId);
    }
  }
  return existing;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
const totals = {
  sitesScanned: 0,
  sitesSkippedNoActiveBrand: 0,
  sitesFullyProvisioned: 0,
  sitesReconciled: 0,
  schedulesCreated: 0,
  schedulesAlreadyExisted: 0,
  failures: 0,
};
const semrushProvisioningIncomplete = [];
// Per-site failure detail, so a run summary can point at exactly which sites need a targeted
// --site-id retry instead of only reporting a bare count.
const failedSites = [];
// Heartbeat cadence for a long fleet-wide sweep: sites with nothing to report (the expected
// steady-state majority once the backfill converges) otherwise produce zero log output, making
// a live run indistinguishable from a hung one over a long stretch.
const HEARTBEAT_EVERY = 100;

/**
 * Reconciles one site: resolves its active Brand-V2 brand (if any), reads DRS's current
 * schedule state, and — in --execute mode — creates whichever of the three prompt-suggestion
 * pipelines are missing. Mutates `totals` / `semrushProvisioningIncomplete` / `failedSites`
 * directly; every exit path (early return or the catch) runs through here, which is what lets
 * the caller apply `rateLimitMs` uniformly after every site that actually made a DB/DRS call.
 * @param {object} site - SpaceCat Site model instance.
 * @returns {Promise<void>}
 */
async function reconcileSite(site) {
  const siteId = site.getId();
  totals.sitesScanned += 1;
  if (totals.sitesScanned % HEARTBEAT_EVERY === 0) {
    log.info(`... progress: ${totals.sitesScanned} sites scanned so far`);
  }
  const organizationId = site.getOrganizationId();

  try {
    const brand = await getBrandBySite(organizationId, siteId, postgrestClient, log);
    if (!brand) {
      totals.sitesSkippedNoActiveBrand += 1;
      return;
    }
    if (!brand.semrushSubWorkspaceId) {
      // Reported, never bypassed: this brand still gets its prompt-suggestion schedules
      // reconciled below exactly like any other in-scope brand.
      semrushProvisioningIncomplete.push({ siteId, brandId: brand.id, brandName: brand.name });
    }

    const existingProviderIds = await fetchExistingProviderIds(siteId);
    const missingPipelines = PROMPT_SUGGESTION_PIPELINES
      .filter((p) => !existingProviderIds.has(p.providerId));

    if (missingPipelines.length === 0) {
      totals.sitesFullyProvisioned += 1;
      return;
    }

    totals.sitesReconciled += 1;
    log.info(`site=${siteId} brand=${brand.id} missing=[${missingPipelines.map((p) => p.providerId).join(', ')}]`);

    if (execute) {
      // Up to 3 sequential POSTs per site (one per missing pipeline), each with
      // triggerImmediately: true (hardcoded in registerPromptSuggestionSchedule) — so a
      // fleet-wide --execute run doesn't just register schedules, it also submits up to 3
      // immediate Fargate jobs per newly-reconciled site in rapid succession. --rate-limit-ms
      // only throttles between sites, not between these per-site POSTs; harmless at the scale
      // this backfill targets (a subset of the fleet still missing schedules), but an operator
      // running --execute against a large fleet should weigh that immediate-job burst.
      for (const { providerId, cadence } of missingPipelines) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const result = await registerPromptSuggestionSchedule({
            drsClient, providerId, cadence, siteId, isPaying: true, log,
          });
          if (result?.alreadyExisted) {
            // A race with a concurrent onboarding/activation call between the GET above and
            // this POST — the idempotent createSchedule already absorbed it as a no-op.
            totals.schedulesAlreadyExisted += 1;
          } else {
            totals.schedulesCreated += 1;
          }
        } catch (scheduleError) {
          totals.failures += 1;
          failedSites.push({ siteId, stage: `schedule:${providerId}`, message: scheduleError.message });
          log.error(`site=${siteId} providerId=${providerId} FAILED to create schedule: ${scheduleError.message}`, scheduleError);
        }
      }
    }
  } catch (siteError) {
    totals.failures += 1;
    failedSites.push({ siteId, stage: 'reconcile', message: siteError.message });
    log.error(`site=${siteId} FAILED: ${siteError.message}`, siteError);
  }
}

log.info(`Reconciling PAID LLMO sites' prompt-suggestion schedules${execute ? '' : ' (DRY RUN — no writes)'}`);

// --site-id pushes the filter into the query itself (rather than paginating the whole fleet and
// discarding non-matching rows client-side) so the documented "verify one site before a
// fleet-wide --execute run" workflow is actually cheap.
const siteQueryOptions = siteIdFilter
  ? { where: (attrs, op) => op.in(attrs.siteId, [...siteIdFilter]) }
  : {};

let cursor;
let paginationFailed = false;
do {
  let page;
  try {
    // eslint-disable-next-line no-await-in-loop
    page = await dataAccess.Site.allByEnrollmentFiltered(
      { tier: 'PAID', productCode: 'LLMO' },
      {
        limit: pageSize,
        cursor,
        returnCursor: true,
        // The default sort (updatedAt desc) is a volatile column: a write to any PAID site's
        // updatedAt between this call and the next page's call can shift row order across the
        // page boundary and silently skip a site for this run. Sorting by the immutable site id
        // instead makes traversal order (and therefore full-fleet coverage) independent of
        // concurrent writes elsewhere in the fleet.
        orderBy: { attribute: 'siteId', direction: 'asc' },
        ...siteQueryOptions,
      },
    );
  } catch (pageError) {
    // A page-listing failure (e.g. a transient network blip) is NOT a per-site failure — there
    // is no cursor to safely resume from, so the sweep stops here rather than looping forever
    // on the same failing page or silently skipping the rest of the fleet.
    totals.failures += 1;
    paginationFailed = true;
    log.error(`FAILED to list PAID LLMO sites (cursor=${cursor ?? '<start>'}): ${pageError.message}`, pageError);
    break;
  }
  const sites = page.data ?? [];

  for (const site of sites) {
    // eslint-disable-next-line no-await-in-loop
    await reconcileSite(site);
    // eslint-disable-next-line no-await-in-loop
    await sleep(rateLimitMs);
  }

  cursor = page.cursor;
} while (cursor);

if (paginationFailed) {
  log.error('Sweep stopped early due to the page-listing failure above — the fleet was only partially scanned.');
}

log.info('---');
log.info(`${execute ? '' : 'DRY RUN — '}sites scanned: ${totals.sitesScanned}, no active brand: ${totals.sitesSkippedNoActiveBrand}, already fully provisioned: ${totals.sitesFullyProvisioned}, ${execute ? 'reconciled' : 'needing reconciliation'}: ${totals.sitesReconciled}`);
if (execute) {
  log.info(`schedules created: ${totals.schedulesCreated}, already existed (race): ${totals.schedulesAlreadyExisted}`);
}
if (totals.failures > 0) {
  // totals.failures can exceed failedSites.length by one when the sweep also hit the
  // page-listing failure above (a fleet-level, not per-site, failure).
  log.error(`failures: ${totals.failures}`);
}
if (failedSites.length > 0) {
  log.error(`${failedSites.length} site-level failure(s) — retarget these specifically via --site-id for a retry:`);
  for (const { siteId, stage, message } of failedSites) {
    log.error(`  site=${siteId} stage=${stage}: ${message}`);
  }
}
if (semrushProvisioningIncomplete.length > 0) {
  log.warn(`${semrushProvisioningIncomplete.length} active brand(s) have no Semrush (sub-)workspace provisioned — reported here, NOT bypassed with a DRS Brand Presence schedule. Needs separate Semrush-provisioning triage:`);
  for (const { siteId, brandId, brandName } of semrushProvisioningIncomplete) {
    log.warn(`  site=${siteId} brand=${brandId} (${brandName})`);
  }
}

exit(totals.failures > 0 ? 1 : 0);
