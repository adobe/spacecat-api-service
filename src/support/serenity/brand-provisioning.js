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

import { ErrorWithStatusCode, resolveSemrushImsToken } from '../utils.js';
import { createSerenityTransport } from './rest-transport.js';
import { isSemrushTransportError } from './errors.js';
import { resolveWorkspaceId } from './workspace-resolver.js';
import { deleteAllProjects, ensureSubworkspace } from './workspace-lifecycle.js';
import { handleCreateMarketSubworkspace } from './handlers/markets-subworkspace.js';
import { isSerenityDeferPublishEnabled } from './defer-publish-active.js';
import { computeWriteDeadline } from './intent-classification.js';
import { isDynamicAllocationEnabled, resolveBrandAiCeiling } from './dynamic-allocation-active.js';
import { resolveCanonicalDefaultModelIds } from './default-models.js';

// Brand-create generation policy (tunable). Keep the top N generated topics by
// search volume; brand-topics returns up to 10 topics x up to 100 prompts each,
// so an uncapped attach could be ~1000 prompts — cap keeps the project focused
// and the synchronous create within budget.
export const MAX_TOPICS_ON_CREATE = 5;

/**
 * Empties a sub-workspace this service provisioned, best-effort. Deletes every project and leaves
 * the (now-empty) shell in place — production never deletes a sub-workspace, and the shell carries
 * no resource allocation to reclaim (see `workspace-lifecycle.js`).
 *
 * Never throws: every caller is already on an error path, so a failure here is logged at ERROR
 * (with the workspace id, for manual recovery) and swallowed rather than masking the original
 * error. The log messages are fixed literals with the call site in the structured `phase` field,
 * so one grep finds every occurrence of this failure class across all provisioning paths.
 *
 * @param {object} transport
 * @param {string} workspaceId - the sub-workspace to empty.
 * @param {string|undefined} parentWorkspaceId - the org parent; the assertNotParent guard input.
 * @param {object} [log]
 * @param {string} [phase] - which provisioning path is cleaning up (structured log dimension).
 * @returns {Promise<void>}
 */
async function emptyWorkspaceBestEffort(transport, workspaceId, parentWorkspaceId, log, phase) {
  try {
    await deleteAllProjects(transport, workspaceId, parentWorkspaceId);
    log?.info?.('serenity: emptied sub-workspace', { semrushWorkspaceId: workspaceId, phase });
  } catch (emptyErr) {
    log?.error?.('serenity: failed to empty sub-workspace', {
      semrushWorkspaceId: workspaceId, phase, error: emptyErr?.message,
    });
  }
}

/**
 * Initial-market project name convention: "REGION - LANG" — uppercase ISO-2
 * country code + uppercase primary language subtag (e.g. "US - EN", "CH - DE").
 * Matches the names existing sub-workspace projects already carry.
 */
export function initialMarketProjectName(market, languageCode) {
  const region = String(market || '').toUpperCase();
  const lang = String(languageCode || '').split('-')[0].toUpperCase();
  return `${region} - ${lang}`;
}

