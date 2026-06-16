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
import { createSerenityTransport } from './rest-transport.js';
import { resolveWorkspaceId } from './workspace-resolver.js';
import { handleCreateMarketSubworkspace } from './handlers/markets-subworkspace.js';

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
 * the brand) and one AIO project for the (market, languageCode) slice BEFORE the
 * brand row is written, so a brand only ever exists once its Semrush side is
 * valid ("only valid things on our side").
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
 * @param {object} [log]
 * @returns {Promise<{semrushWorkspaceId: string}>} the new sub-workspace id.
 * @throws {ErrorWithStatusCode} on any failure (the caller then skips the brand write).
 */
export async function provisionBrandSubworkspace(context, {
  spaceCatId, brandId, brandName, market, languageCode, brandDomain,
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

  const result = await handleCreateMarketSubworkspace(
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
  );

  if (result?.status >= 400) {
    throw new ErrorWithStatusCode(
      result.body?.message || 'Failed to provision Semrush sub-workspace',
      result.status,
    );
  }
  if (!hasText(capturedWorkspaceId)) {
    throw new ErrorWithStatusCode('Semrush provisioning returned no sub-workspace id', 502);
  }
  return { semrushWorkspaceId: capturedWorkspaceId };
}
