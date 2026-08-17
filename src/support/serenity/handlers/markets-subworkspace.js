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

// @ts-check

import { hasText } from '@adobe/spacecat-shared-utils';

import { ErrorWithStatusCode } from '../../utils.js';
import {
  ERROR_CODES, isUpstreamGone, isMeteredQuota, toQuotaExceededError,
} from '../errors.js';
import { alertQuotaRejection } from '../quota-alerts.js';
import { normalizeGeoTargetId, normalizeLanguageCode } from '../validation.js';
import { buildCreateMetadata } from './prompts.js';
import {
  resolveLocation,
  resolveLanguageId,
  defaultMarketName,
  listTagsForProject,
  listProjectTagTree,
  listSliceModels,
  listUnionModels,
  syncModelsForProject,
  MAX_MODEL_IDS,
  validateParentIdQuery,
} from './markets.js';
import {
  listMarkets, resolveProject, mapPublishStatus, projectToSlice,
} from '../subworkspace-projects.js';
import { ensureSubworkspace } from '../workspace-lifecycle.js';
import {
  DIMENSION, STANDARD_PROMPT_TAG_VALUES, INTENT_VALUE, GENERATED_PROMPT_SOURCE_VALUE,
} from '../prompt-tags.js';
import { provisionDimensionTree, ensureServerOwnedValue } from '../tag-tree.js';
import { classifyBrandedTag, needlesFromNames } from '../branded-classifier.js';
import { classifyPromptIntents, AI_GEN_CLASSIFY_MAX, computeWriteDeadline } from '../intent-classification.js';
import { collectBrandUrlEntries, attachBrandUrlsToProject, primaryDomainSet } from '../brand-urls.js';
import { resolveProjects } from '../resolve-projects.js';
import { buildReservedDomains, syncCompetitorBenchmarksForProject } from '../competitor-benchmarks.js';
import { collectAliasNames } from '../brand-aliases.js';
import { upsertMappingRow, tombstoneMappingRow } from '../mapping-rows.js';

/** @typedef {import('../rest-transport.js').SerenityTransport} SerenityTransport */
/** @typedef {import('../rest-transport.js').ProjectCreateBody} ProjectCreateBody */

/**
 * Subworkspace-mode market handlers (serenity design §3/§5). The brand has its own
 * Semrush subworkspace; markets are enumerated live (no BrandSemrushProject
 * mapping). The controller dispatches here when resolveBrandWorkspace returns
 * mode === 'subworkspace'; the flat-mode handlers stay frozen and untouched.
 */

// "live" publish states — a slice that already has a published project (a real
// existing market), vs a leftover draft that a retry should adopt and resume.
const LIVE_STATES = new Set(['live', 'live_with_unpublished_updates']);

/**
 * Best-effort `"geoTargetId#languageCode" → siteId` index built from the brand's
 * LIVE `brand_to_semrush_projects` rows. Sub-workspace markets are enumerated
 * live (no mapping consulted for the slice itself), but the SpaceCat Site
 * identity lives only on the mapping row, so the read/get handlers enrich the
 * live slices with it here (LLMO-6405 Phase 2). No-op-safe: if data-access or
 * the model is missing, or the read throws, returns an empty index (every slice
 * then reports `siteId: null`); NEVER throws — a market read must not fail on a
 * best-effort enrichment.
 *
 * @param {any} dataAccess - `ctx.dataAccess` (reads `dataAccess.BrandSemrushProject`).
 * @param {string} brandId - the brand UUID.
 * @param {any} [log] - logger.
 * @returns {Promise<Map<string, string>>} slice-key → siteId (live, linked rows only).
 */
async function buildMarketSiteIdIndex(dataAccess, brandId, log) {
  const index = new Map();
  const BrandSemrushProject = dataAccess?.BrandSemrushProject;
  if (!BrandSemrushProject || typeof BrandSemrushProject.allByBrandId !== 'function'
      || !brandId || !hasText(brandId)) {
    return index;
  }
  try {
    const rows = await BrandSemrushProject.allByBrandId(brandId);
    for (const row of (Array.isArray(rows) ? rows : [])) {
      const siteId = row.getSiteId ? row.getSiteId() : null;
      // Skip tombstoned rows and rows with no linked site.
      if ((row.getDeletedAt && row.getDeletedAt()) || !siteId || !hasText(siteId)) {
        // eslint-disable-next-line no-continue
        continue;
      }
      const lang = hasText(row.getLanguageCode()) ? String(row.getLanguageCode()).toLowerCase() : '';
      index.set(`${row.getGeoTargetId()}#${lang}`, siteId);
    }
  } catch (e) {
    log?.warn?.('serenity markets (subworkspace): siteId enrichment read failed (non-fatal)', {
      brandId, error: e?.message,
    });
  }
  return index;
}

/** Slice-key for the siteId index — matches buildMarketSiteIdIndex's keying. */
function marketSiteIdKey(geoTargetId, languageCode) {
  const lang = hasText(languageCode) ? String(languageCode).toLowerCase() : '';
  return `${geoTargetId}#${lang}`;
}

function validateSlice(geoTargetId, languageCode) {
  if (normalizeGeoTargetId(geoTargetId) === null) {
    throw new ErrorWithStatusCode('geoTargetId must be a positive integer', 400);
  }
  if (normalizeLanguageCode(languageCode) === null) {
    throw new ErrorWithStatusCode('languageCode must match ^[a-z]{2,3}(-[a-z]{2,4})?$', 400);
  }
}

/**
 * GET /serenity/markets (subworkspace) — one live listing of the subworkspace,
 * enriched with each market's SpaceCat Site identity (siteId) from the brand's
 * mapping rows (LLMO-6405 Phase 2). `projectToSlice` has no DB access, so the
 * enrichment happens here; a missing/failed read leaves every siteId null.
 *
 * @param {SerenityTransport} transport
 * @param {string} brandId - the brand UUID.
 * @param {string} workspaceId - the brand's sub-workspace id.
 * @param {any} [dataAccess] - `ctx.dataAccess`; when absent, siteId stays null.
 * @param {any} [log] - logger.
 */
export async function handleListMarketsSubworkspace(
  transport,
  brandId,
  workspaceId,
  dataAccess,
  log,
) {
  const items = await listMarkets(transport, workspaceId, brandId);
  const siteIdIndex = await buildMarketSiteIdIndex(dataAccess, brandId, log);
  return {
    items: items.map((slice) => ({
      ...slice,
      siteId: siteIdIndex.get(marketSiteIdKey(slice.geoTargetId, slice.languageCode)) ?? null,
    })),
  };
}