/**
 * Serenity-first provisioning for a brand created in Semrush-prompts mode
 * (serenity dual-mode). Creates the brand's Semrush sub-workspace (named after
 * the brand) and one DRAFT AIO project for the (market, languageCode) slice
 * BEFORE the brand row is written, so a brand only ever exists once its Semrush
 * side is valid ("only valid things on our side"). Models and generated
 * topics/prompts are attached, then the initial market is published
 * synchronously (`publishMode: 'require'`) so the brand goes live on create; a
 * quota 405 from publishing surfaces as a 409 "Quota exceeded".
 *
 * The brand row is written by the caller AFTER this resolves, so provisioning is
 * driven through a lightweight brand stub: it supplies the brand's display name (the
 * sub-workspace title) plus the pre-generated brand id, and captures the resolved
 * sub-workspace id. There is no row yet, so the stub's `save` is a no-op — the caller
 * persists the returned id onto the new row. Because no row exists, this brand cannot yet
 * claim a sub-workspace, so every claimed family candidate the adoption filter sees belongs
 * to some other brand.
 *
 * @param {object} context - request context (env, dataAccess, pathInfo headers).
 * @param {object} params
 * @param {string} params.spaceCatId - SpaceCat organization UUID.
 * @param {string} params.brandId - pre-generated brand UUID.
 * @param {string} params.brandName - brand display name (sub-workspace title + brand_name).
 * @param {string} params.market - ISO-2 country code for the initial market.
 * @param {string} params.languageCode - BCP-47 language code for the initial market.
 * @param {string} params.brandDomain - brand domain for the upstream project.
 * @param {string[]} [params.modelIds] - AI models (LLMs) to attach to the
 *   project. This is always the brand's FIRST-EVER market (the sub-workspace
 *   is freshly created below), so an empty/omitted list resolves to the
 *   canonical net-new default set (LLMO-6554 / LLMO-6338 — see
 *   {@link resolveCanonicalDefaultModelIds}) rather than creating a
 *   zero-model project that can't publish real units.
 * @param {boolean} [params.generateTopics] - when true (default), generate +
 *   attach topics/prompts (top N by volume) at create; when false, create the
 *   project empty (models still attached when supplied).
 * @param {Array<string|{name: string, regions?: string[]}>} [params.brandAliases]
 *   - brand aliases; region-clamped to the initial market by the create handler.
 *   With the brand name they classify each generated prompt under the `type`
 *   dimension as `branded` / `non-branded`, and populate the project's
 *   `brand_names`.
 * @param {object} [params.brandUrlSources] - the brand's URL sources
 *   ({ urls, socialAccounts, earnedContent }) pushed onto the initial market's
 *   own-brand benchmark (own sites + social + earned). Best-effort: a failed
 *   push is logged and skipped, never aborts provisioning.
 * @param {object[]} [params.competitors] - the brand's competitors ("other
 *   brands to track") tracked as region-filtered project benchmarks (domain-only).
 *   Best-effort: a failed sync is logged and skipped, never aborts provisioning.
 * @param {number} [params.writeDeadline] - shared request-write deadline (epoch
 *   ms), computed once at controller entry and threaded down so intent
 *   classification budgets against the true request start (serenity-docs#32);
 *   defaults to a fresh {@link computeWriteDeadline} for direct/test callers.
 * @param {object} [log]
 * @returns {Promise<{
 *   semrushSubWorkspaceId: string,
 *   createdByThisRequest: boolean,
 *   published: boolean,
 *   projectId: string,
 *   geoTargetId: number | null,
 *   languageCode: string,
 * }>} the new sub-workspace id, whether this request CREATED that sub-workspace (as opposed
 *   to adopting an existing same-title one — the caller's failure compensation must gate on
 *   it, see {@link provisionBrandSubworkspaceBare}), whether the initial market was published, and
 *   the initial market's identity — deliberately NOT written to
 *   `brand_to_semrush_projects` here (this function runs before the brand row
 *   exists, and the mapping row's FK requires it); the caller writes the
 *   mapping row itself once the brand row is persisted, mirroring how it
 *   already handles `ensureMarketSite` (see `controllers/brands.js`). Publish
 *   is required (`publishMode: 'require'`): a quota 405 does NOT return a
 *   draft, it throws (surfaced as 409 "Quota exceeded").
 * @throws {ErrorWithStatusCode} on workspace/project create or publish failure
 *   (the caller then skips the brand write). URL and competitor propagation are
 *   best-effort and never throw.
 */
