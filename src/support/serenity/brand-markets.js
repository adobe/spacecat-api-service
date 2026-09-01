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

import { marketForGeoTargetId } from './locations.js';

/**
 * Builds the response body for the S2S "brand's Serenity markets" endpoint
 * (PR1 of a 2-PR feature; PR2 adds the controller that reads rows from the DB
 * and calls this) from `BrandSemrushProject` rows. Pure — no DB/IO — so the
 * controller owns the DB read and passes the rows in here.
 *
 * Whole-countries-only (PR1 scope): each row's `geoTargetId` (a Google Ads
 * Geo Target ID) is converted to an ISO 3166-1 alpha-2 region code via
 * {@link marketForGeoTargetId}, which only inverts the country formula
 * (`criterion_id = 2000 + ISO numeric`) — see locations.js. A geoTargetId
 * that is not a whole country (city/region/postal code, etc.) has no ISO
 * region to report; rather than mislabel it, the row is SKIPPED and logged
 * at warn level once. Sub-national geo support is a follow-up, not a
 * silent fallback here.
 *
 * @param {Array<object>} [rows] - `BrandSemrushProject` rows (or row-likes)
 *   exposing `getGeoTargetId()`, `getLanguageCode()`, `getSiteId?()`
 *   (nullable), and `getStatus?()` (nullable).
 * @param {{ warn?: Function }} [log] - logger; `warn` is called once per
 *   skipped (non-country) row.
 * @returns {{ items: Array<{
 *   region: string,
 *   languageCode: string,
 *   geoTargetId: number,
 *   siteId: (string|null),
 *   status: (string|null),
 * }> }}
 */
export function buildBrandMarketsResponse(rows, log) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { items: [] };
  }

  const items = [];
  for (const row of rows) {
    const geoTargetId = row.getGeoTargetId();
    const region = marketForGeoTargetId(geoTargetId);
    if (region === null) {
      log?.warn?.(
        'buildBrandMarketsResponse: skipping row with non-country geoTargetId',
        { brandId: row.getBrandId?.() ?? undefined, geoTargetId },
      );
      // eslint-disable-next-line no-continue
      continue;
    }
    items.push({
      region,
      languageCode: row.getLanguageCode(),
      geoTargetId,
      siteId: row.getSiteId?.() ?? null,
      status: row.getStatus?.() ?? null,
    });
  }
  return { items };
}
