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

import { resolveLocation } from '../../../src/support/serenity/locations.js';

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