export async function provisionBrandSubworkspace(context, {
  spaceCatId, brandId, brandName, market, languageCode, brandDomain,
  modelIds = [], brandAliases = [], brandUrlSources = null, competitors = [],
  generateTopics = true, writeDeadline = computeWriteDeadline(),
}, log = console) {
  if (!hasText(brandName)) {
    throw new ErrorWithStatusCode('brandName is required for Semrush provisioning', 400);
  }
  if (!hasText(brandId)) {
    throw new ErrorWithStatusCode('brandId is required for Semrush provisioning', 400);
  }
  if (!hasText(brandDomain)) {
    throw new ErrorWithStatusCode('brandDomain is required for Semrush provisioning', 400);
  }
  // market/languageCode are OPTIONAL: a brand created WITHOUT prompt generation
  // (generateTopics=false) may omit them. Fall back to the US/EN default slice so
  // the project still has a valid (geo, language) to provision against. When
  // generateTopics=true the caller (brands.js) still requires both, so a fallback
  // never silently mislabels a prompt-generating project.
  const resolvedMarket = hasText(market) ? market : 'US';
  const resolvedLanguageCode = hasText(languageCode) ? languageCode : 'en';

  const parentWorkspaceId = await resolveWorkspaceId(context, spaceCatId);
  if (!parentWorkspaceId || !hasText(parentWorkspaceId)) {
    throw new ErrorWithStatusCode('Organization has no Semrush workspace configured', 400);
  }

  // Match the /serenity/* IMS-only contract: the upstream gateway only
  // understands IMS user tokens. POST /brands is organization:write and thus
  // S2S-reachable, so prefer an x-promise-token exchange (same as serenity.js/
  // elements.js) and otherwise fall back to strict IMS-bearer forwarding,
  // 401ing a non-IMS bearer before it can be proxied upstream.
  const imsToken = await resolveSemrushImsToken(context, log, 'brand-provisioning');
  const transport = createSerenityTransport({ env: context.env, imsToken });

  // LLMO-6554: this is always the brand's FIRST-EVER market (the sub-workspace is
  // freshly created below), so there is nothing to mirror — an empty/omitted
  // caller-supplied modelIds resolves straight to the canonical net-new default.
  // A non-empty caller-supplied list (a future API-driven caller) is honored as-is.
  const resolvedModelIds = Array.isArray(modelIds) && modelIds.length > 0
    ? modelIds
    : await resolveCanonicalDefaultModelIds(transport, log);

  // Dynamic-allocation kill-switch + per-brand ceiling (LLMO-6190): brand creation is onboarding,
  // and §3/§4a of the design require an onboarded-while-ON brand to get JIT top-up on its first
  // metered op like every other subworkspace write path (activate, create-market, create-prompts,
  // update-models). Threaded here so brand creation is not silently excluded from the allocator.
  const dynamicAllocation = isDynamicAllocationEnabled(context.env);
  const ceiling = resolveBrandAiCeiling(context.env, log);

  /** @type {string|null} */
  let capturedWorkspaceId = null;
  // Set ONLY when ensureSubworkspace freshly created the sub-workspace. A workspace it
  // ADOPTED is not ours to tear down: titles are bare brand names, so an adopted workspace
  // can belong to a same-named sibling brand whose provisioning is still in flight and has
  // not yet persisted its claim — emptying it would destroy that brand's live workspace.
  /** @type {string|null} */
  let createdWorkspaceId = null;
  const brandStub = {
    getId: () => brandId,
    getName: () => brandName,
    getSemrushSubWorkspaceId: () => undefined,
    setSemrushSubWorkspaceId: (id) => { capturedWorkspaceId = id; },
    save: async () => {},
  };

  // If provisioning fails AFTER ensureSubworkspace already created the
  // sub-workspace (captured via the stub) — e.g. a publish 405, a 4xx project
  // result, or any later throw — empty it again. Otherwise a populated,
  // unreferenced sub-workspace leaks: the brand row is never written (so the
  // caller's `provisionedWorkspaceId` stays null and its compensation can't fire),
  // leaving stray projects on a shell nothing points at.
  // Best-effort; never masks the original error.
  //
  // The workspace shell itself is left in place (production never deletes a sub-workspace) and
  // holds no allocation to reclaim. It may already have a project in it at this point (a failure
  // at/after createProject) or may still be empty (an earlier failure) — deleteAllProjects
  // tolerates both.
  const emptyCapturedOnFailure = async () => {
    // Narrow via a const — a closure-mutated `let` is not narrowed by control flow
    // (see this dir's CLAUDE.md).
    const wsId = createdWorkspaceId;
    if (!wsId || !hasText(wsId)) {
      return;
    }
    await emptyWorkspaceBestEffort(transport, wsId, parentWorkspaceId, log, 'brand-create');
  };

  // LLMO-5492 publish-after-populate: defer-publish flag ON → leave the project a
  // DRAFT ('skip') for a later finalize step (prompts + models pushed, published
  // once). OFF (default) preserves inline publish: a project with models OR
  // generated prompts has real units and must publish ('require'); an empty
  // project would publish "empty units" (a disguised quota 405), so leave it a
  // draft ('best-effort') instead of failing the create. Checked against
  // resolvedModelIds, not the raw caller-supplied modelIds: LLMO-6554 resolves an
  // empty/omitted modelIds to the canonical net-new default, so resolvedModelIds
  // is non-empty in the common case — checking the raw list would wrongly fall
  // through to 'best-effort' (leaving a model-bearing project as an unpublished
  // draft) whenever the caller omitted modelIds.
  /** @type {'require' | 'best-effort' | 'skip'} */
  let publishMode = 'best-effort';
  if (isSerenityDeferPublishEnabled(context.env)) {
    publishMode = 'skip';
  } else if ((Array.isArray(resolvedModelIds) && resolvedModelIds.length > 0) || generateTopics) {
    publishMode = 'require';
  }

  let result;
  try {
    result = await handleCreateMarketSubworkspace(
      transport,
      brandStub,
      parentWorkspaceId,
      {
        market: resolvedMarket,
        languageCode: resolvedLanguageCode,
        brandDomain,
        brandNames: [brandName],
        brandDisplayName: brandName,
        name: initialMarketProjectName(resolvedMarket, resolvedLanguageCode),
      },
      log,
      // preResolvedWorkspaceId / reloadPointer: defaults (single-create path).
      null,
      null,
      // Brand-create attaches the chosen LLMs and, WHEN generateTopics is set,
      // generates+attaches prompts (top N topics by volume, each prompt carrying
      // the standard closed-dimension values plus its branded/non-branded `type`
      // value) before publishing. The dimension-root taxonomy is provisioned on
      // every project regardless. With generateTopics=false the project is created
      // empty (no prompts); models are still attached when supplied.
      {
        modelIds: resolvedModelIds,
        generateTopics,
        topicCap: generateTopics ? MAX_TOPICS_ON_CREATE : 0,
        brandAliases,
        env: context.env,
        writeDeadline,
        brandUrlSources,
        competitors,
        publishMode,
        dynamicAllocation,
        ceiling,
        brandCollection: context?.dataAccess?.Brand,
        onWorkspaceCreated: (id) => { createdWorkspaceId = id; },
      },
    );
  } catch (e) {
    await emptyCapturedOnFailure();
    // A bare upstream 405 is Semrush's disguised quota rejection (a prompt write
    // or publish that exceeds the child's metered quota — workspace doc §5).
    // Surface it as a clear "Quota exceeded" instead of the cryptic 405/nginx body.
    if (isSemrushTransportError(e) && e.status === 405) {
      throw new ErrorWithStatusCode('Quota exceeded', 409);
    }
    throw e;
  }

  if (result?.status >= 400) {
    await emptyCapturedOnFailure();
    throw new ErrorWithStatusCode(
      result.body?.message || 'Failed to provision Semrush sub-workspace',
      result.status,
    );
  }
  if (!capturedWorkspaceId || !hasText(capturedWorkspaceId)) {
    throw new ErrorWithStatusCode('Semrush provisioning returned no sub-workspace id', 502);
  }
  // handleCreateMarketSubworkspace's own body already carries the initial
  // market's identity (geoTargetId/languageCode resolved from the same
  // resolvedMarket/resolvedLanguageCode this call passed in) — read it back
  // rather than re-deriving it.
  /** @type {any} */
  const resultBody = result.body || {};
  return {
    semrushSubWorkspaceId: capturedWorkspaceId,
    // See provisionBrandSubworkspaceBare's @returns: the caller's failure compensation must
    // gate on this so it never tears down a merely-adopted sibling brand's workspace.
    createdByThisRequest: createdWorkspaceId === capturedWorkspaceId,
    published: Boolean(resultBody.published),
    projectId: String(resultBody.projectId || ''),
    // Absent stays null (not 0) so upsertMappingRow's `!geoTargetId` guard
    // rejects an unresolvable slice explicitly rather than persisting a
    // sentinel value.
    geoTargetId: resultBody.geoTargetId != null ? Number(resultBody.geoTargetId) : null,
    languageCode: String(resultBody.languageCode || resolvedLanguageCode),
  };
}

