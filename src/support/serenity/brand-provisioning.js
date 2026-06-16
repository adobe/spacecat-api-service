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

import { ErrorWithStatusCode, getImsUserToken } from '../utils.js';
import { createSerenityTransport, SerenityTransportError } from './rest-transport.js';
import { resolveWorkspaceId } from './workspace-resolver.js';
import { handleCreateMarketSubworkspace } from './handlers/markets-subworkspace.js';

// Brand-create generation policy (tunable). Keep the top N generated topics by
// search volume; brand-topics returns up to 10 topics x up to 100 prompts each,
// so an uncapped attach could be ~1000 prompts — cap keeps the project focused
// and the synchronous create within budget.
export const MAX_TOPICS_ON_CREATE = 5;

// Tags added to EVERY generated prompt on top of its `topic:<NAME>` tag. The
// generated prompts are AI-authored, so they carry `source:ai`. Intent and type
// cannot be determined at generation time and are classified later (the empty
// taxonomy values for those dimensions exist on the project — see below).
export const STANDARD_PROMPT_TAGS = Object.freeze(['source:ai']);

// The standard tag TAXONOMY registered on EVERY project (not on every prompt):
// the full intent / source / type vocabulary, so classification can later apply
// the right value per prompt. Created via createProjectTags after the project
// exists; `source:ai` is also applied to prompts now (reused by name, no dup).
export const PROJECT_STANDARD_TAGS = Object.freeze([
  'intent:informational',
  'intent:instructional',
  'intent:comparative',
  'intent:transactional',
  'intent:planning',
  'intent:delegation',
  'source:ai',
  'source:human',
  'type:branded',
  'type:non-branded',
]);

/**
 * Initial-market project name convention: "REGION - LANG" — uppercase ISO-2
 * country code + uppercase primary language subtag (e.g. "US - EN", "CH - DE").
 * Matches the names existing sub-workspace projects already carry.
 */
export function marketProjectName(market, languageCode) {
  const region = String(market || '').toUpperCase();
  const lang = String(languageCode || '').split('-')[0].toUpperCase();
  return `${region} - ${lang}`;
}

/**
 * Serenity-first provisioning for a brand created in Semrush-prompts mode
 * (serenity dual-mode). Creates the brand's Semrush sub-workspace (named after
 * the brand) and one DRAFT AIO project for the (market, languageCode) slice
 * BEFORE the brand row is written, so a brand only ever exists once its Semrush
 * side is valid ("only valid things on our side"). The market is left as a draft
 * — publish is deferred until prompts/models are added (publish-after-populate),
 * so brand-create never blocks on the empty-market publish quota (see
 * handleCreateMarketSubworkspace `skipPublish`).
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
 * @param {string[]} [params.brandAliases] - brand aliases; with the brand name
 *   they classify each generated prompt as `type:branded` / `type:non-branded`.
 * @param {object} [log]
 * @returns {Promise<{semrushWorkspaceId: string, published: boolean}>} the new
 *   sub-workspace id and whether the initial market was published (best-effort:
 *   a quota 405 leaves it a draft).
 * @throws {ErrorWithStatusCode} on any failure (the caller then skips the brand write).
 */
export async function provisionBrandSubworkspace(context, {
  spaceCatId, brandId, brandName, market, languageCode, brandDomain,
  modelIds = [], brandAliases = [],
}, log = console) {
  if (!hasText(brandName)) {
    throw new ErrorWithStatusCode('brandName is required for Semrush provisioning', 400);
  }
  if (!hasText(brandId)) {
    throw new ErrorWithStatusCode('brandId is required for Semrush provisioning', 400);
  }
  if (!hasText(market) || !hasText(languageCode)) {
    throw new ErrorWithStatusCode('market and languageCode are required for Semrush provisioning', 400);
  }
  if (!hasText(brandDomain)) {
    throw new ErrorWithStatusCode('brandDomain is required for Semrush provisioning', 400);
  }

  const parentWorkspaceId = await resolveWorkspaceId(context, spaceCatId);
  if (!hasText(parentWorkspaceId)) {
    throw new ErrorWithStatusCode('Organization has no Semrush workspace configured', 400);
  }

  const imsToken = getImsUserToken(context);
  const transport = createSerenityTransport({ env: context.env, imsToken });

  let capturedWorkspaceId = null;
  const brandStub = {
    getId: () => brandId,
    getName: () => brandName,
    getSemrushWorkspaceId: () => undefined,
    setSemrushWorkspaceId: (id) => { capturedWorkspaceId = id; },
    save: async () => {},
  };

  let result;
  try {
    result = await handleCreateMarketSubworkspace(
      transport,
      brandStub,
      parentWorkspaceId,
      {
        market,
        languageCode,
        brandDomain,
        brandNames: [brandName],
        brandDisplayName: brandName,
        name: marketProjectName(market, languageCode),
      },
      log,
      // preResolvedWorkspaceId / reloadPointer: defaults (single-create path).
      null,
      null,
      // Brand-create attaches the chosen LLMs, generates+attaches topics/prompts
      // (top N by volume, tagged `topic:<NAME>` + standard tags), then publishes.
      // The child is carved a real allocation (CREATE_ALLOCATION) so prompts and
      // publish have quota; a 405 here is a true over-quota and surfaces below.
      {
        modelIds,
        generateTopics: true,
        topicCap: MAX_TOPICS_ON_CREATE,
        standardTags: STANDARD_PROMPT_TAGS,
        brandAliases,
        projectTags: PROJECT_STANDARD_TAGS,
        publishMode: 'require',
      },
    );
  } catch (e) {
    // A bare upstream 405 is Semrush's disguised quota rejection (a prompt write
    // or publish that exceeds the child's metered quota — workspace doc §5).
    // Surface it as a clear "Quota exceeded" instead of the cryptic 405/nginx body.
    if (e instanceof SerenityTransportError && e.status === 405) {
      throw new ErrorWithStatusCode('Quota exceeded', 409);
    }
    throw e;
  }

  if (result?.status >= 400) {
    throw new ErrorWithStatusCode(
      result.body?.message || 'Failed to provision Semrush sub-workspace',
      result.status,
    );
  }
  if (!hasText(capturedWorkspaceId)) {
    throw new ErrorWithStatusCode('Semrush provisioning returned no sub-workspace id', 502);
  }
  return { semrushWorkspaceId: capturedWorkspaceId, published: Boolean(result.body?.published) };
}
