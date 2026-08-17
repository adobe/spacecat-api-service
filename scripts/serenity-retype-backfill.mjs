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
 * One-time `type` (branded / non-branded) re-classification sweep (LLMO-6900).
 *
 * The classifier implemented "whole word" as a space-flanked token test, which no text in a
 * script without word spaces can ever satisfy — `auのSIMロック解除` is a single token, so the
 * brand name inside it never matched. Every prompt in a Japanese, Chinese or Thai market
 * therefore carries `type=non-branded`, and the Brand Presence "non-branded" filter returns
 * 100% of prompts. `branded-classifier.js` now tokenizes those scripts, but classification is
 * forward-only by design (serenity-docs#31, decisions 1/2/6): no write path ever revisits a
 * prompt it already wrote. This script is that missing pass.
 *
 * It re-derives each prompt's `type` value through the SAME closure the write paths use
 * (`buildPromptTypeClassifier`) and corrects the tag IN PLACE via `updatePromptTagsByIds`
 * with `replace: true`. Nothing is deleted or recreated, so prompt ids — and the Brand
 * Presence history keyed to them — survive.
 *
 * IDEMPOTENT: a prompt already carrying the desired `type` id is skipped, so re-running after
 * an interrupted pass is safe and cheap. Resume granularity is per project.
 *
 * AUTH — READ THIS BEFORE RUNNING: every Semrush call in this repo requires a live human's IMS
 * bearer token, forwarded verbatim (see docs/serenity.md — "IMS-user only... There is no
 * backend/automation path"). This is NOT an oversight this script can design around:
 * `ImsPromiseClient` implements only `grant_type=promise` (which itself requires an
 * `authenticating_token` from a live user session) and `promise_exchange` — there is no
 * service-identity grant — and `SERENITY_ALLOW_NON_IMS_AUTH` is hard-disabled when
 * `AWS_ENV === 'prod'`. A cron or Slack-triggered sweep is therefore impossible; an operator
 * supplies `SEMRUSH_IMS_TOKEN` (obtain via `mysticat auth token --ims`) and that identity must
 * have Semrush standing on every workspace the run touches. A 403 is treated as an EXPECTED,
 * non-aborting per-project outcome for exactly that reason.
 *
 * Usage:
 *   POSTGREST_URL=<url> SEMRUSH_IMS_TOKEN=<token> \
 *     node scripts/serenity-retype-backfill.mjs --brand-id <uuid> [options]
 *
 * Options:
 *   --brand-id UUID           REQUIRED. The SpaceCat brand whose projects to sweep.
 *   --project-ids id1,id2     Only these Semrush project ids (default: every project of the
 *                             brand). Running the other affected brands later needs no code
 *                             change — just a different --brand-id.
 *   --dry-run                 Read + classify + report the exact change counts, issue NO write.
 *                             Run this first: it prints the before/after branded totals so the
 *                             expected number can be confirmed before anything is mutated.
 *   --rate-limit-ms N         Sleep between projects (default 300).
 *   --max-consecutive-errors N
 *                             Abort after N consecutive UNEXPECTED project failures (default 5).
 *                             An authorization failure (403) is expected on a fleet a single
 *                             token may not fully span, and does not count toward the threshold.
 *   --checkpoint-file PATH    JSON file of project ids already completed. Re-running with the
 *                             same file skips them; IMS tokens expire, so a long sweep needs to
 *                             be resumable.
 *   --change-log PATH         Append a JSON line per changed prompt (project, prompt id, before,
 *                             after). The script leaves no AsyncJob record, so this is the only
 *                             durable audit trail of what was rewritten.
 *
 * Exit status:
 *   0  No unexpected failure. Projects skipped for lack of authorization are reported and leave
 *      the sweep partial for those workspaces, but do not fail the run.
 *   1  At least one unexpected failure, or a bad invocation.
 *
 * Examples:
 *   # Confirm the expected delta without writing anything
 *   POSTGREST_URL=... SEMRUSH_IMS_TOKEN=... node scripts/serenity-retype-backfill.mjs \
 *     --brand-id 40dd5859-b882-428c-ac8e-8cbb66b06045 --dry-run
 *
 *   # Real run, resumable, with an audit trail
 *   POSTGREST_URL=... SEMRUSH_IMS_TOKEN=... node scripts/serenity-retype-backfill.mjs \
 *     --brand-id 40dd5859-b882-428c-ac8e-8cbb66b06045 \
 *     --checkpoint-file /tmp/retype.json --change-log /tmp/retype-changes.jsonl
 *
 * Get POSTGREST_URL from the target env's Lambda configuration, same as backfill-rum-config.mjs:
 *   aws lambda get-function-configuration --function-name spacecat-api-service-<env> \
 *     --query 'Environment.Variables.POSTGREST_URL'
 */

import { createDataAccess } from '@adobe/spacecat-shared-data-access';
import { parseArgs } from 'node:util';
import { env, exit } from 'node:process';
import {
  appendFileSync, readFileSync, writeFileSync, existsSync, renameSync,
} from 'node:fs';
import { createSerenityTransport } from '../src/support/serenity/rest-transport.js';
import { buildPromptTypeClassifier } from '../src/support/serenity/handlers/classify-prompts-job.js';
import { indexLevelByName, resolveTypeValueInjection } from '../src/support/serenity/tag-tree.js';
import { publishAffected } from '../src/support/serenity/handlers/prompts.js';
import { invalidateTagCacheForProject } from '../src/support/serenity/handlers/markets.js';
import { DIMENSION, TYPE_VALUE } from '../src/support/serenity/prompt-tags.js';

const DEFAULT_RATE_LIMIT_MS = 300;
const DEFAULT_MAX_CONSECUTIVE_ERRORS = 5;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Upstream's own page size for `listPromptsByTags`. */
const PAGE_SIZE = 200;
/**
 * Patch items per `updatePromptTagsByIds` call. The upstream body carries the FULL tag id list
 * for every item, so a project-wide rewrite is far larger than the prompt count suggests.
 */
const PATCH_BATCH_SIZE = 200;
/**
 * Pagination guard. A project that keeps returning full pages past this is a paging contract
 * that changed under us; abort loudly rather than silently sweep a truncated prompt set and
 * report success over it.
 */
const MAX_PAGES = 200;

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    'brand-id': { type: 'string' },
    'project-ids': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    'rate-limit-ms': { type: 'string' },
    'max-consecutive-errors': { type: 'string' },
    'checkpoint-file': { type: 'string' },
    'change-log': { type: 'string' },
  },
});

