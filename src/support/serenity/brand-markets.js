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

import { marketForGeoTargetId } from './locations.js';

/**
 * Builds the response body for the S2S "brand's Serenity markets" endpoint
 * from `BrandSemrushProject` rows. Pure (no DB/IO); the controller reads the
 * rows and passes them in.
 *
 * Each row's `geoTargetId` maps to an ISO 3166-1 alpha-2 region via
 * {@link marketForGeoTargetId}. Whole countries only: a non-country
 * `geoTargetId` or a blank `languageCode` is skipped rather than mislabeled,
 * and the skipped rows are reported in a single warn.
 *
 * @param {Array<object>} [rows] - rows exposing `getGeoTargetId()` and `getLanguageCode()`.
 * @param {{ warn?: Function }} [log] - logger; `warn` is called once with the skipped count.
 * @param {{ brandId?: string }} [options] - `brandId` is included in the skip warning.
 * @returns {{ markets: Array<{ region: string, languageCode: string, geoTargetId: number }> }}
 */
export function buildBrandMarketsResponse(rows, log, { brandId } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { markets: [] };
  }

  const markets = [];
  const skippedGeoTargetIds = [];
  for (const row of rows) {
    const geoTargetId = row.getGeoTargetId();
    const region = marketForGeoTargetId(geoTargetId);
    const rawLanguageCode = row.getLanguageCode();
    // trim so a padded " en " is emitted as "en" (BCP-47 primary subtag)
    const languageCode = hasText(rawLanguageCode) ? rawLanguageCode.trim() : '';
    if (region === null || !languageCode) {
      skippedGeoTargetIds.push(geoTargetId);
      // eslint-disable-next-line no-continue
      continue;
    }
    markets.push({
      region,
      languageCode,
      geoTargetId,
    });
  }
  if (skippedGeoTargetIds.length > 0) {
    log?.warn?.(
      `buildBrandMarketsResponse: skipped ${skippedGeoTargetIds.length} row(s)`
      + `${brandId ? ` for brand ${brandId}` : ''} with a non-country geoTargetId`
      + ` or missing languageCode (geoTargetIds: ${skippedGeoTargetIds.join(', ')})`,
    );
  }
  return { markets };
}
