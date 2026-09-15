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

import { GOOGLE_GEO_TARGET_NAMES } from './google-geo-target-names.js';

/**
 * Resolves an ISO 3166-1 alpha-2 country code to a Google Ads Geo Target ID
 * (`criterion_id = 2000 + ISO numeric` for countries) plus the name Google Ads
 * itself uses for that geo-target, for `location_name` on the upstream
 * create-project body.
 * Returns null on unknown / unassigned codes; the controller maps that to 400.
 *
 * `location_name` is NOT a display string: Google AI Mode / AI Overview resolve
 * it against Google Ads geo-targets at collection time, and a name Google cannot
 * match means those two providers silently collect nothing. It therefore comes
 * from Google's own published geo-targets data ({@link GOOGLE_GEO_TARGET_NAMES}),
 * never from CLDR / `Intl.DisplayNames` — those disagree on 31 countries
 * (`Trinidad & Tobago` vs `Trinidad and Tobago`, `Hong Kong SAR China` vs
 * `Hong Kong`, …) and also shift with the runtime's bundled ICU version.
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
  // Guarantee the name at the boundary, not just via a test elsewhere: the id
  // resolves off `iso-3166` but the name off the hand-maintained map, and the
  // whole point of this module is that a missing/unmatched name silently breaks
  // Google AI collection. If the two datasets ever diverge (e.g. an `iso-3166`
  // bump adds a code the map lacks), fail loud here — the caller maps null to a
  // 400 — rather than shipping `location_name: undefined` to Semrush. Today the
  // map is total over the ISO set (enforced by a test), so this never triggers.
  const locationName = GOOGLE_GEO_TARGET_NAMES[alpha2];
  if (!locationName) {
    return null;
  }
  return {
    geoTargetId: 2000 + Number(numeric),
    locationName,
  };
}

// Reverse of the country `criterion_id = 2000 + ISO numeric` mapping, keyed by
// the numeric code as a Number so leading-zero string forms ('004' vs 4) can't
// cause a miss. Built once at module load from the same `iso-3166` table
// `resolveLocation` reads forward, so the two directions can never drift.
const NUMERIC_TO_ALPHA2 = Object.freeze(
  Object.fromEntries(
    Object.entries(iso31661Alpha2ToNumeric).map(([a2, num]) => [Number(num), a2]),
  ),
);

/**
 * Inverse of {@link resolveLocation}: resolves a country-level Google Ads Geo
 * Target ID back to its ISO 3166-1 alpha-2 market code. Used to derive a prompt's
 * market from its `geoTargetId` (the slice key carried on every prompt write) so
 * brand aliases can be region-clamped per prompt — the manual create/edit paths
 * receive a numeric `geoTargetId`, not the ISO-2 code the create-market path has.
 *
 * Only the country formula (`criterion_id = 2000 + ISO numeric`) is inverted;
 * sub-national geo targets (cities/regions/postal codes) do NOT follow it and
 * return null, matching {@link resolveLocation}'s forward coverage. Returns null
 * on a non-country / unknown / malformed id; the caller degrades to name-only
 * needles (region-less aliases still apply).
 *
 * @param {number} geoTargetId - a country-level Google Ads Geo Target ID.
 * @returns {string|null} the ISO-2 market code, or null when not a known country id.
 */
export function marketForGeoTargetId(geoTargetId) {
  const n = Number(geoTargetId);
  if (!Number.isInteger(n) || n <= 2000) {
    return null;
  }
  return NUMERIC_TO_ALPHA2[n - 2000] ?? null;
}