/**
 * Parses a numeric CLI option, exiting on non-numeric input rather than silently producing
 * `NaN` (which would make every `>= NaN` comparison false — a silently disabled guard).
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

const brandId = values['brand-id'];
const dryRun = values['dry-run'];
const projectIdFilter = values['project-ids']
  ? new Set(values['project-ids'].split(',').map((s) => s.trim()).filter(Boolean))
  : null;
const rateLimitMs = parseNumericOption('--rate-limit-ms', values['rate-limit-ms'], DEFAULT_RATE_LIMIT_MS);
const maxConsecutiveErrors = parseNumericOption('--max-consecutive-errors', values['max-consecutive-errors'], DEFAULT_MAX_CONSECUTIVE_ERRORS);
const checkpointFile = values['checkpoint-file'];
const changeLogFile = values['change-log'];

if (!brandId) {
  console.error('ERROR: --brand-id is required');
  exit(1);
}
if (!UUID_RE.test(brandId)) {
  console.error(`ERROR: --brand-id must be a UUID, got "${brandId}"`);
  exit(1);
}
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
const transport = createSerenityTransport({ env, imsToken: env.SEMRUSH_IMS_TOKEN });

const sleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

// ---------------------------------------------------------------------------
// Checkpoint
// ---------------------------------------------------------------------------
function loadCheckpoint() {
  if (!checkpointFile || !existsSync(checkpointFile)) {
    return new Set();
  }
  try {
    const raw = JSON.parse(readFileSync(checkpointFile, 'utf8'));
    return new Set(Array.isArray(raw?.processedProjectIds) ? raw.processedProjectIds : []);
  } catch (e) {
    log.warn(`WARN: could not parse checkpoint file ${checkpointFile}, starting fresh: ${e.message}`);
    return new Set();
  }
}

function saveCheckpoint(processedProjectIds) {
  if (!checkpointFile) {
    return;
  }
  // Write-to-tmp + rename (atomic on one filesystem): a crash mid-write of a direct write leaves
  // truncated JSON, which loses the whole progress set on the next resume.
  const tmpFile = `${checkpointFile}.tmp`;
  const payload = { processedProjectIds: [...processedProjectIds] };
  writeFileSync(tmpFile, JSON.stringify(payload, null, 2));
  renameSync(tmpFile, checkpointFile);
}

function recordChange(entry) {
  if (!changeLogFile) {
    return;
  }
  appendFileSync(changeLogFile, `${JSON.stringify(entry)}\n`);
}

const processedProjectIds = loadCheckpoint();

/**
 * A prompt's current tag ids, or `null` when the prompt cannot be rewritten safely.
 *
 * `updatePromptTagsByIds` with `replace: true` takes the COMPLETE tag id list, so every tag a
 * prompt carries must be expressible as an id. Upstream has a defensive fallback shape where a
 * tag arrives as a bare string, and that string is the tag's NAME with no id at all — see
 * `buildTagsOf` in `src/support/serenity/handlers/prompts.js`, which surfaces exactly that case
 * with an empty id rather than dropping it. Neither thing this script could do with such a tag
 * is acceptable: passing the name through as if it were an id writes a reference that resolves
 * to nothing, and omitting it silently deletes a customer's tag. So the prompt is refused
 * instead, counted, and left exactly as it is.
 *
 * @param {any} item upstream prompt item.
 * @returns {string[]|null} the tag ids, or null if any tag carries no id.
 */
