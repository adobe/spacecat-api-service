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
import { createSerenityTransport, SerenityTransportError } from './rest-transport.js';
import { resolveWorkspaceId } from './workspace-resolver.js';
import { RELEASE_ALLOCATION } from './workspace-lifecycle.js';
import { handleCreateMarketSubworkspace } from './handlers/markets-subworkspace.js';
import { STANDARD_PROMPT_TAGS, PROJECT_STANDARD_TAGS } from './prompt-tags.js';

// Re-exported for callers/tests that drive brand provisioning. The tag
// vocabularies themselves live in `prompt-tags.js` (single source of truth).
export { STANDARD_PROMPT_TAGS, PROJECT_STANDARD_TAGS };

// Brand-create generation policy (tunable). Keep the top N generated topics by
// search volume; brand-topics returns up to 10 topics x up to 100 prompts each,
// so an uncapped attach could be ~1000 prompts — cap keeps the project focused
// and the synchronous create within budget.
export const MAX_TOPICS_ON_CREATE = 5;

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
 * driven through a lightweight brand stub: it supplies the brand's name + the
 * pre-generated id for the "Name [id]" sub-workspace title (the adoption key) and
 * captures the created sub-workspace id. There is no row yet, so the stub's
 * `save` is a no-op — the caller persists the returned id onto the new row.
 *
 * @param {object} context - request context (env, dataAccess, pathInfo headers).
 * @param {object} params
 * @param {string} params.spaceCatId - SpaceCat organization UUID.
 * @param {string} params.brandId - pre-generated brand UUID (sub-workspace title key).
 * @param {string} params.brandName - brand display name (sub-workspace title + brand_name).
 * @param {string} params.market - ISO-2 country code for the initial market.
 * @param {string} params.languageCode - BCP-47 language code for the initial market.
 * @param {string} params.brandDomain - brand domain for the upstream project.
 * @param {string[]} params.modelIds - AI models (LLMs) to attach to the project.
 * @param {boolean} [params.generateTopics] - when true (default), generate +
 *   attach topics/prompts (top N by volume) at create; when false, create the
 *   project empty (models still attached when supplied).
 * @param {Array<string|{name: string, regions?: string[]}>} [params.brandAliases]
 *   - brand aliases; region-clamped to the initial market by the create handler.
 *   With the brand name they classify each generated prompt as `type:branded` /
 *   `type:non-branded` and populate the project's `brand_names`.
 * @param {object} [params.brandUrlSources] - the brand's URL sources
 *   ({ urls, socialAccounts, earnedContent }) pushed onto the initial market's
 *   own-brand benchmark (own sites + social + earned). Best-effort: a failed
 *   push is logged and skipped, never aborts provisioning.
 * @param {object[]} [params.competitors] - the brand's competitors ("other
 *   brands to track") tracked as region-filtered project benchmarks (domain-only).
 *   Best-effort: a failed sync is logged and skipped, never aborts provisioning.
 * @param {object} [log]
 * @returns {Promise<{semrushWorkspaceId: string, published: boolean}>} the new
 *   sub-workspace id and whether the initial market was published. Publish is
 *   required (`publishMode: 'require'`): a quota 405 does NOT return a draft, it
 *   throws (surfaced as 409 "Quota exceeded").
 * @throws {ErrorWithStatusCode} on workspace/project create or publish failure
 *   (the caller then skips the brand write). URL and competitor propagation are
 *   best-effort and never throw.
 */
