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

import { hasText } from '@adobe/spacecat-shared-utils';

import { ErrorWithStatusCode } from '../../utils.js';
import { SerenityTransportError } from '../rest-transport.js';
import { ERROR_CODES, isUpstreamGone } from '../errors.js';
import { normalizeGeoTargetId, normalizeLanguageCode } from '../validation.js';
import {
  resolveLocation,
  resolveLanguageId,
  defaultMarketName,
  listTagsForProject,
  listGlobalModelCatalog,
  listSliceModels,
  syncModelsForProject,
  MAX_MODEL_IDS,
} from './markets.js';
import {
  listMarkets, resolveProject, mapPublishStatus, projectToSlice,
} from '../subworkspace-projects.js';
import { ensureSubworkspace } from '../workspace-lifecycle.js';
import { TYPE_TAG, topicTag } from '../prompt-tags.js';
import { collectBrandUrlEntries, attachBrandUrlsToProject } from '../brand-urls.js';
import { buildReservedDomains, syncCompetitorBenchmarksForProject } from '../competitor-benchmarks.js';

/**
 * Subworkspace-mode market handlers (serenity design §3/§5). The brand has its own
 * Semrush subworkspace; markets are enumerated live (no BrandSemrushProject
 * mapping). The controller dispatches here when resolveBrandWorkspace returns
 * mode === 'subworkspace'; the flat-mode handlers stay frozen and untouched.
 */

// "live" publish states — a slice that already has a published project (a real
// existing market), vs a leftover draft that a retry should adopt and resume.
const LIVE_STATES = new Set(['live', 'live_with_unpublished_updates']);

function validateSlice(geoTargetId, languageCode) {
  if (normalizeGeoTargetId(geoTargetId) === null) {
    throw new ErrorWithStatusCode('geoTargetId must be a positive integer', 400);
  }
  if (normalizeLanguageCode(languageCode) === null) {
    throw new ErrorWithStatusCode('languageCode must match ^[a-z]{2,3}(-[a-z]{2,4})?$', 400);
  }
}

/** GET /serenity/markets (subworkspace) — one live listing of the subworkspace. */
export async function handleListMarketsSubworkspace(transport, brandId, workspaceId) {
  return { items: await listMarkets(transport, workspaceId, brandId) };
}

/**
 * GET /serenity/markets/:geo/:lang (subworkspace) — resolve the slice from the live
 * listing; surface semrushProjectId + status + `initialized` (one extra
 * init_status read, detail only). 404 marketNotFound if no project matches.
 */