function tagIdsOf(item) {
  if (!Array.isArray(item?.tags)) {
    return [];
  }
  const ids = [];
  for (const t of item.tags) {
    const id = typeof t === 'object' && t?.id ? String(t.id) : '';
    if (!id) {
      return null;
    }
    ids.push(id);
  }
  return ids;
}

/**
 * Reads every prompt of a project, following pagination to the end.
 * @param {string} workspaceId
 * @param {string} projectId
 * @returns {Promise<any[]>}
 */
async function readAllPrompts(workspaceId, projectId) {
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const resp = await transport.listPromptsByTags(workspaceId, projectId, {
      tag_ids: [], page, limit: PAGE_SIZE,
    });
    const items = Array.isArray(resp?.items) ? resp.items : [];
    all.push(...items);
    if (items.length < PAGE_SIZE) {
      return all;
    }
  }
  throw new Error(`pagination exceeded ${MAX_PAGES} pages for project ${projectId} — refusing to sweep a truncated prompt set`);
}

/**
 * Resolves the `branded` / `non-branded` tag ids for a project, plus the strip set — EVERY id
 * under the `type` root. Stripping by id and never by name is what keeps a customer category
 * legitimately named "branded" out of the blast radius.
 *
 * Read-only first, by two plain level listings. `resolveTypeValueInjection` would be the natural
 * call, but it is resolve-OR-CREATE: using it here would make `--dry-run` mint tags upstream,
 * which is exactly what a dry run promises not to do. It is still the fallback on a real run, so
 * a project whose `type` root predates the closed vocabulary self-heals rather than failing.
 *
 * @param {string} workspaceId
 * @param {string} projectId
 * @returns {Promise<{ idByValue: Record<string, string>, stripSet: Set<string> }>}
 */
async function resolveTypeIds(workspaceId, projectId) {
  const roots = await indexLevelByName(transport, workspaceId, projectId, '', log);
  const typeRootId = roots.get(DIMENSION.TYPE);
  if (typeRootId) {
    const children = await indexLevelByName(transport, workspaceId, projectId, typeRootId, log);
    const brandedId = children.get(TYPE_VALUE.BRANDED);
    const nonBrandedId = children.get(TYPE_VALUE.NON_BRANDED);
    if (brandedId && nonBrandedId) {
      return {
        idByValue: { [TYPE_VALUE.BRANDED]: brandedId, [TYPE_VALUE.NON_BRANDED]: nonBrandedId },
        stripSet: new Set(children.values()),
      };
    }
  }
  if (dryRun) {
    throw new Error(`project ${projectId} is missing a provisioned \`type\` value; a real run would create it, a dry run will not`);
  }
  const resolveType = (v) => resolveTypeValueInjection(transport, workspaceId, projectId, v, log);
  const branded = await resolveType(TYPE_VALUE.BRANDED);
  const nonBranded = await resolveType(TYPE_VALUE.NON_BRANDED);
  return {
    idByValue: {
      [TYPE_VALUE.BRANDED]: branded.computedId,
      [TYPE_VALUE.NON_BRANDED]: nonBranded.computedId,
    },
    stripSet: new Set([...branded.typeTagIds, ...nonBranded.typeTagIds]),
  };
}

