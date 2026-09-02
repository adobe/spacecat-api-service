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
 * (PR1 of a 2-PR feature; PR2 adds the controller that reads rows from the DB
 * and calls this) from `BrandSemrushProject` rows. Pure — no DB/IO — so the
 * controller owns the DB read and passes the rows in here.
 *
 * Whole-countries-only: each row's `geoTargetId` (a Google Ads
 * Geo Target ID) is converted to an ISO 3166-1 alpha-2 region code via
 * {@link marketForGeoTargetId}, which only inverts the country formula
 * (`criterion_id = 2000 + ISO numeric`) — see locations.js. A geoTargetId
 * that is not a whole country (city/region/postal code, etc.) has no ISO
 * region to report; rather than mislabel it, the row is SKIPPED. A row with
 * a blank `languageCode` is skipped for the same reason — the schema
 * requires a non-empty string, so emitting `null` would violate the
 * contract. Skipped rows are counted and reported in a single summarized
 * warn after the loop, rather than one log line per row. Sub-national geo
 * support is a follow-up, not a silent fallback here.
 *
 * The `BrandSemrushProject` store has no `status` or `siteId` column (only
 * `brandId`, `semrushProjectId`, `geoTargetId`, `languageCode`, plus the
 * `deletedAt` soft-delete tombstone) — "live" status exists only in the
 * IMS-gated Semrush listing, which this S2S endpoint cannot reach — so
 * neither field is part of the response shape. Soft-delete filtering
 * (`deletedAt`) is the caller's DB-read concern, not this builder's.
 *
 * @param {Array<object>} [rows] - `BrandSemrushProject` rows (or row-likes)
 *   exposing `getGeoTargetId()` and `getLanguageCode()`.
 * @param {{ warn?: Function }} [log] - logger; `warn` is called once, after
 *   the loop, with a summary count of the rows skipped.
 * @returns {{ markets: Array<{
 *   region: string,
 *   languageCode: string,
 *   geoTargetId: number,
 * }> }}
 */
export function buildBrandMarketsResponse(rows, log) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { markets: [] };
  }

  const markets = [];
  let skipped = 0;
  for (const row of rows) {
    const geoTargetId = row.getGeoTargetId();
    const region = marketForGeoTargetId(geoTargetId);
    const languageCode = row.getLanguageCode();
    if (region === null || !hasText(languageCode) || !languageCode.trim()) {
      skipped += 1;
      // eslint-disable-next-line no-continue
      continue;
    }
    markets.push({
      region,
      languageCode,
      geoTargetId,
    });
  }
  if (skipped > 0) {
    log?.warn?.(
      `buildBrandMarketsResponse: skipped ${skipped} row(s) with a non-country geoTargetId or missing languageCode`,
    );
  }
  return { markets };
}
