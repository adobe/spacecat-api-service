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
import { normalizeVisibilityV1SuccessfulBody } from '../../../src/support/serenity/visibility-response-normalize.js';

describe('visibility-response-normalize', () => {
  describe('normalizeVisibilityV1SuccessfulBody', () => {
    it('returns null as-is', () => {
      expect(normalizeVisibilityV1SuccessfulBody('/any', null)).to.equal(null);
    });

    it('returns arrays as-is', () => {
      const arr = [1, 2];
      expect(normalizeVisibilityV1SuccessfulBody('/any', arr)).to.equal(arr);
    });

    it('returns error bodies as-is', () => {
      const body = { error: 'oops' };
      expect(normalizeVisibilityV1SuccessfulBody('/any', body)).to.equal(body);
    });

    it('passes through unmatched relPaths unchanged', () => {
      const body = { data: [{ foo: 'bar' }] };
      const result = normalizeVisibilityV1SuccessfulBody('/brands/stats', body);
      expect(result).to.deep.equal(body);
    });

    describe('/competitors/gap-prompts normalization', () => {
      it('normalizes data, offset, limit, total', () => {
        const body = {
          data: [{ prompt: 'a' }, { prompt: 'b' }], offset: 0, limit: 10, total: 2,
        };
        const result = normalizeVisibilityV1SuccessfulBody('/competitors/gap-prompts', body);
        expect(result.data).to.have.length(2);
        expect(result.offset).to.equal(0);
        expect(result.limit).to.equal(10);
        expect(result.total).to.equal(2);
      });

      it('defaults to empty array when data is missing', () => {
        const result = normalizeVisibilityV1SuccessfulBody('/competitors/gap-prompts', {});
        expect(result.data).to.deep.equal([]);
        expect(result.offset).to.equal(0);
        expect(result.limit).to.equal(0);
      });

      it('extracts total from total_count field', () => {
        const body = { data: [{}], total_count: 42, offset: 0 };
        const result = normalizeVisibilityV1SuccessfulBody('/competitors/gap-prompts', body);
        expect(result.total).to.equal(42);
      });

      it('extracts total from nested meta.total', () => {
        const body = { data: [{}], meta: { total: 99 }, offset: 0 };
        const result = normalizeVisibilityV1SuccessfulBody('/competitors/gap-prompts', body);
        expect(result.total).to.equal(99);
      });

      it('extracts total from nested pagination.total', () => {
        const body = { data: [{}], pagination: { total: 77 }, offset: 0 };
        const result = normalizeVisibilityV1SuccessfulBody('/competitors/gap-prompts', body);
        expect(result.total).to.equal(77);
      });

      it('coerces string total values', () => {
        const body = { data: [{}], total: '5.0', offset: 0 };
        const result = normalizeVisibilityV1SuccessfulBody('/competitors/gap-prompts', body);
        expect(result.total).to.equal(5);
      });

      it('coerces string total with commas', () => {
        const body = { data: [{}], total: '1,234', offset: 0 };
        const result = normalizeVisibilityV1SuccessfulBody('/competitors/gap-prompts', body);
        expect(result.total).to.equal(1234);
      });

      it('returns undefined for empty string total (coerce whitespace-only)', () => {
        const body = { data: [{}], total: '  ', offset: 0 };
        const result = normalizeVisibilityV1SuccessfulBody('/competitors/gap-prompts', body);
        expect(result.total).to.equal(1);
      });

      it('returns undefined for dot-only total (parseFloat NaN branch)', () => {
        const body = { data: [{}], total: '.', offset: 0 };
        const result = normalizeVisibilityV1SuccessfulBody('/competitors/gap-prompts', body);
        expect(result.total).to.equal(1);
      });

      it('ignores non-numeric total strings', () => {
        const body = { data: [{ x: 1 }, { x: 2 }], total: 'abc', offset: 5 };
        const result = normalizeVisibilityV1SuccessfulBody('/competitors/gap-prompts', body);
        expect(result.total).to.equal(7);
      });

      it('enforces floor of offset + data.length when total is too small', () => {
        const body = { data: [{}], total: 0, offset: 10 };
        const result = normalizeVisibilityV1SuccessfulBody('/competitors/gap-prompts', body);
        expect(result.total).to.equal(11);
      });

      it('falls back limit to data.length when limit is missing', () => {
        const body = { data: [{ a: 1 }, { b: 2 }, { c: 3 }], offset: 0 };
        const result = normalizeVisibilityV1SuccessfulBody('/competitors/gap-prompts', body);
        expect(result.limit).to.equal(3);
      });

      it('coerces string limit', () => {
        const body = { data: [], limit: '20', offset: 0 };
        const result = normalizeVisibilityV1SuccessfulBody('/competitors/gap-prompts', body);
        expect(result.limit).to.equal(20);
      });

      it('coerces string offset', () => {
        const body = { data: [{}], offset: '5', limit: 10 };
        const result = normalizeVisibilityV1SuccessfulBody('/competitors/gap-prompts', body);
        expect(result.offset).to.equal(5);
      });

      it('skips non-object blocks in meta/pagination/page', () => {
        const body = {
          data: [], meta: null, pagination: [], page: 'bad', total: 0, offset: 0,
        };
        const result = normalizeVisibilityV1SuccessfulBody('/competitors/gap-prompts', body);
        expect(result.total).to.equal(0);
      });

      it('skips meta block with no matching total key', () => {
        const body = { data: [{}], meta: { something_else: 5 }, offset: 0 };
        const result = normalizeVisibilityV1SuccessfulBody('/competitors/gap-prompts', body);
        expect(result.total).to.equal(1);
      });
    });

    describe('/topics/research/source-domains normalization', () => {
      it('normalizes source domain rows', () => {
        const body = {
          data: [{
            source_domain: 'example.com',
            sources_count: 5,
            mentions: 10,
            organic_traffic: 100,
          }],
        };
        const result = normalizeVisibilityV1SuccessfulBody('/topics/research/source-domains', body);
        expect(result.data[0]).to.deep.include({
          source_domain: 'example.com',
          sources_count: 5,
          mentions: 10,
          organic_traffic: 100,
        });
      });

      it('handles string sourcesCount (num string branch)', () => {
        const body = { data: [{ source_domain: 'x.com', sources_count: '7', mentions: '3' }] };
        const result = normalizeVisibilityV1SuccessfulBody('/topics/research/source-domains', body);
        expect(result.data[0].sources_count).to.equal(7);
        expect(result.data[0].mentions).to.equal(3);
      });

      it('handles non-finite organic_traffic as 0', () => {
        const body = { data: [{ source_domain: 'x.com', organic_traffic: Number.NaN }] };
        const result = normalizeVisibilityV1SuccessfulBody('/topics/research/source-domains', body);
        expect(result.data[0].organic_traffic).to.equal(0);
      });

      it('maps camelCase field aliases', () => {
        const body = {
          data: [{
            source_domain: 'foo.com',
            sourcesCount: 3,
            overallMentions: 7,
          }],
        };
        const result = normalizeVisibilityV1SuccessfulBody('/topics/research/source-domains', body);
        expect(result.data[0].sources_count).to.equal(3);
        expect(result.data[0].mentions).to.equal(7);
      });

      it('uses domain field as fallback for source_domain', () => {
        const body = { data: [{ domain: 'bar.com' }] };
        const result = normalizeVisibilityV1SuccessfulBody('/topics/research/source-domains', body);
        expect(result.data[0].source_domain).to.equal('bar.com');
      });

      it('extracts prompt_example from various field names', () => {
        const cases = [
          [{ prompt_example: 'prompt 1' }, 'prompt 1'],
          [{ example_prompt: 'prompt 2' }, 'prompt 2'],
          [{ examplePrompt: 'prompt 3' }, 'prompt 3'],
          [{ sample_prompt: 'prompt 4' }, 'prompt 4'],
          [{ samplePrompt: 'prompt 5' }, 'prompt 5'],
          [{ example_prompt_text: 'prompt 6' }, 'prompt 6'],
          [{ examplePromptText: 'prompt 7' }, 'prompt 7'],
          [{ example: { prompt: 'prompt 8' } }, 'prompt 8'],
          [{ example: { text: 'prompt 9' } }, 'prompt 9'],
        ];
        for (const [fields, expected] of cases) {
          const body = { data: [{ source_domain: 'x.com', ...fields }] };
          const result = normalizeVisibilityV1SuccessfulBody('/topics/research/source-domains', body);
          expect(result.data[0].prompt_example).to.equal(expected);
        }
      });

      it('ignores example object when all fields are empty', () => {
        const body = { data: [{ source_domain: 'x.com', example: { other: 'ignored' } }] };
        const result = normalizeVisibilityV1SuccessfulBody('/topics/research/source-domains', body);
        expect(result.data[0]).not.to.have.property('prompt_example');
      });

      it('ignores non-string non-null non-number value in example fields (nonEmptyTrimmedString fallback)', () => {
        const body = { data: [{ source_domain: 'x.com', example: { prompt: true } }] };
        const result = normalizeVisibilityV1SuccessfulBody('/topics/research/source-domains', body);
        expect(result.data[0]).not.to.have.property('prompt_example');
      });

      it('omits prompt_example when not present', () => {
        const body = { data: [{ source_domain: 'x.com' }] };
        const result = normalizeVisibilityV1SuccessfulBody('/topics/research/source-domains', body);
        expect(result.data[0]).not.to.have.property('prompt_example');
      });

      it('defaults organic_traffic to 0 when missing', () => {
        const body = { data: [{ source_domain: 'x.com' }] };
        const result = normalizeVisibilityV1SuccessfulBody('/topics/research/source-domains', body);
        expect(result.data[0].organic_traffic).to.equal(0);
      });

      it('passes through non-object items in data array unchanged', () => {
        const body = { data: [null, 'string', 42] };
        const result = normalizeVisibilityV1SuccessfulBody('/topics/research/source-domains', body);
        expect(result.data).to.deep.equal([null, 'string', 42]);
      });

      it('defaults to empty array when data is missing', () => {
        const result = normalizeVisibilityV1SuccessfulBody('/topics/research/source-domains', {});
        expect(result.data).to.deep.equal([]);
      });

      it('converts numeric source_domain to string', () => {
        const body = { data: [{ source_domain: 123 }] };
        const result = normalizeVisibilityV1SuccessfulBody('/topics/research/source-domains', body);
        expect(result.data[0].source_domain).to.equal('123');
      });

      it('handles numeric prompt example', () => {
        const body = { data: [{ source_domain: 'x.com', prompt_example: 42 }] };
        const result = normalizeVisibilityV1SuccessfulBody('/topics/research/source-domains', body);
        expect(result.data[0].prompt_example).to.equal('42');
      });

      it('coerces non-finite string mentions to 0', () => {
        const body = { data: [{ source_domain: 'x.com', mentions: 'abc' }] };
        const result = normalizeVisibilityV1SuccessfulBody('/topics/research/source-domains', body);
        expect(result.data[0].mentions).to.equal(0);
      });

      it('coerces non-numeric object mentions to 0', () => {
        const body = { data: [{ source_domain: 'x.com', mentions: {} }] };
        const result = normalizeVisibilityV1SuccessfulBody('/topics/research/source-domains', body);
        expect(result.data[0].mentions).to.equal(0);
      });

      it('defaults source_domain to empty string when neither source_domain nor domain present', () => {
        const body = { data: [{ mentions: 1 }] };
        const result = normalizeVisibilityV1SuccessfulBody('/topics/research/source-domains', body);
        expect(result.data[0].source_domain).to.equal('');
      });
    });
  });
});
