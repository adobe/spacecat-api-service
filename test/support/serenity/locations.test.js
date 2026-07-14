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

import { expect } from 'chai';

import { resolveLocation, marketForGeoTargetId } from '../../../src/support/serenity/locations.js';

describe('serenity locations — resolveLocation', () => {
  it('maps an ISO alpha-2 code to geoTargetId (2000 + ISO numeric) + English name', () => {
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
