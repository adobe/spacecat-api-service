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

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { expect } from 'chai';

import { iso31661Alpha2ToNumeric } from 'iso-3166';

import { resolveLocation, marketForGeoTargetId } from '../../../src/support/serenity/locations.js';
import {
  GOOGLE_GEO_TARGET_NAMES,
  MARKETS_WITHOUT_GOOGLE_GEO_TARGET,
} from '../../../src/support/serenity/google-geo-target-names.js';

describe('serenity locations — resolveLocation', () => {
  it('maps an ISO alpha-2 code to geoTargetId (2000 + ISO numeric) + Google geo-target name', () => {
    expect(resolveLocation('US')).to.deep.equal({
      geoTargetId: 2840,
      locationName: 'United States',
    });
    expect(resolveLocation('DE')).to.deep.equal({
      geoTargetId: 2276,
      locationName: 'Germany',
    });
  });

  it('upper-cases a lower-case code before resolving', () => {
    expect(resolveLocation('fr')).to.deep.equal({
      geoTargetId: 2250,
      locationName: 'France',
    });
  });

  it('returns null for empty / blank / non-text input', () => {
    expect(resolveLocation('')).to.equal(null);
    expect(resolveLocation('   ')).to.equal(null);
    expect(resolveLocation(undefined)).to.equal(null);
    expect(resolveLocation(null)).to.equal(null);
  });

  it('returns null for an unknown / unassigned country code', () => {
    expect(resolveLocation('ZZ')).to.equal(null);
    expect(resolveLocation('XX')).to.equal(null);
  });
});

describe('serenity locations — marketForGeoTargetId (inverse)', () => {
  it('maps a country geoTargetId back to its ISO alpha-2 code', () => {
    expect(marketForGeoTargetId(2840)).to.equal('US');
    expect(marketForGeoTargetId(2276)).to.equal('DE');
    expect(marketForGeoTargetId(2250)).to.equal('FR');
    expect(marketForGeoTargetId(2036)).to.equal('AU');
  });

  it('round-trips with resolveLocation for every resolvable market', () => {
    for (const market of ['US', 'DE', 'FR', 'GB', 'JP', 'BR', 'IN']) {
      const { geoTargetId } = resolveLocation(market);
      expect(marketForGeoTargetId(geoTargetId)).to.equal(market);
    }
  });

  it('handles a low ISO-numeric country whose numeric needs leading zeros (AF=004)', () => {
    // Afghanistan: ISO numeric 004 → geoTargetId 2004. Number-keyed reverse map
    // must not miss on the leading-zero string form.
    const { geoTargetId } = resolveLocation('AF');
    expect(geoTargetId).to.equal(2004);
    expect(marketForGeoTargetId(2004)).to.equal('AF');
  });

  it('returns null for a non-country / sub-national / out-of-range id', () => {
    expect(marketForGeoTargetId(1234)).to.equal(null); // region/metro band
    expect(marketForGeoTargetId(2000)).to.equal(null); // 2000 itself is not a country
    expect(marketForGeoTargetId(9999999)).to.equal(null);
  });

  it('returns null for a non-integer / missing / malformed id', () => {
    expect(marketForGeoTargetId(undefined)).to.equal(null);
    expect(marketForGeoTargetId(null)).to.equal(null);
    expect(marketForGeoTargetId(NaN)).to.equal(null);
    expect(marketForGeoTargetId(2840.5)).to.equal(null);
    expect(marketForGeoTargetId('nope')).to.equal(null);
  });
});

describe('serenity locations — location_name is Google Ads geo-target, not CLDR', () => {
  // `location_name` is matched against Google Ads geo-targets by Google AI Mode /
  // AI Overview at collection time. CLDR (`Intl.DisplayNames`) spells 31 of these
  // differently, and a mismatch makes those two providers silently collect NOTHING.
  // Each pair below is [market, Google's name, the CLDR name that broke it].
  const DIVERGENT = [
    ['TT', 'Trinidad and Tobago', 'Trinidad & Tobago'],
    ['HK', 'Hong Kong', 'Hong Kong SAR China'],
    ['TR', 'Turkiye', 'Türkiye'],
    ['PS', 'Palestine', 'Palestinian Territories'],
    ['BS', 'The Bahamas', 'Bahamas'],
    ['KN', 'Saint Kitts and Nevis', 'St. Kitts & Nevis'],
    ['MO', 'Macao', 'Macao SAR China'],
    ['ST', 'Sao Tome and Principe', 'São Tomé & Príncipe'],
  ];

  DIVERGENT.forEach(([market, googleName, cldrName]) => {
    it(`resolves ${market} to Google's '${googleName}', not CLDR's '${cldrName}'`, () => {
      const { locationName } = resolveLocation(market);
      expect(locationName).to.equal(googleName);
      expect(locationName).to.not.equal(cldrName);
    });
  });

  it('still matches CLDR for the countries where the two datasets agree', () => {
    expect(resolveLocation('US').locationName).to.equal('United States');
    expect(resolveLocation('DE').locationName).to.equal('Germany');
    expect(resolveLocation('JP').locationName).to.equal('Japan');
    expect(resolveLocation('BR').locationName).to.equal('Brazil');
  });

  it('returns a non-empty name for EVERY resolvable market (no market loses its name)', () => {
    const unnamed = Object.keys(iso31661Alpha2ToNumeric)
      .filter((code) => {
        const resolved = resolveLocation(code);
        return resolved !== null && !resolved.locationName;
      });
    expect(unnamed, `markets resolving without a location_name: ${unnamed.join(', ')}`)
      .to.deep.equal([]);
  });

  it('still resolves the markets Google publishes no geo-target for', () => {
    // Cuba/Iran/North Korea/Åland have no Google geo-target under any name, so the
    // two Google providers can never collect there — but every OTHER provider can,
    // so these must keep resolving rather than blocking market creation.
    MARKETS_WITHOUT_GOOGLE_GEO_TARGET.forEach((market) => {
      const resolved = resolveLocation(market);
      expect(resolved, market).to.not.equal(null);
      expect(resolved.locationName, market).to.be.a('string').and.have.length.greaterThan(0);
    });
    expect(resolveLocation('CU').locationName).to.equal('Cuba');
  });

  it('omits Kosovo (XK), which Google publishes but ISO 3166-1 has no numeric for', () => {
    expect(GOOGLE_GEO_TARGET_NAMES.XK).to.equal(undefined);
    expect(resolveLocation('XK')).to.equal(null);
  });
});