/**
 * Sub-workspace-only provisioning for a brand created in Semrush mode WITHOUT an
 * initial market (LLMO-6405). Market-scoped inputs moved out of brand creation, so
 * a serenity-active brand is created with just its Semrush sub-workspace (the
 * active-brand anchor) and NO project; its markets are added afterwards from the
 * Markets tab. Mirrors {@link provisionBrandSubworkspace}'s serenity-first contract
 * (sub-workspace created BEFORE the brand row via a lightweight stub whose `save` is
 * a no-op; the caller persists the returned id onto the new row). On failure the
 * just-created sub-workspace's projects are emptied and the shell is left in place — it holds no
 * allocation to reclaim, and production never deletes a sub-workspace.
 *
 * @param {object} context - request context (env, dataAccess, pathInfo headers).
 * @param {object} params
 * @param {string} params.spaceCatId - SpaceCat organization UUID.
 * @param {string} params.brandId - pre-generated brand UUID.
 * @param {string} params.brandName - brand display name (sub-workspace title).
 * @param {object} [log]
 * @returns {Promise<{ semrushSubWorkspaceId: string, createdByThisRequest: boolean }>} the
 *   sub-workspace id, plus whether this request CREATED it (as opposed to adopting an existing
 *   same-title one). The caller's failure compensation must gate on `createdByThisRequest`:
 *   titles are bare brand names, so an adopted workspace can belong to a same-named sibling
 *   brand whose own provisioning has not yet persisted its claim, and releasing it would empty
 *   that brand's live sub-workspace.
 * @throws {ErrorWithStatusCode} on workspace create failure (the caller then skips
 *   the brand write).
 */