/**
 * GET /serenity/markets/:geo/:lang (subworkspace) — resolve the slice from the live
 * listing; surface semrushProjectId + status + `initialized` (one extra
 * init_status read, detail only). 404 marketNotFound if no project matches.
 * @param {SerenityTransport} transport
 */
export async function handleGetMarketSubworkspace(
  transport,
  brandId,
  workspaceId,
  geoTargetId,
  languageCode,
  log,
  dataAccess,
) {
  validateSlice(geoTargetId, languageCode);
  const lang = normalizeLanguageCode(languageCode);
  const project = await resolveProject(transport, workspaceId, Number(geoTargetId), lang, log);
  if (!project) {
    const err = new ErrorWithStatusCode('No market for this brand and (geoTargetId, languageCode) slice', 404);
    err.code = ERROR_CODES.MARKET_NOT_FOUND;
    throw err;
  }
  let initialized = null;
  try {
    const status = await transport.getInitStatus(workspaceId, project.id);
    initialized = status?.initialized ?? null;
  } catch (e) {
    // AIO readiness is best-effort enrichment; never fail the detail read on it.
    log?.info?.('handleGetMarketSubworkspace: init_status read failed (non-fatal)', {
      brandId, workspaceId, projectId: project.id, error: e.message,
    });
  }
  const slice = projectToSlice(project, brandId);
  // Enrich with the SpaceCat Site identity (LLMO-6405 Phase 2), best-effort. Detail
  // reads ONE slice, so point-read that slice's mapping row via findBySlice rather
  // than loading every brand mapping row (buildMarketSiteIdIndex is reserved for
  // the amortized list path). Never throws — siteId stays null on any miss.
  let siteId = null;
  const BrandSemrushProject = dataAccess?.BrandSemrushProject;
  if (BrandSemrushProject && typeof BrandSemrushProject.findBySlice === 'function') {
    try {
      const row = await BrandSemrushProject.findBySlice(brandId, Number(geoTargetId), lang);
      const rowSiteId = row && !row.getDeletedAt?.() ? (row.getSiteId?.() ?? null) : null;
      siteId = rowSiteId && hasText(rowSiteId) ? rowSiteId : null;
    } catch (e) {
      log?.warn?.('serenity market (subworkspace): siteId point-read failed (non-fatal)', {
        brandId, error: e?.message,
      });
    }
  }
  return { ...slice, initialized, siteId };
}

