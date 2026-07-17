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
 * One-time rightsizing sweep (LLMO-6191, rollout-hardening item 1).
 *
 * JIT top-up (`ensureAiHeadroom`, gated behind SERENITY_DYNAMIC_ALLOCATION) only ever GROWS a
 * sub-workspace's AI resource `total` from the request path. Sub-workspaces carved BEFORE that
 * feature shipped (PR #2764) keep their pre-carve `total`, typically far larger than actual
 * `used` — the shared parent org pool stays drained for every existing brand until rightsized once.
 * This script does that one-time backfill, using the already-built reclaim primitive
 * `releaseAiSurplus` (src/support/serenity/resource-manager.js) as the reclaim mechanism — no new
 * top-up/release logic lives in this file, only enumeration, rate-limiting, and reporting.
 *
 * WHY A STANDALONE SCRIPT, NOT A SLACK COMMAND OR CRON JOB: this repo has no cron/scheduling
 * mechanism of its own (a one-time backfill has nowhere to schedule into for a Lambda-per-request
 * API service), and the one existing precedent for this exact shape of work is
 * `scripts/backfill-rum-config.mjs` (a manually-invoked Node script). This mirrors that.
 *
 * AUTH — READ THIS BEFORE RUNNING: every Semrush call in this repo requires a live human's IMS
 * bearer token, forwarded verbatim (see docs/serenity.md — "IMS-user only... There is no backend/
 * automation path"). This script is NO exception: it requires an operator-supplied
 * `SEMRUSH_IMS_TOKEN` (obtain via `mysticat auth token --ims`). That token's IMS identity must have
 * Semrush-workspace admin standing across EVERY org this sweep touches — if it does not, per-org
 * calls will fail authorization (403), which this script treats as an EXPECTED, non-aborting
 * failure (logged, counted, skipped) precisely because a single token spanning every customer org
 * cannot be assumed. Narrow a run with --org-ids to the token's actual scope if not fleet-wide.
 *
 * Usage:
 *   POSTGREST_URL=<url> SEMRUSH_IMS_TOKEN=<token> node scripts/serenity-rightsizing-sweep.mjs [opt]
 *
 * Options:
 *   --dry-run                 Compute + report what would be released, issue NO transfer calls.
 *                             (Still reads live workspace resources — a safe way to also confirm
 *                             the token's authorization scope before committing to a real run.)
 *   --org-ids id1,id2         Only sweep these SpaceCat organization IDs (comma-separated).
 *   --brand-ids id1,id2       Only sweep these SpaceCat brand IDs (comma-separated; still requires
 *                             --org-ids so the brand can be resolved without a global brand scan).
 *   --limit N                 Stop after processing N sub-workspaces (across the whole run, not
 *                             per org) — bounds a single invocation's blast radius and run time.
 *   --rate-limit-ms N         Sleep between sub-workspaces (default 300ms) — avoid hammering the
 *                             Semrush gateway or the parent pool with back-to-back releases.
 *   --max-consecutive-errors N
 *                             Abort the whole run after N consecutive UNEXPECTED failures in a row
 *                             (default 5). Reason-aware: expected/best-effort outcomes
 *                             (`orgPoolExhausted`, `brandAiLimit`, `workspaceBusy`,
 *                             `nothing-to-release`, `requires-decommission`) do NOT count toward
 *                             this threshold — they are normal outcomes on a live fleet, not signs
 *                             of a degraded gateway. Only a streak of genuinely unclassified errors
 *                             (`errorCode` absent — see releaseAiSurplus's JSDoc) trips it.
 *   --checkpoint-file PATH    JSON file recording brand ids already processed in this (or a prior,
 *                             interrupted) run. Re-running with the same file skips them — this
 *                             sweep can safely take hours across a large fleet (each release may
 *                             poll-settle for several seconds; see transferAndSettle) and IMS
 *                             tokens expire, so a resumable run is required, not a nice-to-have.
 *
 * Examples:
 *   # Dry-run everything (also validates the token's org-spanning scope up front)
 *   POSTGREST_URL=... SEMRUSH_IMS_TOKEN=... node scripts/serenity-rightsizing-sweep.mjs --dry-run
 *
 *   # Real run, scoped to two orgs, resumable
 *   POSTGREST_URL=... SEMRUSH_IMS_TOKEN=... node scripts/serenity-rightsizing-sweep.mjs \
 *     --org-ids org-1,org-2 --checkpoint-file /tmp/serenity-sweep.json
 *
 * Get POSTGREST_URL from the target env's Lambda configuration, same as backfill-rum-config.mjs:
 *   aws lambda get-function-configuration --function-name spacecat-api-service-<env> \
 *     --query 'Environment.Variables.POSTGREST_URL'
 */

import { createDataAccess } from '@adobe/spacecat-shared-data-access';
import { parseArgs } from 'node:util';
import { env, exit } from 'node:process';
import {
  readFileSync, writeFileSync, existsSync, renameSync,
} from 'node:fs';
import { listBrands } from '../src/support/brands-storage.js';
import { createSerenityTransport } from '../src/support/serenity/rest-transport.js';
import {
  releaseAiSurplus, DEFAULT_BLOCKS, PROJECT_BLOCK, PROMPT_BLOCK,
} from '../src/support/serenity/resource-manager.js';

const DEFAULT_RATE_LIMIT_MS = 300;
const DEFAULT_MAX_CONSECUTIVE_ERRORS = 5;
// Never floor a sub-workspace below one grace block per dim — mirrors the request-path release
// seam's floor (markets-subworkspace.js) so a rightsized brand still has immediate headroom for its
// very next metered write, rather than round-tripping through ensureAiHeadroom on the next request.
const DEFAULT_FLOOR = { projects: PROJECT_BLOCK, prompts: PROMPT_BLOCK };

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    'dry-run': { type: 'boolean', default: false },
    'org-ids': { type: 'string' },
    'brand-ids': { type: 'string' },
    limit: { type: 'string' },
    'rate-limit-ms': { type: 'string' },
    'max-consecutive-errors': { type: 'string' },
    'checkpoint-file': { type: 'string' },
  },
});

/**
 * Parses a numeric CLI option, exiting with a clear error on non-numeric input rather than
 * silently producing `NaN` (which would make e.g. `consecutiveUnexpectedErrors >= NaN` always
 * false — a silent no-op abort threshold — MysticatBot review, LLMO-6191).
 * @param {string} flag the --flag name, for the error message.
 * @param {string|undefined} raw the raw string value from parseArgs.
 * @param {number} fallback default when `raw` is absent.
 * @returns {number}
 */
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

const dryRun = values['dry-run'];
const orgIdFilter = values['org-ids']
  ? new Set(values['org-ids'].split(',').map((s) => s.trim()).filter(Boolean))
  : null;
const brandIdFilter = values['brand-ids']
  ? new Set(values['brand-ids'].split(',').map((s) => s.trim()).filter(Boolean))
  : null;
const limit = parseNumericOption('--limit', values.limit, Infinity);
const rateLimitMs = parseNumericOption('--rate-limit-ms', values['rate-limit-ms'], DEFAULT_RATE_LIMIT_MS);
const maxConsecutiveErrors = parseNumericOption('--max-consecutive-errors', values['max-consecutive-errors'], DEFAULT_MAX_CONSECUTIVE_ERRORS);
const checkpointFile = values['checkpoint-file'];

if (brandIdFilter && !orgIdFilter) {
  console.error('ERROR: --brand-ids requires --org-ids (brands are resolved per-org, not globally)');
  exit(1);
}

// ---------------------------------------------------------------------------
// Validate env
// ---------------------------------------------------------------------------
if (!env.POSTGREST_URL) {
  console.error('ERROR: POSTGREST_URL is required');
  exit(1);
}
if (!env.SEMRUSH_IMS_TOKEN) {
  console.error('ERROR: SEMRUSH_IMS_TOKEN is required (obtain via `mysticat auth token --ims`)');
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
const { Organization } = dataAccess;
const postgrestClient = dataAccess.services?.postgrestClient;
const transport = createSerenityTransport({ env, imsToken: env.SEMRUSH_IMS_TOKEN });

// ---------------------------------------------------------------------------
// Checkpoint (resumability — see the option doc above)
// ---------------------------------------------------------------------------
function loadCheckpoint() {
  if (!checkpointFile || !existsSync(checkpointFile)) {
    return new Set();
  }
  try {
    const raw = JSON.parse(readFileSync(checkpointFile, 'utf8'));
    return new Set(Array.isArray(raw?.processedBrandIds) ? raw.processedBrandIds : []);
  } catch (e) {
    log.warn(`WARN: could not parse checkpoint file ${checkpointFile}, starting fresh: ${e.message}`);
    return new Set();
  }
}

function saveCheckpoint(processedBrandIds) {
  if (!checkpointFile) {
    return;
  }
  // Write-to-tmp + rename (atomic on the same filesystem) rather than writing the checkpoint file
  // directly — a crash mid-write of a direct write can leave a truncated/corrupt JSON file, losing
  // the entire progress set on the very next resume attempt (MysticatBot review, LLMO-6191).
  const payload = { processedBrandIds: [...processedBrandIds] };
  const tmpFile = `${checkpointFile}.tmp`;
  writeFileSync(tmpFile, JSON.stringify(payload, null, 2));
  renameSync(tmpFile, checkpointFile);
}

const processedBrandIds = loadCheckpoint();

// ---------------------------------------------------------------------------
// Enumerate: every org -> every brand with a provisioned Semrush sub-workspace
// ---------------------------------------------------------------------------
log.info('Fetching organizations...');
const allOrgs = await Organization.all();
const orgs = orgIdFilter ? allOrgs.filter((o) => orgIdFilter.has(o.getId())) : allOrgs;
log.info(`Organizations to scan: ${orgs.length} (of ${allOrgs.length} total)`);

/** @type {{ orgId: string, brandId: string, subWorkspaceId: string }[]} */
const targets = [];
for (const org of orgs) {
  const orgId = org.getId();
  // eslint-disable-next-line no-await-in-loop
  const brands = await listBrands(orgId, postgrestClient);
  for (const brand of brands) {
    // Only sub-workspace (dual-mode) brands have an allocation to rightsize; flat-mode brands
    // resolve through the shared org parent and were never over-carved per-brand. A brand-id
    // filter (--brand-ids) further narrows within an org.
    const inScope = Boolean(brand.semrushSubWorkspaceId)
      && (!brandIdFilter || brandIdFilter.has(brand.id));
    if (inScope) {
      targets.push({ orgId, brandId: brand.id, subWorkspaceId: brand.semrushSubWorkspaceId });
    }
  }
}
log.info(`Sub-workspaces found: ${targets.length}`);

const remaining = targets.filter((t) => !processedBrandIds.has(t.brandId));
const toProcess = remaining.slice(0, limit);
const limitNote = Number.isFinite(limit) ? ` (of ${remaining.length} remaining, --limit ${limit})` : '';
log.info(`Already checkpointed (skipped): ${targets.length - remaining.length}`);
log.info(`To process this run: ${toProcess.length}${limitNote}`);

if (toProcess.length === 0) {
  log.info('Nothing to do.');
  exit(0);
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

let released = 0;
let nothingToRelease = 0;
let requiresDecommission = 0;
let expectedErrors = 0; // orgPoolExhausted / brandAiLimit / workspaceBusy — normal on a live fleet
let unexpectedErrors = 0; // no typed errorCode — the abort-threshold counter
let consecutiveUnexpectedErrors = 0;
let aborted = false;

const EXPECTED_ERROR_CODES = new Set(['orgPoolExhausted', 'brandAiLimit', 'workspaceBusy']);

log.info(`\n${dryRun ? '[DRY RUN] ' : ''}Starting rightsizing sweep...\n`);

for (const target of toProcess) {
  const { orgId, brandId, subWorkspaceId } = target;
  try {
    // eslint-disable-next-line no-await-in-loop
    const result = await releaseAiSurplus(transport, {
      subWorkspaceId,
      floor: DEFAULT_FLOOR,
      blocks: DEFAULT_BLOCKS,
      dryRun,
      // Non-fail-fast: this is the async/reconciler path (serenity-docs#22 scope decision), so the
      // sweep can afford releaseAiSurplus's settle-poll + not-ready retry loop, unlike the
      // synchronous request-path release seam (markets-subworkspace.js) which passes failFast:true.
    }, log);

    if (result.released || result.reason === 'dry-run') {
      released += 1;
      const verb = dryRun ? 'would release' : 'released';
      log.info(`✓  org=${orgId} brand=${brandId} ws=${subWorkspaceId}  ${verb} → ${JSON.stringify(result.target)}`);
      consecutiveUnexpectedErrors = 0;
    } else if (result.reason === 'nothing-to-release') {
      nothingToRelease += 1;
      consecutiveUnexpectedErrors = 0;
    } else if (result.reason === 'requires-decommission') {
      requiresDecommission += 1;
      log.warn(`!  org=${orgId} brand=${brandId} ws=${subWorkspaceId}  surplus unreclaimable via transfer (needs decommission)`);
      consecutiveUnexpectedErrors = 0;
    } else {
      // reason === 'error' — reason-AWARE classification (senior-sre review, LLMO-6191): only a
      // genuinely unexpected failure (no typed errorCode) counts toward the abort threshold.
      // Expected pool/busy failures are normal fleet noise, not a signal the gateway is degraded.
      const isExpected = EXPECTED_ERROR_CODES.has(result.errorCode);
      if (isExpected) {
        expectedErrors += 1;
        consecutiveUnexpectedErrors = 0;
      } else {
        unexpectedErrors += 1;
        consecutiveUnexpectedErrors += 1;
      }
      log.error(`✗  org=${orgId} brand=${brandId} ws=${subWorkspaceId}  ${result.errorCode || 'unclassified'}: ${result.errorMessage}`);
    }

    processedBrandIds.add(brandId);
  } catch (e) {
    // releaseAiSurplus only re-throws truly unexpected bugs (not transport/pool/busy) — treat as
    // unexpected without exception.
    unexpectedErrors += 1;
    consecutiveUnexpectedErrors += 1;
    log.error(`✗  org=${orgId} brand=${brandId} ws=${subWorkspaceId}  UNEXPECTED (propagated bug): ${e.message}`);
  }

  saveCheckpoint(processedBrandIds); // checkpoint after EVERY item — safe to Ctrl-C at any point

  if (consecutiveUnexpectedErrors >= maxConsecutiveErrors) {
    log.error(`\nABORTING: ${consecutiveUnexpectedErrors} consecutive unexpected errors (threshold ${maxConsecutiveErrors}) — `
      + 'this looks like a degraded gateway or a wiring bug, not ordinary pool pressure. Fix and resume from the checkpoint file.');
    aborted = true;
    break;
  }

  // eslint-disable-next-line no-await-in-loop
  await sleep(rateLimitMs);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
log.info('\n-----------------------------');
log.info(`${dryRun ? 'Would release' : 'Released'}:        ${released}`);
log.info(`Nothing to release:  ${nothingToRelease}`);
log.info(`Requires decommission: ${requiresDecommission}`);
log.info(`Expected errors:     ${expectedErrors} (pool/limit/busy — normal fleet noise)`);
log.info(`Unexpected errors:   ${unexpectedErrors}`);
log.info(`Aborted early:       ${aborted}`);
log.info('-----------------------------');

exit(unexpectedErrors > 0 || aborted ? 1 : 0);