export async function provisionBrandSubworkspaceBare(context, {
  spaceCatId, brandId, brandName,
}, log = console) {
  if (!hasText(brandName)) {
    throw new ErrorWithStatusCode('brandName is required for Semrush provisioning', 400);
  }
  if (!hasText(brandId)) {
    throw new ErrorWithStatusCode('brandId is required for Semrush provisioning', 400);
  }

  const parentWorkspaceId = await resolveWorkspaceId(context, spaceCatId);
  if (!parentWorkspaceId || !hasText(parentWorkspaceId)) {
    throw new ErrorWithStatusCode('Organization has no Semrush workspace configured', 400);
  }

  const imsToken = await resolveSemrushImsToken(context, log, 'brand-provisioning');
  const transport = createSerenityTransport({ env: context.env, imsToken });

  /** @type {string|null} */
  let capturedWorkspaceId = null;
  // Set ONLY when ensureSubworkspace freshly created the sub-workspace — see the identical
  // note in provisionBrandSubworkspace above for why an ADOPTED one must never be emptied.
  /** @type {string|null} */
  let createdWorkspaceId = null;
  const brandStub = {
    getId: () => brandId,
    getName: () => brandName,
    getSemrushSubWorkspaceId: () => undefined,
    setSemrushSubWorkspaceId: (id) => { capturedWorkspaceId = id; },
    save: async () => {},
  };

  try {
    // createReadiness: 'skip' (LLMO-6569) — this path creates NO project/prompts, so nothing
    // downstream needs a settled workspace. Skipping the up-to-30s settle poll lets the
    // sub-workspace pointer be captured/persisted immediately (instead of after the poll) and lets
    // the workspace settle asynchronously; the first market-add later settles it before creating a
    // project. Pre-fix, a poll timeout here fired BEFORE the id was captured, so the failure
    // cleanup saw a null id and no-op'd — leaking the sub-workspace upstream with no brand row yet
    // referencing it. (The "created upstream but never linked" orphan is the ACTIVATE variant,
    // where the brand row already exists — see serenity.js.) This is Rainer's point #1 ("we don't
    // create markets in that").
    const subWorkspaceId = await ensureSubworkspace(
      transport,
      brandStub,
      parentWorkspaceId,
      log,
      {},
      null,
      // The brand row does not exist yet on this path (it is written only after a
      // successful provision), so ANY family candidate the claim lookup finds bound
      // to a brand is provably another brand's — never this one's.
      {
        // createReadiness 'skip' (LLMO-6569): bare create makes no project/prompts, so skip the
        // up-to-30s settle poll and persist the pointer immediately; the workspace settles async.
        createReadiness: 'skip',
        brandCollection: context?.dataAccess?.Brand,
        onWorkspaceCreated: (id) => { createdWorkspaceId = id; },
      },
    );
    const resolved = hasText(subWorkspaceId) ? subWorkspaceId : capturedWorkspaceId;
    if (!resolved || !hasText(resolved)) {
      throw new ErrorWithStatusCode('Semrush provisioning returned no sub-workspace id', 502);
    }
    return {
      semrushSubWorkspaceId: resolved,
      createdByThisRequest: createdWorkspaceId === resolved,
    };
  } catch (e) {
    // Empty the sub-workspace on failure — the brand row is never written, so nothing
    // references it. Best-effort; never masks the original error.
    // deleteAllProjects tolerates an empty workspace. Only a workspace this request
    // CREATED is emptied; an adopted one may be a same-named sibling brand's.
    // Narrow via a const (hasText is not a type guard, and a closure-mutated `let`
    // is not narrowed by control flow — see this dir's CLAUDE.md).
    const wsId = createdWorkspaceId;
    if (wsId && hasText(wsId)) {
      await emptyWorkspaceBestEffort(transport, wsId, parentWorkspaceId, log, 'bare-brand-create');
    }
    throw e;
  }
}