// De-duplicates name strings case-insensitively (trim + lowercase key),
// preserving first-seen order. Used to build a project's brand_names from the
// primary brand name(s) plus the brand's aliases without repeating a value.
function dedupeNames(names) {
  const seen = new Set();
  return names
    .filter(hasText)
    .filter((n) => {
      const key = n.trim().toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

/**
 * The default name is derived from `body` rather than taking the caller's
 * already-normalized language code as a parameter: `normalizeLanguageCode` is
 * pure, so it yields the identical value, and threading it in would sit a
 * `languageCode` argument next to `languageId` — two strings a call site can
 * transpose silently, producing a project named after a UUID.
 *
 * @param {object} body - the validated create body.
 * @param {{ geoTargetId: number, locationName: string|undefined }} location - resolved market.
 * @param {string} languageId - upstream language UUID.
 * @param {string[]} [brandAliases]
 * @returns {ProjectCreateBody}
 */
function buildCreateProjectBody(body, location, languageId, brandAliases = []) {
  const name = hasText(body?.name)
    ? String(body.name)
    : defaultMarketName(body.market, normalizeLanguageCode(body.languageCode));
  // A Semrush project's brand is described by a display name plus the full set
  // of names it is known by (`brand_names`). Brand aliases are brand-level, so
  // every project/market in the brand carries them alongside the primary name.
  const brandNames = dedupeNames([
    ...(Array.isArray(body.brandNames) ? body.brandNames : []),
    ...(Array.isArray(brandAliases) ? brandAliases : []),
  ]);
  return {
    name,
    type: 'ai',
    // Honor an explicit brandDisplayName; fall back to the primary brand name.
    // This keeps the project's display name consistent with the own-brand
    // benchmark created from `brandDisplayName` (attachBrandUrlsToProject) and
    // with the re-sync path, which reads `brand_name_display` back as the
    // benchmark's own-brand name (brand-urls.js).
    brand_name_display: hasText(body.brandDisplayName) ? body.brandDisplayName : body.brandNames[0],
    brand_names: brandNames,
    domain: body.brandDomain,
    country_code: body.market.toLowerCase(),
    location_id: location.geoTargetId,
    location_name: location.locationName,
    language_id: languageId,
  };
}

function validateCreateBody(body) {
  const errors = [];
  if (body?.name !== undefined && body.name !== null && !hasText(body.name)) {
    errors.push('name, when provided, must be a non-empty string');
  }
  if (!hasText(body?.market) || !/^[A-Za-z]{2}$/.test(body.market)) {
    errors.push('market must be an ISO-2 country code');
  }
  if (normalizeLanguageCode(body?.languageCode) === null) {
    errors.push('languageCode must match ^[a-z]{2,3}(-[a-z]{2,4})?$');
  }
  // brandDomain OR siteId (LLMO-6405 Phase 2): the controller derives brandDomain
  // from a supplied siteId (this handler has no Site access), so accept either.
  if (!hasText(body?.brandDomain) && !hasText(body?.siteId)) {
    errors.push('brandDomain or siteId is required');
  }
  if (!Array.isArray(body?.brandNames) || body.brandNames.length === 0
      || !body.brandNames.every(hasText)) {
    errors.push('brandNames must be a non-empty array of strings');
  }
  return errors;
}

/**
 * Generates topics + prompts for (domain, country) via the AI-SEO service
 * (transport.getBrandTopics) and attaches them to the project. Keeps the top
 * `topicCap` topics by search volume (0 = keep all) and tags every prompt with
 * the standard closed-dimension values ({@link STANDARD_PROMPT_TAG_VALUES}, minus
 * its seeded `intent` default), the producing `source/semrush` value, plus a
 * branded / non-branded `type` value derived from `brandNames` (brand name +
 * aliases) and a per-prompt server-classified `intent` value (serenity-docs#32,
 * replacing the seeded `Informational` default). Returns the topic/prompt counts.
 * A generation that yields nothing is a clean no-op (no upstream write).
 *
 * The generated topic name is NOT attached. Under the dimension-root model a
 * topic is a sub-category — a depth-3 descendant of a customer category — and
 * the AI-SEO service returns topics with no category to hang them under, so
 * there is no correct parent to create them below. Generated prompts therefore
 * arrive uncategorized and are categorized later (adobe/serenity-docs#44).
 *
 * Writes are id-based: `createPromptsWithMetadata` takes ONE shared `tag_ids` array per
 * call, so the texts are partitioned by their resolved tag-id set — the (type,
 * intent) pair, since topics are gone and everything else is constant. Identical
 * text collapses to one entry per group.
 *
 * @param {SerenityTransport} transport
 * @param {string} workspaceId - sub-workspace the project lives in.
 * @param {string} projectId - project to attach generated prompts to.
 * @param {object} options - generation options.
 * @param {string} options.domain - brand domain to generate topics for.
 * @param {string} options.country - market/country code to generate topics for.
 * @param {number} [options.topicCap=0] - keep the top N topics by volume (0 = all).
 * @param {string[]} [options.brandNames=[]] - brand name + aliases for branded
 *   classification via the shared {@link classifyBrandedTag} (whole-word match,
 *   diacritic-folded, case-insensitive).
 * @param {{ values: Map<string, Map<string, string>> }} options.provisioned - the
 *   already-provisioned dimension tree. The caller provisions it unconditionally,
 *   so re-resolving it here would read the whole taxonomy a second time per request.
 * @param {object} [options.env] - environment (Azure OpenAI creds), for intent
 *   classification (serenity-docs#32).
 * @param {number} [options.writeDeadline] - shared request-write deadline.
 * @param {object} log - logger.
 * @param {string} callerId - resolved caller id (see `resolveCallerId`) stamped as
 *   `created_by`/`updated_by` on every generated prompt (LLMO-6289).
 */
async function generateAndAttachPrompts(transport, workspaceId, projectId, {
  domain, country, topicCap = 0, brandNames = [], provisioned, env,
  writeDeadline = computeWriteDeadline(),
}, log, callerId) {
  const raw = await transport.getBrandTopics(workspaceId, { domain, country });
  let topics = [];
  if (Array.isArray(raw)) {
    topics = raw;
  } else if (Array.isArray(raw?.items)) {
    topics = raw.items;
  }
  const ranked = topics
    .filter((t) => hasText(t?.topic))
    .sort((a, b) => (Number(b?.volume) || 0) - (Number(a?.volume) || 0));
  const selected = topicCap > 0 ? ranked.slice(0, topicCap) : ranked;

  // Brand-name + alias needles for branded classification. The shared classifier
  // (branded-classifier.js) folds diacritics, lower-cases, and matches on whole
  // word boundaries — the SAME implementation the manual create/edit paths use,
  // so a prompt is classified identically no matter how it is written.
  const needles = needlesFromNames(Array.isArray(brandNames) ? brandNames : []);

  // Dedupe by text FIRST: an identical prompt under two topics is one prompt, and
  // its classification depends only on its text, so the winner is unambiguous.
  const texts = new Set();
  for (const t of selected) {
    for (const p of (Array.isArray(t.prompts) ? t.prompts : [])) {
      if (hasText(p)) {
        texts.add(p);
      }
    }
  }
  if (texts.size === 0) {
    log?.info?.('generateAndAttachPrompts: no prompts generated', {
      workspaceId, projectId, domain, country,
    });
    return { topicCount: 0, promptCount: 0 };
  }

  // Resolve every tag id we are about to attach. `createPromptsWithMetadata` is ATOMIC on
  // an unresolvable id (live 500s and creates nothing), so ids are never guessed.
  // `provisionDimensionTree` resolved every closed value or threw a 502, so the
  // standard values and the whole `type`/`intent` vocabularies are present here by
  // construction.
  const { values } = provisioned;
  // The standard closed-dimension ids EXCEPT `intent`: intent is classified per
  // prompt below (serenity-docs#32) and replaces the seeded `Informational`
  // default, so it must not be double-attached from the standard set.
  const standardIdsNonIntent = STANDARD_PROMPT_TAG_VALUES
    .filter(({ dimension }) => dimension !== DIMENSION.INTENT)
    .map(({ dimension, name }) => /** @type {string} */ (values.get(dimension)?.get(name)));
  // Stamp the producing system. This generator builds its prompts from Semrush's
  // own `getBrandTopics`, so every generated prompt is `source/semrush` — the
  // persisted SR-AI-Visibility key, a constant at THIS write site, NOT `config`
  // (source-dimension.md §1 item 2). `source` is open, so the value is resolved-or-
  // created on demand rather than pre-provisioned in `provisioned.values`.
  const { id: sourceId } = await ensureServerOwnedValue(
    transport,
    workspaceId,
    projectId,
    DIMENSION.SOURCE,
    GENERATED_PROMPT_SOURCE_VALUE,
    log,
  );
  const typeValues = /** @type {Map<string, string>} */ (values.get(DIMENSION.TYPE));
  const intentValues = /** @type {Map<string, string>} */ (values.get(DIMENSION.INTENT));

  // Batch-classify intent ONCE for every generated text (capped at
  // AI_GEN_CLASSIFY_MAX under the shared request deadline); anything unclassified
  // falls back to the seeded `Informational` default. Every resolved value is in
  // the `intent` vocabulary provisioned above, so its id is a Map lookup — no
  // extra upstream call.
  const allTexts = [...texts];
  // The cap is a designed budget bound, not an error: texts beyond it are not
  // classified and take the seeded `Informational` default (see the partition
  // below). Emit one line when it binds so a silently-defaulted tail is
  // observable rather than invisible (serenity-docs#32 observability).
  if (allTexts.length > AI_GEN_CLASSIFY_MAX) {
    log?.info?.('generateAndAttachPrompts: AI-gen classify cap hit — tail defaults to Informational', {
      workspaceId,
      projectId,
      total: allTexts.length,
      classified: AI_GEN_CLASSIFY_MAX,
      defaultedByCap: allTexts.length - AI_GEN_CLASSIFY_MAX,
    });
  }
  const intentByText = await classifyPromptIntents(
    allTexts.slice(0, AI_GEN_CLASSIFY_MAX),
    {
      env, log, deadline: writeDeadline, writePath: 'ai-gen', workspaceId,
    },
  );

  // `createPromptsByIds` takes ONE shared `tag_ids` array per call, so partition
  // the texts by their resolved (type, intent) id pair — the only two dimensions
  // that vary per prompt.
  /** @type {Map<string, { items: string[], tagIds: string[] }>} */
  const byTagSet = new Map();
  for (const text of allTexts) {
    const typeValue = classifyBrandedTag(text, needles);
    const intentValue = intentByText.get(text) ?? INTENT_VALUE.INFORMATIONAL;
    const key = `${typeValue} ${intentValue}`;
    const bucket = byTagSet.get(key);
    if (bucket) {
      bucket.items.push(text);
    } else {
      // `branded` / `non-branded` are the classifier's only outputs and every
      // classified/defaulted intent is a fixed vocabulary value — both are in the
      // tree provisioned above.
      const typeId = /** @type {string} */ (typeValues.get(typeValue));
      const intentId = /** @type {string} */ (intentValues.get(intentValue));
      byTagSet.set(key, {
        items: [text],
        // `sourceId` (source/semrush) is constant for every generated prompt, so
        // it rides in every bucket alongside the per-(type, intent) ids.
        tagIds: [...standardIdsNonIntent, intentId, sourceId, typeId],
      });
    }
  }

  // STAMP (LLMO-6289): AI-generated prompts are created through the v3
  // metadata-carrying write, `created_* = updated_* = now / callerId`. One
  // metadata object per batch (same instant for every text in the group).
  const metadata = buildCreateMetadata(callerId);
  for (const { items, tagIds } of byTagSet.values()) {
    // `tagIds` is precomputed per (type, intent) bucket above (standard + intent + source + type).
    // eslint-disable-next-line no-await-in-loop
    await transport.createPromptsWithMetadata(
      workspaceId,
      projectId,
      items.map((name) => ({ name, metadata })),
      tagIds,
    );
  }
  return { topicCount: selected.length, promptCount: texts.size };
}

/**
 * POST /serenity/markets (subworkspace, design flow 3) — ensure the subworkspace
 * (lazy-create / re-grant), then create-or-adopt the slice's draft, publish
 * once, and confirm. No rollback: a leftover draft is a resumable state, not
 * an orphan (design §7). The duplicate-create race is accepted (oldest-wins
 * reads + alert). When `options.dataAccess` is supplied, upserts the
 * `brand_to_semrush_projects` mapping row best-effort after the project is
 * created/adopted (serenity-docs brand-semrush-mapping-maintenance.md §4.1) —
 * omit it for callers whose `brand` is not yet a persisted row (see
 * `mapping-rows.js` `upsertMappingRow` doc).
 *
 * @param {SerenityTransport} transport
 * @param {object} brand - brand record/stub being provisioned.
 * @param {string} parentWorkspaceId - the org parent workspace, used as the `assertNotParent` guard
 *   input. Nothing is carved from it (the JIT allocator that once drew a pool from it is removed —
 *   SITES-49206).
 * @param {object} body - request body ({ market, languageCode, brandDomain, ... }).
 * @param {object} log - logger.
 * @param {string|null} [preResolvedWorkspaceId] - when set (the activate batch
 *   path), the sub-workspace is already ensured/sized; skip the per-call ensure
 *   and create directly against it. Omitted on the single-market POST path.
 * @param {function|null} [reloadPointer] - lost-update concurrency guard passed
 *   through to ensureSubworkspace on the single-market POST path (see there).
 * @param {object} [options]
 * @param {string[]} [options.modelIds=[]] - AI models (LLMs) to attach to the
 *   project before publishing. A project needs models to track anything.
 * @param {boolean} [options.generateTopics=false] - generate topics+prompts from
 *   `body.brandDomain` + `body.market` and attach them, carrying the standard
 *   closed-dimension values and a branded / non-branded `type` value.
 * @param {number} [options.topicCap=0] - keep only the top N generated topics by
 *   search volume (0 = keep all).
 * @param {Array<string|{name: string, regions?: string[]}>} [options.brandAliases=[]]
 *   - brand aliases; brand-level names the brand is also known by. Region-clamped
 *   to THIS market (a region-scoped alias only applies to the markets it lists;
 *   region-less / 'ww' apply everywhere; a bare string is treated as region-less).
 *   The market-applicable names are added to the project's `brand_names`
 *   (alongside the primary name) so the project carries them, and — together with
 *   the brand name(s) — used to classify each generated prompt's `type` value as
 *   `branded` (text mentions a name/alias as a whole word, diacritic-folded) or
 *   `non-branded`.
 * @param {object} [options.brandUrlSources=null] - the brand's URL sources
 *   ({ urls, socialAccounts, earnedContent }, V2 shape) to push onto this
 *   market's project benchmark. Brand `urls` go to every market; social/earned
 *   are filtered to this market's region. Same brand-level set is passed for
 *   every market. Best-effort: a failed push is logged (non-fatal) and never
 *   aborts the create — URL enrichment must not strand a half-provisioned brand.
 * @param {object[]} [options.competitors=[]] - the brand's competitors ("other
 *   brands to track", { url, regions }) to merge into this market's project CI
 *   competitor list (region-filtered, domain-only). Read-merged with Semrush's
 *   existing/auto-generated list before publish. Best-effort: a failed sync is
 *   logged (non-fatal) and never aborts the create.
 * @param {'require'|'best-effort'|'skip'} [options.publishMode='require'] - how
 *   to publish: `require` throws on failure (the default markets endpoint);
 *   `best-effort` swallows a quota 405 (empty-units publish, workspace doc §5)
 *   and leaves the project a draft; `skip` does not publish at all.
 * @param {any} [options.dataAccess] - when supplied, upserts the
 *   `brand_to_semrush_projects` mapping row for this project (best-effort,
 *   never fails the create). Omit for a `brand` that is not yet a persisted
 *   row — see `mapping-rows.js` `upsertMappingRow` doc.
 * @param {object} [options.brandCollection] - the data-access Brand collection, threaded to
 *   `ensureSubworkspace` on the single-market POST path so its claim filter can tell this
 *   brand's own interrupted create from a same-named sibling brand's sub-workspace (titles are
 *   bare brand names). Unused when `preResolvedWorkspaceId` is supplied.
 * @param {function} [options.onWorkspaceCreated] - forwarded to `ensureSubworkspace`; called
 *   only when the sub-workspace was FRESHLY CREATED here, so the caller's failure compensation
 *   never tears down a workspace that was merely adopted.
 * @param {object} [options.env] - environment (Azure OpenAI creds), threaded into intent
 *   classification when `generateTopics` is set (serenity-docs#32); ALSO used directly to fire the
 *   quota-rejection Slack alert (serenity-docs#72 §5) on a publish quota rejection. Optional —
 *   omitted, alerting is a no-op.
 * @param {number} [options.writeDeadline] - shared request-write deadline; defaults
 *   to a fresh {@link computeWriteDeadline} for direct/test callers.
 * @param {string | null} [options.orgId] - IMS org id, for the Slack alert payload only.
 * @param {string} [options.callerId='unknown'] - resolved caller id (see
 *   `resolveCallerId`) stamped as `created_by`/`updated_by` on any AI-generated
 *   prompt this create attaches (LLMO-6289). Defaults to the `unknown` sentinel
 *   so a caller that omits it never writes an empty author.
 */
export async function handleCreateMarketSubworkspace(
  transport,
  brand,
  parentWorkspaceId,
  body,
  log,
  preResolvedWorkspaceId = null,
  reloadPointer = null,
  {
    modelIds = [],
    generateTopics = false,
    topicCap = 0,
    brandAliases = [],
    brandUrlSources = null,
    competitors = [],
    publishMode = 'require',
    dataAccess = null,
    brandCollection = undefined,
    onWorkspaceCreated = undefined,
    env = null,
    writeDeadline = computeWriteDeadline(),
    orgId = null,
    callerId = 'unknown',
  } = {},
) {
  const errors = validateCreateBody(body);
  if (errors.length > 0) {
    return { status: 400, body: { error: 'invalidRequest', message: errors.join('; ') } };
  }
  const location = resolveLocation(body.market);
  if (!location) {
    return { status: 400, body: { error: 'unknownMarket', message: `Unknown market '${body.market}'` } };
  }
  const languageCode = normalizeLanguageCode(body.languageCode);

  // Region-clamp the brand aliases to THIS market: a region-scoped alias only
  // lands on the markets it lists (region-less / 'ww' apply everywhere). The same
  // filtered name set feeds the project's brand_names, the prompt-classification
  // needles, and the own-brand benchmark's brand_aliases. `brandAliases` may be
  // the persisted `{ name, regions }` shape or bare strings (collectAliasNames
  // treats a string as region-less).
  const aliasNames = collectAliasNames(brandAliases, body.market);

  // activate() ensures the sub-workspace once for the whole batch and passes it in here. The
  // single-market POST /markets path passes nothing, so we ensure on the spot.
  const workspaceId = preResolvedWorkspaceId && hasText(preResolvedWorkspaceId)
    ? preResolvedWorkspaceId
    : await ensureSubworkspace(
      transport,
      brand,
      parentWorkspaceId,
      log,
      {},
      reloadPointer,
      { brandCollection, onWorkspaceCreated },
    );

  const existing = await resolveProject(
    transport,
    workspaceId,
    location.geoTargetId,
    languageCode,
    log,
  );
  let projectId;
  if (existing) {
    if (LIVE_STATES.has(mapPublishStatus(existing.publish_status))) {
      return {
        status: 409,
        body: { error: 'sliceExists', message: 'Brand already has a live market for this slice' },
      };
    }
    // Leftover draft → adopt and resume (publish-once below).
    projectId = existing.id;
  } else {
    const languageId = await resolveLanguageId(transport, languageCode, log);
    if (!languageId) {
      return { status: 400, body: { error: 'unknownLanguage', message: `Language '${languageCode}' not found` } };
    }
    const createResp = await transport.createProject(
      workspaceId,
      buildCreateProjectBody(body, location, languageId, aliasNames),
    );
    projectId = String(createResp?.id || '');
    if (!hasText(projectId)) {
      return { status: 502, body: { error: 'createNoProjectId', message: 'Upstream createProject returned no id' } };
    }
  }

  // Provision the dimension-root taxonomy on the project (independent of prompts),
  // so classification can later apply intent/origin/type values per prompt and the
  // Categories surface has a `category` root to hang customer categories under.
  // Idempotent (resolve-before-create), and unconditional: every project carries
  // exactly the four dimension roots, whether or not it has prompts yet.
  const provisioned = await provisionDimensionTree(transport, workspaceId, projectId, log);

  // Attach the selected AI models (LLMs) to the project before populating /
  // publishing — a project with no models can't track anything. Stage only
  // (publish: false): the single best-effort publish below commits models +
  // prompts together, so a quota 405 can't escape mid-flow.
  if (Array.isArray(modelIds) && modelIds.length > 0) {
    await syncModelsForProject(
      transport,
      workspaceId,
      projectId,
      modelIds,
      { geoTargetId: location.geoTargetId, languageCode },
      log,
      { publish: false },
    );
  }

  // Generate topics+prompts from the brand domain + market and attach them. The
  // topic seeds the prompt TEXT only and is not attached as a tag: the AI-SEO
  // service returns topics with no category to hang them under, so the generated
  // prompts arrive uncategorized, carrying only the standard tag set.
  let generated = { topicCount: 0, promptCount: 0 };
  if (generateTopics) {
    generated = await generateAndAttachPrompts(
      transport,
      workspaceId,
      projectId,
      {
        domain: body.brandDomain,
        country: body.market,
        topicCap,
        provisioned,
        // Branded classification needles: the brand's own name(s) + the
        // market-applicable aliases.
        brandNames: [
          ...(Array.isArray(body.brandNames) ? body.brandNames : []),
          ...aliasNames,
        ],
        env,
        writeDeadline,
      },
      log,
      callerId,
    );
  }

  // Push the brand's URLs (own sites + social + earned) onto this market's
  // own-brand benchmark (created on demand when Semrush hasn't provisioned one),
  // region-filtered to the market. Done before publish so the URLs are part of
  // the same published version. Best-effort: URL enrichment must never abort the
  // brand create — a benchmark/URL hiccup is logged and skipped, not propagated,
  // so the whole block (INCLUDING the project listing the skip set needs) sits
  // inside the try.
  try {
    // Skip EVERY market's primary domain, not just this one's: a market-mirror
    // brand's other-market primary must not surface as a website URL here either
    // (skip-primary-domain, #25 — see collectBrandUrlEntries). This market's own
    // domain comes from the payload; its project may not be in the listing yet.
    const siblings = await resolveProjects(transport, workspaceId);
    const primaryDomains = primaryDomainSet([
      body.brandDomain,
      ...siblings.map((p) => p?.domain),
    ]);
    const brandUrlEntries = collectBrandUrlEntries(
      brandUrlSources,
      body.market,
      primaryDomains,
    );
    await attachBrandUrlsToProject(
      transport,
      workspaceId,
      projectId,
      brandUrlEntries,
      { name: body.brandDisplayName, domain: body.brandDomain, aliases: aliasNames },
      log,
    );
  } catch (e) {
    // Best-effort, but DELIBERATELY non-self-healing: the brand is left live with
    // its URLs not propagated, and the next edit only re-syncs if urls/competitors
    // are touched. Emit a DISTINCT, greppable token so this divergence is
    // alertable rather than lost in generic warn noise.
    log?.warn?.('handleCreateMarketSubworkspace: SERENITY_MARKET_URL_ATTACH_DIVERGENCE — brand-URL attach failed (non-fatal); market live without propagated URLs', {
      workspaceId, projectId, error: e?.message,
    });
  }

  // Track the brand's competitors ("other brands to track") as project benchmarks
  // (region-filtered), before publish. Competitors live as benchmarks in an AIO
  // project — the same surface as the own-brand benchmark and brand URLs (settings.ci
  // is a CI-project feature AIO projects don't have). Create-only here (nothing of
  // ours to remove yet). Best-effort: a competitor-sync hiccup must not abort the
  // brand create.
  try {
    // Reserve the brand's own domains (this market's project domain + the brand's
    // own website URLs) so a competitor can't be one of the brand's own properties.
    const reservedDomains = buildReservedDomains(
      [body.brandDomain],
      brandUrlSources?.urls,
    );
    await syncCompetitorBenchmarksForProject(
      transport,
      workspaceId,
      projectId,
      competitors,
      [],
      body.market,
      log,
      reservedDomains,
    );
  } catch (e) {
    // Same non-self-healing best-effort seam as the URL attach above — distinct
    // greppable token so a competitor-sync divergence on a live market is alertable.
    log?.warn?.('handleCreateMarketSubworkspace: SERENITY_MARKET_COMPETITOR_SYNC_DIVERGENCE — competitor benchmark sync failed (non-fatal); market live without competitor benchmarks', {
      workspaceId, projectId, error: e?.message,
    });
  }

  // Publish per mode. 'best-effort' swallows a quota 405 (publishing an
  // empty-units child 405s as a disguised quota rejection, workspace doc §5) and
  // leaves the project a draft so the brand still succeeds.
  let published = false;
  if (publishMode === 'require') {
    try {
      await transport.publishProject(workspaceId, projectId);
      published = true;
    } catch (e) {
      // Case 1 (serenity-docs#72 §2): the upstream refused the publish with the
      // disguised quota 405. Classify via `isMeteredQuota` (body-SHAPE check, not bare
      // status — MysticatBot review) so a genuine app-level 405 Method-Not-Allowed (JSON body)
      // is never mistaken for a quota rejection and hidden behind the wrong error token; this
      // also gives the shared `MeteredQuotaClassifier` metric (LLMO-6191) a live call site.
      // Surface a real quota match as the stable `quotaExceeded` 409 token instead of letting it
      // fall through mapError's generic `serenityUpstreamError` 502 — a caller can then show the
      // contractual-limit message and never retry a rejection that can't succeed.
      if (isMeteredQuota(e)) {
        log?.warn?.('handleCreateMarketSubworkspace: publish rejected — quota exceeded', {
          workspaceId, projectId,
        });
        // serenity-docs#72 §5: never throws/never alters the rejection below — but AWAITED so the
        // Slack POST actually completes before a Lambda response freeze could drop it (fire-and-
        // forget refers to the response value, not literal no-await).
        await alertQuotaRejection({
          orgId,
          brandId: brand.getId(),
          workspaceId,
          market: `${body.market}/${languageCode}`,
          caseType: 'brandCarveExhausted',
          dimension: 'prompts',
        }, env, log);
        throw toQuotaExceededError();
      }
      throw e;
    }
  } else if (publishMode === 'best-effort') {
    try {
      await transport.publishProject(workspaceId, projectId);
      published = true;
    } catch (e) {
      if (isMeteredQuota(e)) {
        // Swallowed by design (best-effort provisioning must not fail the brand create), but this
        // IS a quota rejection and the event that creates the dark draft market a customer later
        // trips over — serenity-docs#72 §5 requires it to alert even though nothing failed here.
        // The call below is side-effect-only (its returned error is intentionally discarded, never
        // thrown — best-effort swallows it) purely to run `recordRejection('quotaExceeded')`
        // inside it, so the CloudWatch metric this alarm will key on fires here too, keeping the
        // classifier + alerting signal consistent between this swallowed path and the `require`
        // path above (MysticatBot review, non-blocking nit).
        toQuotaExceededError();
        log?.warn?.('handleCreateMarketSubworkspace: publish skipped — quota exceeded, project left as draft', {
          workspaceId, projectId,
        });
        // serenity-docs#72 §5 bullet 2: "the swallow is still a quota rejection... MUST emit the
        // same (deduplicated) alert, marked as originating from the best-effort provisioning
        // path" — the event that creates the dark draft market a customer later trips over.
        // Awaited for the same Lambda-freeze reason as the require branch above.
        await alertQuotaRejection({
          orgId,
          brandId: brand.getId(),
          workspaceId,
          market: `${body.market}/${languageCode}`,
          caseType: 'brandCarveExhausted',
          dimension: 'prompts',
          swallowed: true,
        }, env, log);
      } else {
        throw e;
      }
    }
  }

  if (dataAccess) {
    await upsertMappingRow(dataAccess, {
      brandId: brand.getId(),
      semrushProjectId: projectId,
      geoTargetId: location.geoTargetId,
      languageCode,
    }, log);
  }

  return {
    status: 201,
    body: {
      brandId: brand.getId(),
      geoTargetId: location.geoTargetId,
      languageCode,
      workspaceId,
      projectId,
      published,
      ...(generateTopics
        ? { topicCount: generated.topicCount, promptCount: generated.promptCount }
        : {}),
    },
  };
}

/**
 * DELETE /serenity/markets/:geo/:lang (subworkspace, design flow 4) — resolve from the
 * listing, delete the project (404-as-success). NO floor check: removing the
 * last market is allowed; the empty subworkspace is kept.
 *
 * When `dataAccess` is supplied, best-effort tombstones the mapping row
 * (`deletedAt` set — spec §4.2) once the project is confirmed gone. Only
 * covers the two paths where a project id is actually resolved (deleted here,
 * or already gone upstream via 404-as-success): when the project is not found
 * in the listing at all (early return below), there is no project id or brand
 * id in scope to tombstone with, so a live mapping row for an
 * already-vanished project is left un-tombstoned — accepted,
 * reconcile-recoverable drift (implementation plan §3.2/§11).
 *
 * @param {SerenityTransport} transport
 * @param {string|null} workspaceId - sub-workspace id the market's project lives in.
 * @param {string|number|null} geoTargetId - the market's Google Ads Geo Target id.
 * @param {string|null} languageCode - the market's BCP-47 language code.
 * @param {object} log - logger.
 * @param {object} [options]
 * @param {any} [options.dataAccess]
 */
export async function handleDeleteMarketSubworkspace(
  transport,
  workspaceId,
  geoTargetId,
  languageCode,
  log,
  { dataAccess = null } = {},
) {
  validateSlice(geoTargetId, languageCode);
  const lang = normalizeLanguageCode(languageCode);
  const project = await resolveProject(transport, workspaceId, Number(geoTargetId), lang, log);
  // Nothing checks this read. The generated contract declares `id: string` — required and
  // non-nullable — but the listing response resolves to `any` at every call site, and the
  // live gateway is documented to return bodies the spec forbids. Everything below keys off
  // the id: the upstream DELETE and the mapping-row tombstone both address the project by
  // it. An id-less entry is therefore indistinguishable from no project at all — it cannot
  // be deleted upstream, and tombstoning against a blank id would target the wrong row. It
  // is a contract break either way, so say so rather than reporting a silent 204.
  const projectId = project?.id;
  if (!projectId) {
    if (project) {
      log?.warn?.('serenity subworkspace: listing returned a project with no id — skipping delete', {
        workspaceId,
        geoTargetId,
        languageCode: lang,
      });
    }
    return { status: 204, deletedSiteId: null };
  }
  // Reaching here means `resolveProject` matched a project from `listProjects(workspaceId)`,
  // so `workspaceId` is a real, non-blank id — narrow the (JSDoc-optional) `string|null` once
  // for tsc, which cannot infer that. The DELETE below relies on it.
  const resolvedWorkspaceId = /** @type {string} */ (workspaceId);
  try {
    await transport.deleteProject(resolvedWorkspaceId, projectId);
  } catch (e) {
    if (!isUpstreamGone(e)) {
      throw e;
    }
  }
  // Tombstone the mapping row and capture the deleted market's linked Site
  // (LLMO-6405 R12) in one read, so the controller can reference-count and unlink
  // an orphaned brand_sites row. Best-effort — never fails a successful delete.
  let deletedSiteId = null;
  if (dataAccess) {
    const tombstoned = await tombstoneMappingRow(dataAccess, projectId, log);
    deletedSiteId = tombstoned?.siteId ?? null;
  }
  return { status: 204, deletedSiteId };
}

/**
 * Page through a project's STANDALONE AIO tags (registered via createProjectTags,
 * not necessarily carried by any prompt). `listProjectTags` is page-based
 * (page/limit); walk until a short page ends it, bounded by a page ceiling for an
 * unexpectedly huge set — mirroring `listTagsForProject`'s prompt-page walk so
 * standalone categories beyond the first page are not silently dropped.
 *
 * Reads the DRAFT view. Tag writes land in the project's draft layer and the
 * live view hides them until the project is published, so a default (live) read
 * cannot see a category this proxy just created — which is the one thing this
 * function exists to surface.
 *
 * @param {SerenityTransport} transport
 * @param {string} workspaceId - Semrush (sub-)workspace id.
 * @param {string} projectId - AIO project id.
 * @param {any} [log] - logger, used to surface a ceiling-hit truncation warning.
 * @returns {Promise<{ items: Array<{ id?: string, name?: string }> }>}
 */
async function listStandaloneProjectTags(transport, workspaceId, projectId, log) {
  const items = [];
  const LIMIT = 100;
  const PAGE_LIMIT = 50;
  let page = 1;
  while (page <= PAGE_LIMIT) {
    // eslint-disable-next-line no-await-in-loop
    const resp = await transport.listProjectTags(workspaceId, projectId, {
      page, limit: LIMIT, draft: true,
    });
    const batch = Array.isArray(resp?.items) ? resp.items : [];
    items.push(...batch);
    if (batch.length < LIMIT) {
      break;
    }
    if (page === PAGE_LIMIT) {
      // Ceiling reached with a still-full last page: at least one more page went
      // unread, so the standalone set may be truncated. A missing category in the
      // UI is a real symptom, so log it rather than stop silently.
      log?.warn?.('listStandaloneProjectTags: page ceiling hit; standalone tag set may be truncated', {
        workspaceId, projectId, pages: PAGE_LIMIT, limit: LIMIT,
      });
      break;
    }
    page += 1;
  }
  return { items };
}

/**
 * GET /serenity/tags (subworkspace) — unique tag names across the slice's prompts.
 * Resolves the slice's project from the live listing, then reuses the shared
 * project-keyed tag aggregation (cache + pagination + truncation guard). A
 * missing slice returns an empty set, matching the flat-mode tags contract.
 * @param {SerenityTransport} transport
 */
export async function handleListTagsSubworkspace(transport, workspaceId, query, log) {
  const geoTargetId = normalizeGeoTargetId(query?.geoTargetId);
  const languageCode = normalizeLanguageCode(query?.languageCode);
  if (geoTargetId === null || languageCode === null) {
    throw new ErrorWithStatusCode(
      'geoTargetId (integer) and languageCode (BCP-47 primary subtag) are required',
      400,
    );
  }
  const project = await resolveProject(transport, workspaceId, geoTargetId, languageCode, log);
  if (!project) {
    return { items: [] };
  }
  const projectId = String(project.id);
  // NESTED-TREE MODE (parity with flat handleListTags): a `parentId` query param
  // drills the standalone AIO tag tree instead of the prompt-derived merge below.
  if (query?.parentId !== undefined) {
    return listProjectTagTree(
      transport,
      workspaceId,
      projectId,
      validateParentIdQuery(String(query.parentId)),
      log,
    );
  }
  // A tag exists in two forms: attached to ≥1 prompt (listTagsForProject scans the
  // prompt vocabulary) OR standalone (registered via createProjectTags but not yet
  // carried by any prompt — e.g. a just-created, still-empty category).
  // The Categories surface must round-trip BOTH, so merge them by tag name. The
  // standalone list is best-effort: a hiccup there must not regress the
  // prompt-derived behavior that already worked.
  const [fromPrompts, standalone] = await Promise.all([
    listTagsForProject(transport, workspaceId, projectId, { geoTargetId, languageCode }, log),
    Promise.resolve()
      .then(() => listStandaloneProjectTags(transport, workspaceId, projectId, log))
      .catch((e) => {
        log?.warn?.('handleListTagsSubworkspace: standalone tag list failed (non-fatal)', {
          workspaceId, projectId, error: e?.message,
        });
        return { items: [] };
      }),
  ]);
  // Merge by ID, not by name. Names are unique only per (project, parent), so a
  // sub-category `human` and the `origin` value `human` are two distinct tags —
  // keying by name silently drops one of them.
  const byId = new Map();
  // Both sources back-fill a missing upstream id with the tag's own name (a
  // prompt can carry a tag as a bare string, and a standalone row can predate its
  // id). Such an entry is a name-shaped PLACEHOLDER, recognisable by `id === name`
  // — an upstream id never equals the bare name it labels. Hold placeholders aside
  // so a canonical id for the same name can supersede them.
  // Placeholders are keyed by name, not by a synthetic composite: an id-less
  // entry carries ONLY its bare name (`id === name`), so two id-less tags sharing
  // a name are indistinguishable here — there is no id to tell a `category` value
  // `human` from an `origin` value `human` once both arrive without one. Keying by
  // `(name, dimension)` would just emit two identical `{ id: name, name }` rows, a
  // duplicate that is worse than the collapse. So they intentionally collapse to
  // one; the by-id merge above is what actually preserves two same-named tags,
  // and it fires whenever either carries a real upstream id (the common case).
  const synthetic = new Map();
  // listTagsForProject and listStandaloneProjectTags (and its catch) each always
  // resolve `{ items: [...] }`, so no defensive `?.`/`|| []` is needed here.
  const all = [...fromPrompts.items, ...standalone.items];
  for (const t of all) {
    if (t && hasText(t.name)) {
      const id = hasText(t.id) ? String(t.id) : t.name;
      if (id === t.name) {
        if (!synthetic.has(t.name)) {
          synthetic.set(t.name, { id, name: t.name });
        }
      } else if (!byId.has(id)) {
        byId.set(id, { id, name: t.name });
      }
    }
  }
  // Drop a placeholder once a real, id-carrying tag of the same name exists, so
  // the canonical id never sits beside a name-shaped stand-in for it.
  const realNames = new Set([...byId.values()].map((t) => t.name));
  for (const [name, entry] of synthetic) {
    if (!realNames.has(name)) {
      byId.set(entry.id, entry);
    }
  }
  return { items: [...byId.values()] };
}

/**
 * GET /serenity/models (subworkspace). No params → the union of models enabled
 * across all the workspace's projects. With (geoTargetId, languageCode) → models
 * on the slice's project, resolved from the live listing. Partial params → 400. A
 * missing slice returns an empty set, matching the flat-mode models contract.
 * @param {SerenityTransport} transport
 */
export async function handleListModelsSubworkspace(transport, workspaceId, query, log) {
  const geoTargetId = normalizeGeoTargetId(query?.geoTargetId);
  const languageCode = normalizeLanguageCode(query?.languageCode);

  if (geoTargetId === null && languageCode === null) {
    const projects = await resolveProjects(transport, workspaceId);
    const projectIds = projects.filter((p) => p?.id != null).map((p) => String(p.id));
    return listUnionModels(transport, workspaceId, projectIds);
  }
  if (geoTargetId === null || languageCode === null) {
    throw new ErrorWithStatusCode(
      'Provide both geoTargetId and languageCode to query a specific market, or omit both for the workspace catalog',
      400,
    );
  }
  const project = await resolveProject(transport, workspaceId, geoTargetId, languageCode, log);
  if (!project) {
    return { items: [] };
  }
  return listSliceModels(transport, workspaceId, String(project.id));
}

/**
 * PUT /serenity/models (subworkspace) — replace the AI-model set for a slice. Resolves
 * the slice's project from the live listing (404 if absent), then reuses the
 * shared diff-based sync. Validation mirrors the flat-mode handler exactly.
 *
 * @param {SerenityTransport} transport
 * @param {string} workspaceId
 * @param {object} body
 * @param {object} log
 * @param {object} [options]
 * @param {string | null} [options.orgId] - serenity-docs#72 §5 alert payload only.
 * @param {string | null} [options.brandId] - serenity-docs#72 §5 alert payload only.
 * @param {object | null} [options.env] - serenity-docs#72 §5 alert kill-switch/config only.
 */
export async function handleUpdateModelsSubworkspace(
  transport,
  workspaceId,
  body,
  log,
  {
    orgId = null,
    brandId = null,
    env = null,
  } = {},
) {
  const geoTargetId = normalizeGeoTargetId(Number(body?.geoTargetId));
  const languageCode = normalizeLanguageCode(body?.languageCode);
  if (geoTargetId === null || languageCode === null) {
    throw new ErrorWithStatusCode(
      'geoTargetId (integer) and languageCode (BCP-47 primary subtag) are required',
      400,
    );
  }
  const modelIds = body?.modelIds;
  if (!Array.isArray(modelIds) || !modelIds.every((id) => hasText(id))) {
    throw new ErrorWithStatusCode('modelIds must be an array of non-empty strings', 400);
  }
  if (modelIds.length > MAX_MODEL_IDS) {
    throw new ErrorWithStatusCode(`modelIds must not exceed ${MAX_MODEL_IDS} entries`, 400);
  }

  const project = await resolveProject(transport, workspaceId, geoTargetId, languageCode, log);
  if (!project) {
    throw new ErrorWithStatusCode('Market not found for this brand', 404);
  }
  const projectId = String(project.id);

  const result = await syncModelsForProject(
    transport,
    workspaceId,
    projectId,
    modelIds,
    { geoTargetId, languageCode },
    log,
    // serenity-docs#72 §5: feeds the shared syncModelsForProject publish-catch's alert.
    {
      alertContext: { orgId, brandId, env },
    },
  );

  return result;
}
