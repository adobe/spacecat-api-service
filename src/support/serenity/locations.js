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
import { iso31661Alpha2ToNumeric } from 'iso-3166';

// Reusable English region-name formatter (ICU-backed, built into Node). Used
// for the `location_name` we send upstream — matches the form Semrush stores
// on existing projects (`United States`, `Germany`, `Türkiye`).
const ENGLISH_REGION_NAMES = new Intl.DisplayNames(['en'], { type: 'region' });

/**
 * Resolves an ISO 3166-1 alpha-2 country code to a Google Ads Geo Target ID
 * (`criterion_id = 2000 + ISO numeric` for countries) plus an English display
 * name suitable for `location_name` on the upstream create-project body.
 * Returns null on unknown / unassigned codes; the controller maps that to 400.
 *
 * Shared by the create path (handlers/markets.js — writes `location_id` onto
 * new projects) and the read path (subworkspace-projects.js `geoOf` — derives
 * a country-level geoTargetId for projects whose `settings.ai.location.id` is
 * null but whose `settings.ai.country.code` is set, e.g. projects created in
 * the Semrush native UI). Keeping it in one place guarantees a country market
 * reads back with the exact geoTargetId the create path would have written.
 *
 * Why `2000 + ISO numeric` works
 * ─────────────────────────────────────────────────────────────────────────
 * Google Ads Geo Targets use a multi-digit `criterion_id` whose first digit
 * encodes the target *type*:
 *   - 1xxx: region / metro / state
 *   - 2xxx: country
 *   - 5xxx, 9xxx, …: airport, postal code, neighbourhood, university, …
 * For countries, the remaining digits are the country's ISO 3166-1 numeric
 * code, so `criterion_id = 2000 + ISO numeric`. Verified 2026-05-22 against
 * every project in the Adobe LLMO-Dev Semrush workspace
 * (US→2840, DE→2276, FR→2250, AU→2036, …). Semrush echoes the same
 * `location.id` back on read, so this stays consistent over time.
 *
 * Canonical Google Ads dataset (countries + cities + ZIPs + airports + …) is
 * downloadable as CSV from:
 *   https://developers.google.com/google-ads/api/data/geotargets
 *
 * TODO(LLMO-XXXX): cities / regions / postal codes do NOT follow this
 * formula — their `criterion_id`s come from the Google CSV above. When
 * sub-national geo lands in the UX, lazy-load that CSV (or proxy a Semrush
 * location-search endpoint if/when they expose one) and search in-memory.
 * Only this function needs to change — `geoTargetId` is already the slice key.
 */
export function resolveLocation(market) {
  if (!hasText(market)) {
    return null;
  }
  const alpha2 = String(market).toUpperCase();
  const numeric = iso31661Alpha2ToNumeric[alpha2];
  if (!numeric) {
    return null;
  }
  return {
    geoTargetId: 2000 + Number(numeric),
    locationName: ENGLISH_REGION_NAMES.of(alpha2),
  };
}