/**
 * Best-effort cleanup for a sub-workspace that was provisioned upstream but whose
 * brand row was never written (e.g. the post-provision DB upsert threw). Because
 * the brand id was a throwaway UUID never persisted, nothing references this
 * workspace, so its projects would otherwise linger on a shell nothing points at.
 *
 * At this point provisioning fully SUCCEEDED (project created, models attached, possibly
 * published) before the subsequent brand-row write failed — the workspace always has exactly one
 * project. Deletes that project and leaves the (now-empty) shell in place; production never
 * deletes a sub-workspace, and the shell holds no allocation to reclaim. Never throws: the caller
 * is already on an error path, so any failure here is logged at ERROR (with the workspace id, for
 * manual recovery) and swallowed.
 *
 * @param {object} context - request context (env, pathInfo headers, attributes).
 * @param {string} workspaceId - the orphaned sub-workspace id to empty.
 * @param {string} [spaceCatId] - the organization UUID, used to resolve the org's parent workspace
 *   for the assertNotParent guard inside `deleteAllProjects`. Omit only when unavailable (the
 *   guard then simply cannot fire); every known caller has it in scope.
 * @param {object} [log]
 */
export async function emptyProvisionedWorkspace(
  context,
  workspaceId,
  spaceCatId = undefined,
  log = console,
) {
  if (!hasText(workspaceId)) {
    return;
  }
  const PHASE = 'orphaned-brand-row';
  try {
    // Prefer x-promise-token, matching every other Semrush-transport call site
    // — keeps the IMS-only forwarding invariant uniform even though this
    // helper is only reachable after provisioning already passed it.
    const imsToken = await resolveSemrushImsToken(context, log, 'brand-provisioning');
    const transport = createSerenityTransport({ env: context.env, imsToken });
    // typeof narrows `string | undefined` → `string` (hasText is not a type guard — see this
    // dir's CLAUDE.md); resolveWorkspaceId can resolve `null`, normalised to `undefined` for
    // deleteAllProjects's `string | undefined` parentWorkspaceId param.
    const parentWorkspaceId = typeof spaceCatId === 'string' && hasText(spaceCatId)
      ? (await resolveWorkspaceId(context, spaceCatId)) ?? undefined
      : undefined;
    await deleteAllProjects(transport, workspaceId, parentWorkspaceId);
    log?.info?.('serenity: emptied sub-workspace', { semrushWorkspaceId: workspaceId, phase: PHASE });
  } catch (e) {
    // This try deliberately spans IMS-token + transport + parent resolution as well as the
    // delete, so it cannot delegate to emptyWorkspaceBestEffort — an acquisition failure must be
    // swallowed here too. It emits the same literals and `phase` dimension so the two paths stay
    // greppable as one failure class.
    log?.error?.('serenity: failed to empty sub-workspace', {
      semrushWorkspaceId: workspaceId, phase: PHASE, error: e?.message,
    });
  }
}
