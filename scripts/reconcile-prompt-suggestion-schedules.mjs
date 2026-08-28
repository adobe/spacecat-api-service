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

function parseNumericOption(flag, raw, fallback) {
  if (raw === undefined) {
    return fallback;
  }
  const n = Number(raw);
  if (Number.isNaN(n)) {
    console.error(`ERROR: ${flag} must be a number, got "${raw}"`);
    exit(1);
  }
  return n;
}

const { execute } = values;
const pageSize = parseNumericOption('--page-size', values['page-size'], DEFAULT_PAGE_SIZE);
const rateLimitMs = parseNumericOption('--rate-limit-ms', values['rate-limit-ms'], DEFAULT_RATE_LIMIT_MS);
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
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`DRS GET /schedules?site_id=${siteId} failed: ${response.status} - ${body}`);
  }
  const { schedules } = await response.json();
  const existing = new Set();
  for (const schedule of schedules ?? []) {
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

/**
 * Reconciles one site: resolves its active Brand-V2 brand (if any), reads DRS's current
 * schedule state, and — in --execute mode — creates whichever of the three prompt-suggestion
 * pipelines are missing. Mutates `totals` / `semrushProvisioningIncomplete` directly; every
 * exit path (early return or the catch) runs through here, which is what lets the caller apply
 * `rateLimitMs` uniformly after every site that actually made a DB/DRS call.
 * @param {object} site - SpaceCat Site model instance.
 * @returns {Promise<void>}
 */
async function reconcileSite(site) {
  const siteId = site.getId();
  totals.sitesScanned += 1;
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
          log.error(`site=${siteId} providerId=${providerId} FAILED to create schedule: ${scheduleError.message}`);
        }
      }
    }
  } catch (siteError) {
    totals.failures += 1;
    log.error(`site=${siteId} FAILED: ${siteError.message}`);
  }
}

log.info(`Reconciling PAID LLMO sites' prompt-suggestion schedules${execute ? '' : ' (DRY RUN — no writes)'}`);

let cursor;
let paginationFailed = false;
do {
  let page;
  try {
    // eslint-disable-next-line no-await-in-loop
    page = await dataAccess.Site.allByEnrollmentFiltered(
      { tier: 'PAID', productCode: 'LLMO' },
      { limit: pageSize, cursor, returnCursor: true },
    );
  } catch (pageError) {
    // A page-listing failure (e.g. a transient network blip) is NOT a per-site failure — there
    // is no cursor to safely resume from, so the sweep stops here rather than looping forever
    // on the same failing page or silently skipping the rest of the fleet.
    totals.failures += 1;
    paginationFailed = true;
    log.error(`FAILED to list PAID LLMO sites (cursor=${cursor ?? '<start>'}): ${pageError.message}`);
    break;
  }
  const sites = page.data ?? [];

  for (const site of sites) {
    if (siteIdFilter && !siteIdFilter.has(site.getId())) {
      // eslint-disable-next-line no-continue
      continue;
    }
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
  log.error(`failures: ${totals.failures}`);
}
if (semrushProvisioningIncomplete.length > 0) {
  log.warn(`${semrushProvisioningIncomplete.length} active brand(s) have no Semrush (sub-)workspace provisioned — reported here, NOT bypassed with a DRS Brand Presence schedule. Needs separate Semrush-provisioning triage:`);
  for (const { siteId, brandId, brandName } of semrushProvisioningIncomplete) {
    log.warn(`  site=${siteId} brand=${brandId} (${brandName})`);
  }
}

exit(totals.failures > 0 ? 1 : 0);