export async function provisionBrandSubworkspace(context, {
  spaceCatId, brandId, brandName, market, languageCode, brandDomain,
  modelIds = [], brandAliases = [], brandUrlSources = null, competitors = [],
  generateTopics = true,
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

  /** @type {string|null} */
  let capturedWorkspaceId = null;
  const brandStub = {
    getId: () => brandId,
    getName: () => brandName,
    getSemrushWorkspaceId: () => undefined,
    setSemrushWorkspaceId: (id) => { capturedWorkspaceId = id; },
    save: async () => {},
  };

  // If provisioning fails AFTER ensureSubworkspace already created the
  // sub-workspace (captured via the stub) — e.g. a publish 405, a 4xx project
  // result, or any later throw — release its allocation back to the parent pool.
  // Otherwise a resourced, unreferenced sub-workspace leaks: the brand row is
  // never written (so the caller's `provisionedWorkspaceId` stays null and its
  // compensation can't fire), and repeated failed creates would drain the pool.
  // Best-effort; never masks the original error.
  const releaseCapturedOnFailure = async () => {
    if (!capturedWorkspaceId || !hasText(capturedWorkspaceId)) {
      return;
    }
    try {
      await transport.transferWorkspaceResources(capturedWorkspaceId, RELEASE_ALLOCATION);
      log?.info?.('serenity: released sub-workspace allocation after failed brand provisioning', {
        semrushWorkspaceId: capturedWorkspaceId,
      });
    } catch (releaseErr) {
      log?.error?.('serenity: failed to release sub-workspace allocation after failed provisioning', {
        semrushWorkspaceId: capturedWorkspaceId,
        error: releaseErr?.message,
      });
    }
  };

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
      // generates+attaches topics/prompts (top N by volume, tagged `topic:<NAME>`
      // + standard tags) before publishing. With generateTopics=false the project
      // is created empty (no prompts); models are still attached when supplied.
      {
        modelIds,
        generateTopics,
        topicCap: generateTopics ? MAX_TOPICS_ON_CREATE : 0,
        standardTags: [...STANDARD_PROMPT_TAGS],
        brandAliases,
        projectTags: [...PROJECT_STANDARD_TAGS],
        brandUrlSources,
        competitors,
        // A project with neither models nor generated prompts would publish
        // "empty units", which Semrush rejects with a disguised quota 405
        // (workspace doc §5). Tolerate that by leaving it a draft (best-effort)
        // instead of failing the whole create; a project that has models OR
        // prompts has real units and must publish (require).
        publishMode: (Array.isArray(modelIds) && modelIds.length > 0) || generateTopics
          ? 'require'
          : 'best-effort',
      },
    );
  } catch (e) {
    await releaseCapturedOnFailure();
    // A bare upstream 405 is Semrush's disguised quota rejection (a prompt write
    // or publish that exceeds the child's metered quota — workspace doc §5).
    // Surface it as a clear "Quota exceeded" instead of the cryptic 405/nginx body.
    if (e instanceof SerenityTransportError && e.status === 405) {
      throw new ErrorWithStatusCode('Quota exceeded', 409);
    }
    throw e;
  }

  if (result?.status >= 400) {
    await releaseCapturedOnFailure();
    throw new ErrorWithStatusCode(
      result.body?.message || 'Failed to provision Semrush sub-workspace',
      result.status,
    );
  }
  if (!capturedWorkspaceId || !hasText(capturedWorkspaceId)) {
    throw new ErrorWithStatusCode('Semrush provisioning returned no sub-workspace id', 502);
  }
  return {
    semrushWorkspaceId: capturedWorkspaceId,
    published: Boolean(/** @type {{ published?: boolean }} */ (result.body || {}).published),
  };
}

/**
 * Best-effort cleanup for a sub-workspace that was provisioned upstream but whose
 * brand row was never written (e.g. the post-provision DB upsert threw). Because
 * the brand id was a throwaway UUID never persisted, nothing references this
 * workspace, so it would otherwise leak and permanently hold its CREATE allocation
 * against the parent pool. Releasing the allocation hands the quota back. The
 * sub-workspace itself is never deleted (deletion is fail-closed) — it is left
 * empty and reclaimable. Never throws: the caller is already on an error path, so
 * a failed release is logged at ERROR (with the workspace id, for manual recovery)
 * and swallowed.
 *
 * @param {object} context - request context (env, pathInfo headers, attributes).
 * @param {string} workspaceId - the orphaned sub-workspace id to release.
 * @param {object} [log]
 */
export async function releaseProvisionedWorkspace(context, workspaceId, log = console) {
  if (!hasText(workspaceId)) {
    return;
  }
  try {
    // Prefer x-promise-token, matching every other Semrush-transport call site
    // — keeps the IMS-only forwarding invariant uniform even though this
    // helper is only reachable after provisioning already passed it.
    const imsToken = await resolveSemrushImsToken(context, log, 'brand-provisioning');
    const transport = createSerenityTransport({ env: context.env, imsToken });
    await transport.transferWorkspaceResources(workspaceId, RELEASE_ALLOCATION);
    log?.info?.('serenity: released orphaned subworkspace allocation back to parent pool', {
      semrushWorkspaceId: workspaceId,
    });
  } catch (e) {
    log?.error?.('serenity: failed to release orphaned subworkspace allocation', {
      semrushWorkspaceId: workspaceId,
      error: e?.message,
    });
  }
}