export async function handleGetMarketSubworkspace(
  transport,
  brandId,
  workspaceId,
  geoTargetId,
  languageCode,
  log,
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
  return { ...slice, initialized };
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

function buildCreateProjectBody(body, location, languageId, brandAliases = []) {
  const name = hasText(body?.name) ? String(body.name) : defaultMarketName(body.brandDisplayName);
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
  if (!hasText(body?.brandDomain)) {
    errors.push('brandDomain is required');
  }
  if (!Array.isArray(body?.brandNames) || body.brandNames.length === 0
      || !body.brandNames.every(hasText)) {
    errors.push('brandNames must be a non-empty array of strings');
  }
  return errors;
}

/**
 * Classifies a generated prompt as `type:branded` when its text mentions the
 * brand — i.e. (lower-cased) prompt text contains any of the brand-name/alias
 * `needles` (already lower-cased + trimmed) as a substring — else
 * `type:non-branded`. Empty `needles` ⇒ everything is non-branded.
 */
function brandedTypeTag(promptText, needles) {
  const hay = String(promptText).toLowerCase();
  return needles.some((n) => hay.includes(n)) ? TYPE_TAG.BRANDED : TYPE_TAG.NON_BRANDED;
}

/**
 * Generates topics + prompts for (domain, country) via the AI-SEO service
 * (transport.getBrandTopics) and attaches them to the project. Keeps the top
 * `topicCap` topics by search volume (0 = keep all) and tags every prompt with
 * `topic:<TopicName>`, the caller's `standardTags`, and a branded/non-branded
 * `type:` tag derived from `brandNames` (brand name + aliases). Returns the
 * topic/prompt counts. A generation that yields nothing is a clean no-op (no
 * upstream write).
 *
 * Prompt text is the createTaggedPrompts key, so identical text across topics
 * collapses to one entry (last tag set wins) — acceptable and rare.
 */
async function generateAndAttachPrompts(transport, workspaceId, projectId, {
  domain, country, topicCap = 0, standardTags = [], brandNames = [],
}, log) {
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

  // Brand-name + alias needles for branded classification: lower-cased + trimmed
  // so the substring match is case-insensitive and whitespace-tolerant.
  const brandNeedles = (Array.isArray(brandNames) ? brandNames : [])
    .map((s) => String(s || '').trim().toLowerCase())
    .filter((s) => s.length > 0);

  const promptsByText = {};
  selected.forEach((t) => {
    const topic = topicTag(t.topic);
    (Array.isArray(t.prompts) ? t.prompts : []).forEach((p) => {
      if (hasText(p)) {
        promptsByText[p] = [topic, ...standardTags, brandedTypeTag(p, brandNeedles)];
      }
    });
  });

  const promptCount = Object.keys(promptsByText).length;
  if (promptCount === 0) {
    log?.info?.('generateAndAttachPrompts: no prompts generated', {
      workspaceId, projectId, domain, country,
    });
    return { topicCount: 0, promptCount: 0 };
  }
  await transport.createTaggedPrompts(workspaceId, projectId, promptsByText);
  return { topicCount: selected.length, promptCount };
}

/**
 * POST /serenity/markets (subworkspace, design flow 3) — ensure the subworkspace
 * (lazy-create / re-grant), then create-or-adopt the slice's draft, publish
 * once, and confirm. No mapping write, no rollback: a leftover draft is a
 * resumable state, not an orphan (design §7). The duplicate-create race is
 * accepted (oldest-wins reads + alert).
 *
 * @param {string|null} [preResolvedWorkspaceId] - when set (the activate batch
 *   path), the sub-workspace is already ensured/sized; skip the per-call ensure
 *   and create directly against it. Omitted on the single-market POST path.
 * @param {function|null} [reloadPointer] - lost-update concurrency guard passed
 *   through to ensureSubworkspace on the single-market POST path (see there).
 * @param {object} [options]
 * @param {string[]} [options.modelIds=[]] - AI models (LLMs) to attach to the
 *   project before publishing. A project needs models to track anything.
 * @param {boolean} [options.generateTopics=false] - generate topics+prompts from
 *   `body.brandDomain` + `body.market` and attach them, tagged `topic:<NAME>` +
 *   `standardTags`.
 * @param {number} [options.topicCap=0] - keep only the top N generated topics by
 *   search volume (0 = keep all).
 * @param {string[]} [options.standardTags=[]] - tags added to every generated
 *   prompt in addition to its `topic:<NAME>` and branded `type:` tag.
 * @param {string[]} [options.brandAliases=[]] - brand aliases; brand-level names
 *   the brand is also known by. Added to the project's `brand_names` (alongside
 *   the primary name) so every market/project in the brand carries them, and —
 *   together with the brand name(s) — used to classify each generated prompt as
 *   `type:branded` (text contains a name/alias, case-insensitive) or
 *   `type:non-branded`.
 * @param {string[]} [options.projectTags=[]] - project-level tag taxonomy to
 *   register on the project (via createProjectTags) independent of any prompt.
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
    standardTags = [],
    brandAliases = [],
    projectTags = [],
    brandUrlSources = null,
    competitors = [],
    publishMode = 'require',
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

  // activate() ensures the sub-workspace once for the whole batch (sized to the
  // real market count) and passes it in here. The single-market POST /markets
  // path passes nothing, so we ensure on the spot, sized for one market.
  const workspaceId = hasText(preResolvedWorkspaceId)
    ? preResolvedWorkspaceId
    : await ensureSubworkspace(transport, brand, parentWorkspaceId, 1, log, {}, reloadPointer);

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
      buildCreateProjectBody(body, location, languageId, brandAliases),
    );
    projectId = String(createResp?.id || '');
    if (!hasText(projectId)) {
      return { status: 502, body: { error: 'createNoProjectId', message: 'Upstream createProject returned no id' } };
    }
  }

  // Register the standard tag taxonomy on the project (independent of prompts),
  // so classification can later apply intent/source/type values per prompt.
  if (Array.isArray(projectTags) && projectTags.length > 0) {
    await transport.createProjectTags(workspaceId, projectId, projectTags);
  }

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

  // Generate topics+prompts from the brand domain + market and attach them,
  // tagging each prompt with its `topic:<NAME>` plus the standard tag set.
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
        standardTags,
        // Branded classification needles: the brand's own name(s) + caller aliases.
        brandNames: [
          ...(Array.isArray(body.brandNames) ? body.brandNames : []),
          ...brandAliases,
        ],
      },
      log,
    );
  }

  // Push the brand's URLs (own sites + social + earned) onto this market's
  // own-brand benchmark (created on demand when Semrush hasn't provisioned one),
  // region-filtered to the market. Done before publish so the URLs are part of
  // the same published version. Best-effort: URL enrichment must never abort the
  // brand create — a benchmark/URL hiccup is logged and skipped, not propagated.
  const brandUrlEntries = collectBrandUrlEntries(brandUrlSources, body.market);
  try {
    await attachBrandUrlsToProject(
      transport,
      workspaceId,
      projectId,
      brandUrlEntries,
      { name: body.brandDisplayName, domain: body.brandDomain, aliases: brandAliases },
      log,
    );
  } catch (e) {
    log?.warn?.('handleCreateMarketSubworkspace: brand-URL attach failed (non-fatal)', {
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
    log?.warn?.('handleCreateMarketSubworkspace: competitor benchmark sync failed (non-fatal)', {
      workspaceId, projectId, error: e?.message,
    });
  }

  // Publish per mode. 'best-effort' swallows a quota 405 (publishing an
  // empty-units child 405s as a disguised quota rejection, workspace doc §5) and
  // leaves the project a draft so the brand still succeeds.
  let published = false;
  if (publishMode === 'require') {
    await transport.publishProject(workspaceId, projectId);
    published = true;
  } else if (publishMode === 'best-effort') {
    try {
      await transport.publishProject(workspaceId, projectId);
      published = true;
    } catch (e) {
      if (e instanceof SerenityTransportError && e.status === 405) {
        log?.warn?.('handleCreateMarketSubworkspace: publish skipped — quota 405, project left as draft', {
          workspaceId, projectId,
        });
      } else {
        throw e;
      }
    }
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
 */
export async function handleDeleteMarketSubworkspace(
  transport,
  workspaceId,
  geoTargetId,
  languageCode,
  log,
) {
  validateSlice(geoTargetId, languageCode);
  const lang = normalizeLanguageCode(languageCode);
  const project = await resolveProject(transport, workspaceId, Number(geoTargetId), lang, log);
  if (!project) {
    return { status: 204 };
  }
  try {
    await transport.deleteProject(workspaceId, project.id);
  } catch (e) {
    if (!isUpstreamGone(e)) {
      throw e;
    }
  }
  return { status: 204 };
}

/**
 * GET /serenity/tags (subworkspace) — unique tag names across the slice's prompts.
 * Resolves the slice's project from the live listing, then reuses the shared
 * project-keyed tag aggregation (cache + pagination + truncation guard). A
 * missing slice returns an empty set, matching the flat-mode tags contract.
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
  return listTagsForProject(
    transport,
    workspaceId,
    String(project.id),
    { geoTargetId, languageCode },
    log,
  );
}

/**
 * GET /serenity/models (subworkspace). No params → the (workspace-independent) global
 * catalog. With (geoTargetId, languageCode) → models on the slice's project,
 * resolved from the live listing. Partial params → 400. A missing slice returns
 * an empty set, matching the flat-mode models contract.
 */
export async function handleListModelsSubworkspace(transport, workspaceId, query, log) {
  const geoTargetId = normalizeGeoTargetId(query?.geoTargetId);
  const languageCode = normalizeLanguageCode(query?.languageCode);

  if (geoTargetId === null && languageCode === null) {
    return listGlobalModelCatalog(transport);
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
 */
export async function handleUpdateModelsSubworkspace(transport, workspaceId, body, log) {
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
  return syncModelsForProject(
    transport,
    workspaceId,
    String(project.id),
    modelIds,
    { geoTargetId, languageCode },
    log,
  );
}