/**
 * Sweeps one project: read every prompt, re-classify, patch only those whose `type` changed,
 * then publish. Returns the counts for the run summary.
 * @param {object} project the BrandSemrushProject row.
 * @param {string} workspaceId
 * @param {(text: string, geoTargetId: number) => string} classifyPromptType
 */
async function sweepProject(project, workspaceId, classifyPromptType) {
  const projectId = project.getSemrushProjectId();
  const geoTargetId = project.getGeoTargetId();

  const { idByValue, stripSet } = await resolveTypeIds(workspaceId, projectId);

  const items = await readAllPrompts(workspaceId, projectId);
  const patchItems = [];
  let considered = 0;
  let unclassifiable = 0;
  let unresolvableTags = 0;
  let brandedBefore = 0;
  let brandedAfter = 0;

  for (const item of items) {
    const text = item?.name || '';
    if (!text) {
      // No text to classify. Counted separately so the reported totals still add up — an
      // operator checking a --dry-run against an expected branded count has to be able to
      // reconcile the numbers, since that check is the safeguard this whole design leans on.
      unclassifiable += 1;
      // eslint-disable-next-line no-continue
      continue;
    }
    const currentTagIds = tagIdsOf(item);
    if (currentTagIds === null) {
      unresolvableTags += 1;
      // eslint-disable-next-line no-continue
      continue;
    }
    considered += 1;
    const wasBranded = currentTagIds.includes(idByValue[TYPE_VALUE.BRANDED]);
    const desired = classifyPromptType(text, geoTargetId);
    const desiredId = idByValue[desired];
    if (wasBranded) {
      brandedBefore += 1;
    }
    if (desired === TYPE_VALUE.BRANDED) {
      brandedAfter += 1;
    }
    if (currentTagIds.includes(desiredId)) {
      // Already correct — the idempotency that makes a re-run safe.
      // eslint-disable-next-line no-continue
      continue;
    }
    patchItems.push({
      id: String(item.id),
      references: [...currentTagIds.filter((id) => !stripSet.has(id)), desiredId],
      replace: true,
    });
    recordChange({
      projectId,
      promptId: String(item.id),
      before: wasBranded ? TYPE_VALUE.BRANDED : TYPE_VALUE.NON_BRANDED,
      after: desired,
    });
  }

  const summary = {
    projectId,
    total: items.length,
    considered,
    unclassifiable,
    unresolvableTags,
    brandedBefore,
    brandedAfter,
    changed: patchItems.length,
  };
  if (dryRun || patchItems.length === 0) {
    return summary;
  }

  for (let i = 0; i < patchItems.length; i += PATCH_BATCH_SIZE) {
    // eslint-disable-next-line no-await-in-loop
    const batch = patchItems.slice(i, i + PATCH_BATCH_SIZE);
    // eslint-disable-next-line no-await-in-loop
    await transport.updatePromptTagsByIds(workspaceId, projectId, batch);
  }
  // Clears this process's own tag cache only — the deployed Lambdas hold their own and self-heal
  // on the existing 60s TTL. Called anyway so the sweep follows the same sequence every other
  // mutating caller does.
  invalidateTagCacheForProject(workspaceId, projectId);

  // Writes land in a DRAFT layer; without this they are invisible to every read path.
  const publishErrors = await publishAffected(transport, workspaceId, [projectId], log);
  if (publishErrors.length > 0) {
    throw new Error(`publish failed: ${publishErrors.map((e) => e.message).join('; ')}`);
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
const brand = await dataAccess.Brand.findById(brandId);
if (!brand) {
  console.error(`ERROR: brand ${brandId} not found`);
  exit(1);
}
const workspaceId = brand.getSemrushSubWorkspaceId?.() || brand.getSemrushWorkspaceId?.();
if (!workspaceId) {
  console.error(`ERROR: brand ${brandId} has no Semrush workspace — nothing to sweep`);
  exit(1);
}

const classifyPromptType = await buildPromptTypeClassifier(dataAccess, brandId);
const allProjects = await dataAccess.BrandSemrushProject.allByBrandId(brandId);
const projects = projectIdFilter
  ? allProjects.filter((p) => projectIdFilter.has(p.getSemrushProjectId()))
  : allProjects;

log.info(`Brand ${brand.getName()} (${brandId}) — workspace ${workspaceId}`);
log.info(`Projects to sweep: ${projects.length}${dryRun ? ' (DRY RUN — no writes)' : ''}`);

let consecutiveErrors = 0;
const totals = {
  projects: 0,
  prompts: 0,
  considered: 0,
  unclassifiable: 0,
  unresolvableTags: 0,
  brandedBefore: 0,
  brandedAfter: 0,
  changed: 0,
  failed: 0,
  authSkipped: 0,
  skipped: 0,
};

for (const project of projects) {
  const projectId = project.getSemrushProjectId();
  if (processedProjectIds.has(projectId)) {
    totals.skipped += 1;
    // eslint-disable-next-line no-continue
    continue;
  }
  try {
    // eslint-disable-next-line no-await-in-loop
    const r = await sweepProject(project, workspaceId, classifyPromptType);
    const caveats = [
      r.unclassifiable ? `${r.unclassifiable} with no text` : '',
      r.unresolvableTags ? `${r.unresolvableTags} REFUSED (a tag carries no id)` : '',
    ].filter(Boolean).join(', ');
    log.info(`  ${projectId}: ${r.considered} of ${r.total} prompts classified, branded ${r.brandedBefore} -> ${r.brandedAfter}, ${r.changed} rewritten${caveats ? ` [${caveats}]` : ''}`);
    totals.projects += 1;
    totals.prompts += r.total;
    totals.considered += r.considered;
    totals.unclassifiable += r.unclassifiable;
    totals.unresolvableTags += r.unresolvableTags;
    totals.brandedBefore += r.brandedBefore;
    totals.brandedAfter += r.brandedAfter;
    totals.changed += r.changed;
    consecutiveErrors = 0;
    if (!dryRun) {
      // Checkpoint only after publish succeeded. An unpublished patch is invisible, so a project
      // that patched but failed to publish must be retried, not recorded as done.
      processedProjectIds.add(projectId);
      saveCheckpoint(processedProjectIds);
    }
  } catch (e) {
    const status = e?.status ?? e?.statusCode;
    const expected = status === 403;
    // Counted apart from `failed` so the exit code reflects only actionable failures: a token
    // that does not span every workspace is the documented normal case, not a broken sweep.
    if (expected) {
      totals.authSkipped += 1;
    } else {
      totals.failed += 1;
    }
    log.error(`  ${projectId}: FAILED${expected ? ' (authorization — expected on a token that does not span this workspace)' : ''}: ${e.message}`);
    if (!expected) {
      consecutiveErrors += 1;
      if (consecutiveErrors >= maxConsecutiveErrors) {
        log.error(`ABORT: ${consecutiveErrors} consecutive unexpected failures`);
        break;
      }
    }
  }
  // eslint-disable-next-line no-await-in-loop
  await sleep(rateLimitMs);
}

log.info('---');
log.info(`${dryRun ? 'DRY RUN — ' : ''}projects swept: ${totals.projects}, skipped (checkpointed): ${totals.skipped}, skipped (no authorization): ${totals.authSkipped}, failed: ${totals.failed}`);
log.info(`prompts: ${totals.prompts} read, ${totals.considered} classified, branded ${totals.brandedBefore} -> ${totals.brandedAfter}, rewritten: ${totals.changed}`);
if (totals.unclassifiable > 0) {
  log.info(`  ${totals.unclassifiable} prompt(s) had no text and were not classified`);
}
if (totals.unresolvableTags > 0) {
  log.warn(`  ${totals.unresolvableTags} prompt(s) REFUSED: a tag arrived without an id, so the full tag set could not be rewritten safely. These were left untouched — investigate before assuming the sweep is complete.`);
}
if (totals.authSkipped > 0) {
  log.warn(`  ${totals.authSkipped} project(s) were NOT swept because this token lacks standing on their workspace. The sweep is incomplete for them — re-run with a token that spans them.`);
}
// Only unexpected failures are actionable; a 403 leaves the run partial, which the warning
// above reports, but does not mean the sweep itself went wrong.
exit(totals.failed > 0 ? 1 : 0);
