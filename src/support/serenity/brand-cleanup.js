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
import { ErrorWithStatusCode } from '../utils.js';
import { createSerenityTransport } from './rest-transport.js';
import { extractImsBearer } from './ims-bearer.js';
import { resolveWorkspaceId } from './workspace-resolver.js';
import { handleDeleteMarket } from './handlers/markets.js';

/**
 * Tears down every Serenity (Semrush) market a brand owns before the brand is
 * deleted, so we never orphan a remote Semrush project whose owning brand no
 * longer exists.
 *
 * Fail-closed: if the brand has projects but we cannot complete the cleanup
 * (no workspace id, no IMS token, or an upstream Semrush failure), this throws
 * and the caller must abort the brand delete. Because `handleDeleteMarket` is
 * idempotent (it removes each DB row only after the upstream DELETE succeeds or
 * 404s), a retried brand delete converges: slices already removed stay removed
 * and only the outstanding ones are re-attempted.
 *
 * No-op (returns `{ deleted: 0 }`) when the brand owns no Semrush projects, or
 * when the data layer has no `BrandSemrushProject` model wired up — so deleting
 * a brand that never went through Serenity onboarding is unaffected.
 *
 * @param {object} context - The request context (`dataAccess`, `env`, auth).
 * @param {string} spaceCatId - The SpaceCat organization id (for workspace lookup).
 * @param {string} brandId - The brand UUID being deleted.
 * @param {object} log - Logger.
 * @returns {Promise<{deleted: number}>} Count of Semrush projects removed.
 */
export async function cleanupBrandSemrushProjects(context, spaceCatId, brandId, log) {
  const { dataAccess } = context;
  const BrandSemrushProject = dataAccess?.BrandSemrushProject;

  if (!BrandSemrushProject || typeof BrandSemrushProject.allByBrandId !== 'function') {
    return { deleted: 0 };
  }

  const rows = (await BrandSemrushProject.allByBrandId(brandId)) || [];
  if (rows.length === 0) {
    return { deleted: 0 };
  }

  const semrushWorkspaceId = await resolveWorkspaceId(context, spaceCatId);
  if (!hasText(semrushWorkspaceId)) {
    throw new ErrorWithStatusCode(
      `Cannot delete brand: it owns ${rows.length} Semrush project(s) but organization ${spaceCatId} has no semrush_workspace_id to clean them up`,
      409,
    );
  }

  const imsToken = extractImsBearer(context);
  if (!imsToken) {
    throw new ErrorWithStatusCode(
      'Cannot delete a brand with Semrush projects without an IMS bearer token',
      401,
    );
  }

  const transport = createSerenityTransport({ env: context.env, imsToken });

  let deleted = 0;
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    await handleDeleteMarket(
      transport,
      dataAccess,
      brandId,
      semrushWorkspaceId,
      row.getGeoTargetId(),
      row.getLanguageCode(),
      log,
    );
    deleted += 1;
  }

  log?.info?.(`Brand delete: removed ${deleted} Semrush project(s) for brand ${brandId}`);
  return { deleted };
}
