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
import {
  buildOwnedUrlsStatsPayload,
  buildOwnedUrlsTrendPayload,
} from '../../../../src/support/elements/definitions/owned-urls.js';

const START = '2026-06-29';
const END = '2026-07-26';

// Returns the CBF_model or-node from a stats/trend payload's advanced filters.
function modelOrNode(payload) {
  return payload.filters.advanced.filters.find(
    (f) => f.op === 'or' && f.filters?.every((n) => n.col === 'CBF_model'),
  );
}

describe('owned-urls definitions', () => {
  // LLMO-7553 subset multi-model support. The single-model shape MUST stay byte-identical.
  describe('buildOwnedUrlsStatsPayload', () => {
    it('BYTE-IDENTICAL: a single model produces the exact pre-change payload', () => {
      // Full-payload parity assertion vs the pre-multi-model shape: a one-member CBF_model
      // OR (resolveElementModel + manual `or` wrap), followed by the date bounds.
      expect(buildOwnedUrlsStatsPayload({ model: 'openai', startDate: START, endDate: END }))
        .to.deep.equal({
          comparison_data_formatting: 'union',
          filters: {
            simple: { CBF_date__start: START, CBF_date__end: END },
            advanced: {
              op: 'and',
              filters: [
                { op: 'or', filters: [{ op: 'eq', val: 'chatgpt-paid', col: 'CBF_model' }] },
                { op: 'gte', val: START, col: 'CBF_date__start' },
                { op: 'lte', val: END, col: 'CBF_date__end' },
              ],
            },
          },
        });
    });

    it('defaults to a one-member DEFAULT_ELEMENT_MODEL OR when model is absent', () => {
      expect(modelOrNode(buildOwnedUrlsStatsPayload({ startDate: START, endDate: END })))
        .to.deep.equal({ op: 'or', filters: [{ op: 'eq', val: 'search-gpt', col: 'CBF_model' }] });
    });

    it('emits an N-member CBF_model OR for a comma-separated subset', () => {
      expect(modelOrNode(buildOwnedUrlsStatsPayload({ platform: 'openai,gemini' })))
        .to.deep.equal({
          op: 'or',
          filters: [
            { op: 'eq', val: 'chatgpt-paid', col: 'CBF_model' },
            { op: 'eq', val: 'gemini-2.5-flash', col: 'CBF_model' },
          ],
        });
    });

    it('dedupes a subset to a one-member OR (byte-identical to the single case)', () => {
      expect(modelOrNode(buildOwnedUrlsStatsPayload({ model: 'openai,openai' })))
        .to.deep.equal({ op: 'or', filters: [{ op: 'eq', val: 'chatgpt-paid', col: 'CBF_model' }] });
    });

    it('scopes a project via a TOP-LEVEL project_id, unchanged by multi-model', () => {
      expect(buildOwnedUrlsStatsPayload({ platform: 'openai,gemini', projectId: 'proj-1' }).project_id)
        .to.equal('proj-1');
    });
  });

  describe('buildOwnedUrlsTrendPayload', () => {
    it('BYTE-IDENTICAL: a single model produces the exact pre-change payload', () => {
      expect(buildOwnedUrlsTrendPayload({ model: 'openai', startDate: START, endDate: END }))
        .to.deep.equal({
          comparison_data_formatting: 'union',
          filters: {
            simple: { CBF_date__start: START, CBF_date__end: END },
            advanced: {
              op: 'and',
              filters: [
                { op: 'or', filters: [{ op: 'eq', val: 'chatgpt-paid', col: 'CBF_model' }] },
                { op: 'gte', val: START, col: 'CBF_date__start' },
                { op: 'lte', val: END, col: 'CBF_date__end' },
              ],
            },
          },
        });
    });

    it('emits an N-member CBF_model OR for a comma-separated subset (lockstep with stats)', () => {
      expect(modelOrNode(buildOwnedUrlsTrendPayload({ platform: 'openai,gemini' })))
        .to.deep.equal({
          op: 'or',
          filters: [
            { op: 'eq', val: 'chatgpt-paid', col: 'CBF_model' },
            { op: 'eq', val: 'gemini-2.5-flash', col: 'CBF_model' },
          ],
        });
    });

    it('dedupes a duplicate subset to a one-member OR (byte-identical to the single case)', () => {
      // A duplicate/collapsing subset on the trend payload must dedupe to a single member,
      // exactly like stats, so the sparklines and totals stay on the same CBF_model set.
      expect(modelOrNode(buildOwnedUrlsTrendPayload({ model: 'openai,openai' })))
        .to.deep.equal({ op: 'or', filters: [{ op: 'eq', val: 'chatgpt-paid', col: 'CBF_model' }] });
    });
  });

  // The stats and trend payloads MUST carry the identical CBF_model set for any subset, or a
  // category-filtered view's weekly values could exceed its totals (see the trend payload).
  describe('stats/trend model-filter lockstep (multi-model)', () => {
    it('stats and trend emit the same 3-member OR for a 3-model subset', () => {
      const stats = modelOrNode(buildOwnedUrlsStatsPayload({ platform: 'openai,gemini,perplexity' }));
      const trend = modelOrNode(buildOwnedUrlsTrendPayload({ platform: 'openai,gemini,perplexity' }));
      expect(stats).to.deep.equal(trend);
      expect(stats.filters).to.have.length(3);
    });
  });
});
