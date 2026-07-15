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

/*
 * Contract tests for the Weeks filter-dimensions element definition (LLMO-6011 POC,
 * previously c8-ignored). transformWeeksResponse rolls raw daily rows into the ISO
 * weeks the URL Inspector week picker consumes.
 */

import { expect } from 'chai';
import {
  buildWeeksPayload,
  transformWeeksResponse,
} from '../../../../src/support/elements/definitions/weeks.js';

const rawResponse = (rows) => ({ blocks: { data: rows } });

describe('weeks definition', () => {
  describe('buildWeeksPayload', () => {
    it('translates the platform code into a CBF_model filter', () => {
      const payload = buildWeeksPayload({ platform: 'openai' });
      expect(payload.filters.advanced.filters).to.deep.include({ op: 'eq', val: 'gpt-5', col: 'CBF_model' });
    });

    it('prefers model over platform', () => {
      const payload = buildWeeksPayload({ model: 'perplexity', platform: 'openai' });
      expect(payload.filters.advanced.filters[0]).to.deep.equal({ op: 'eq', val: 'perplexity', col: 'CBF_model' });
    });

    it('adds a CBF_ws_brand filter only when a brand is provided', () => {
      const withBrand = buildWeeksPayload({ brand: 'Adobe' });
      expect(withBrand.filters.advanced.filters).to.deep.include({ op: 'eq', val: 'Adobe', col: 'CBF_ws_brand' });

      const withoutBrand = buildWeeksPayload({});
      expect(withoutBrand.filters.advanced.filters.some((f) => f.col === 'CBF_ws_brand')).to.equal(false);
    });
  });

  describe('transformWeeksResponse', () => {
    it('rolls daily rows into ISO weeks, newest-first', () => {
      const result = transformWeeksResponse(rawResponse([
        { date: '2026-03-01' },
        { date: '2026-03-15' },
      ]));
      expect(result).to.deep.equal([
        { week: '2026-W11', startDate: '2026-03-09', endDate: '2026-03-15' },
        { week: '2026-W10', startDate: '2026-03-02', endDate: '2026-03-08' },
        { week: '2026-W09', startDate: '2026-02-23', endDate: '2026-03-01' },
      ]);
    });

    it('slices timestamps to the date and ignores non-string date rows', () => {
      const result = transformWeeksResponse(rawResponse([
        { date: '2026-03-09T12:34:56Z' },
        { date: null },
        { notADate: true },
      ]));
      expect(result).to.deep.equal([
        { week: '2026-W11', startDate: '2026-03-09', endDate: '2026-03-15' },
      ]);
    });

    it('returns [] for missing or empty data', () => {
      expect(transformWeeksResponse(undefined)).to.deep.equal([]);
      expect(transformWeeksResponse(rawResponse([]))).to.deep.equal([]);
      expect(transformWeeksResponse(rawResponse([{ notADate: true }]))).to.deep.equal([]);
    });
  });
});
