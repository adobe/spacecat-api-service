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

function makeRow({ geoTargetId, languageCode }) {
  return {
    getGeoTargetId: () => geoTargetId,
    getLanguageCode: () => languageCode,
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
      makeRow({ geoTargetId: 2356, languageCode: 'en' }),
      makeRow({ geoTargetId: 2840, languageCode: 'en' }),
      makeRow({ geoTargetId: 2826, languageCode: 'en' }),
    ];

    const result = buildBrandMarketsResponse(rows, log);

    expect(result).to.deep.equal({
      markets: [
        { region: 'IN', languageCode: 'en', geoTargetId: 2356 },
        { region: 'US', languageCode: 'en', geoTargetId: 2840 },
        { region: 'GB', languageCode: 'en', geoTargetId: 2826 },
      ],
    });
    expect(log.warn).not.to.have.been.called;
  });

  it('skips a non-country geoTargetId row and warns once, keeping the country row', () => {
    const rows = [
      makeRow({ geoTargetId: 1023191, languageCode: 'en' }), // sub-national — not a whole country
      makeRow({ geoTargetId: 2840, languageCode: 'en' }),
    ];

    const result = buildBrandMarketsResponse(rows, log);

    expect(result.markets).to.have.lengthOf(1);
    expect(result.markets[0]).to.deep.equal({
      region: 'US', languageCode: 'en', geoTargetId: 2840,
    });
    expect(log.warn).to.have.been.calledOnce;
  });

  it('skips multiple non-country rows and warns once with the total count', () => {
    const rows = [
      makeRow({ geoTargetId: 1023191, languageCode: 'en' }),
      makeRow({ geoTargetId: 1023192, languageCode: 'en' }),
      makeRow({ geoTargetId: 2840, languageCode: 'en' }),
    ];

    const result = buildBrandMarketsResponse(rows, log);

    expect(result.markets).to.have.lengthOf(1);
    expect(log.warn).to.have.been.calledOnce;
    expect(log.warn.firstCall.args[0]).to.match(/skipped 2 row/);
  });

  it('skips a row with a null, empty, or whitespace-only languageCode', () => {
    const rows = [
      makeRow({ geoTargetId: 2356, languageCode: null }),
      makeRow({ geoTargetId: 2840, languageCode: '' }),
      makeRow({ geoTargetId: 2826, languageCode: '   ' }),
      makeRow({ geoTargetId: 2276, languageCode: 'de' }),
    ];

    const result = buildBrandMarketsResponse(rows, log);

    expect(result.markets).to.deep.equal([
      { region: 'DE', languageCode: 'de', geoTargetId: 2276 },
    ]);
    expect(log.warn).to.have.been.calledOnce;
    expect(log.warn.firstCall.args[0]).to.match(/skipped 3 row/);
  });

  it('trims a padded languageCode before emitting it', () => {
    const rows = [makeRow({ geoTargetId: 2356, languageCode: ' en ' })];

    const result = buildBrandMarketsResponse(rows, log);

    expect(result.markets).to.deep.equal([
      { region: 'IN', languageCode: 'en', geoTargetId: 2356 },
    ]);
    expect(log.warn).not.to.have.been.called;
  });

  it('includes the brandId and skipped geoTargetIds in the skip warning', () => {
    const rows = [makeRow({ geoTargetId: 1023191, languageCode: 'en' })];

    buildBrandMarketsResponse(rows, log, { brandId: 'brand-xyz' });

    expect(log.warn).to.have.been.calledOnce;
    const msg = log.warn.firstCall.args[0];
    expect(msg).to.include('brand-xyz');
    expect(msg).to.include('1023191');
  });

  it('returns an empty markets array for an empty rows array', () => {
    expect(buildBrandMarketsResponse([], log)).to.deep.equal({ markets: [] });
    expect(log.warn).not.to.have.been.called;
  });

  it('returns an empty markets array for undefined rows', () => {
    expect(buildBrandMarketsResponse(undefined, log)).to.deep.equal({ markets: [] });
    expect(log.warn).not.to.have.been.called;
  });
});
