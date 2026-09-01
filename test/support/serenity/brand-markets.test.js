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

import { use, expect } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';

import { buildBrandMarketsResponse } from '../../../src/support/serenity/brand-markets.js';

use(sinonChai);

function makeRow({
  geoTargetId, languageCode, siteId = 'site-1', status = 'live',
}) {
  return {
    getGeoTargetId: () => geoTargetId,
    getLanguageCode: () => languageCode,
    getSiteId: () => siteId,
    getStatus: () => status,
  };
}

function fakeLog() {
  return {
    info: sinon.stub(),
    warn: sinon.stub(),
    error: sinon.stub(),
  };
}

describe('brand-markets.js — buildBrandMarketsResponse', () => {
  let log;

  beforeEach(() => {
    log = fakeLog();
  });

  it('maps country geoTargetIds to ISO region codes, preserving order and passing fields through', () => {
    const rows = [
      makeRow({
        geoTargetId: 2356, languageCode: 'en', siteId: 'site-in', status: 'live',
      }),
      makeRow({
        geoTargetId: 2840, languageCode: 'en', siteId: 'site-us', status: 'live',
      }),
      makeRow({
        geoTargetId: 2826, languageCode: 'en', siteId: 'site-gb', status: 'live',
      }),
    ];

    const result = buildBrandMarketsResponse(rows, log);

    expect(result).to.deep.equal({
      items: [
        {
          region: 'IN', languageCode: 'en', geoTargetId: 2356, siteId: 'site-in', status: 'live',
        },
        {
          region: 'US', languageCode: 'en', geoTargetId: 2840, siteId: 'site-us', status: 'live',
        },
        {
          region: 'GB', languageCode: 'en', geoTargetId: 2826, siteId: 'site-gb', status: 'live',
        },
      ],
    });
    expect(log.warn).not.to.have.been.called;
  });

  it('skips a non-country geoTargetId row and warns once, keeping the country row', () => {
    const rows = [
      makeRow({ geoTargetId: 1023191, languageCode: 'en' }), // sub-national — not a whole country
      makeRow({
        geoTargetId: 2840, languageCode: 'en', siteId: 'site-us', status: 'live',
      }),
    ];

    const result = buildBrandMarketsResponse(rows, log);

    expect(result.items).to.have.lengthOf(1);
    expect(result.items[0]).to.deep.equal({
      region: 'US', languageCode: 'en', geoTargetId: 2840, siteId: 'site-us', status: 'live',
    });
    expect(log.warn).to.have.been.calledOnce;
  });

  it('returns an empty items array for an empty rows array', () => {
    expect(buildBrandMarketsResponse([], log)).to.deep.equal({ items: [] });
    expect(log.warn).not.to.have.been.called;
  });

  it('returns an empty items array for undefined rows', () => {
    expect(buildBrandMarketsResponse(undefined, log)).to.deep.equal({ items: [] });
    expect(log.warn).not.to.have.been.called;
  });

  it('passes through a null siteId', () => {
    const rows = [
      makeRow({
        geoTargetId: 2840, languageCode: 'en', siteId: null, status: 'live',
      }),
    ];

    const result = buildBrandMarketsResponse(rows, log);

    expect(result.items).to.have.lengthOf(1);
    expect(result.items[0].siteId).to.equal(null);
  });
});