describe('serenity locations — GOOGLE_GEO_TARGET_NAMES matches Google’s published data', () => {
  // Machine-check the 246 country/region names against Google's OWN published
  // geotargets CSV, committed as a fixture. Without this, the ~240 non-divergent
  // entries in the 249-key map are unverifiable in-repo: a single silent typo
  // (an em-dash, a dropped "The", "Turkey" creeping back) would reintroduce the
  // exact silent-zero-collection bug this module fixes, invisible to CI and to
  // human review of a 300-line data wall. Fixture = top-level (empty Parent ID)
  // Active Country/Region rows of geotargets-2026-08-12.csv; regenerate both the
  // fixture and the map from a fresh snapshot together (see the module header).
  const CSV = join(
    dirname(fileURLToPath(import.meta.url)),
    '../../fixtures/serenity/google-geotargets-2026-08-12.country-region.csv',
  );

  // Parse the fixture (every field double-quoted, no embedded commas/quotes in
  // these country names) into { countryCode: name }.
  const parseRow = (line) => line.split('","').map((c) => c.replace(/^"|"$/g, ''));
  const rows = readFileSync(CSV, 'utf8').trim().split('\n');
  const header = parseRow(rows[0]);
  const nameIdx = header.indexOf('Name');
  const ccIdx = header.indexOf('Country Code');
  const google = {};
  for (const line of rows.slice(1)) {
    const cols = parseRow(line);
    google[cols[ccIdx]] = cols[nameIdx];
  }

  it('reproduces the fixture: 246 country/region rows', () => {
    expect(Object.keys(google)).to.have.lengthOf(246);
  });

  // Google publishes XK (Kosovo) but ISO 3166-1 assigns it no numeric, so it can't
  // be resolved by the `2000 + numeric` formula and is deliberately absent from the
  // map. It is the ONLY Google code excluded; assert that so the exclusion can't
  // silently grow to hide a real gap.
  it('excludes exactly one Google code (XK) that ISO 3166-1 cannot resolve', () => {
    const notInMap = Object.keys(google).filter((code) => !(code in GOOGLE_GEO_TARGET_NAMES));
    expect(notInMap).to.deep.equal(['XK']);
    expect(iso31661Alpha2ToNumeric.XK).to.equal(undefined);
  });

  it('every name in the map equals Google’s published name (for codes Google publishes)', () => {
    // XK is filtered out — not ISO-resolvable, asserted separately above.
    const mismatches = Object.entries(google)
      .filter(([code]) => code in iso31661Alpha2ToNumeric)
      .filter(([code, name]) => GOOGLE_GEO_TARGET_NAMES[code] !== name)
      .map(([code, name]) => `${code}: map=${JSON.stringify(GOOGLE_GEO_TARGET_NAMES[code])} google=${JSON.stringify(name)}`);
    expect(mismatches, mismatches.join('; ')).to.deep.equal([]);
  });

  it('MARKETS_WITHOUT_GOOGLE_GEO_TARGET are exactly the ISO codes Google publishes no row for', () => {
    const isoWithoutGoogle = Object.keys(iso31661Alpha2ToNumeric)
      .filter((code) => !(code in google))
      .sort();
    expect(isoWithoutGoogle).to.deep.equal([...MARKETS_WITHOUT_GOOGLE_GEO_TARGET].sort());
  });

  it('resolveLocation returns Google’s exact name for every code Google publishes', () => {
    // XK is filtered out — not ISO-resolvable, asserted separately above.
    const bad = Object.entries(google)
      .filter(([code]) => code in iso31661Alpha2ToNumeric)
      .map(([code, name]) => [code, name, resolveLocation(code)])
      .filter(([, name, resolved]) => !resolved || resolved.locationName !== name)
      .map(([code, name, resolved]) => `${code}: ${JSON.stringify(resolved && resolved.locationName)} != ${JSON.stringify(name)}`);
    expect(bad, bad.join('; ')).to.deep.equal([]);
  });
});
