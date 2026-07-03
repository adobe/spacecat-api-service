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
import { normalizeVisibilityV1SuccessfulBody } from '../../../src/support/ai-visibility/visibility-normalize.js';

describe('visibility-normalize', () => {
  describe('normalizeVisibilityV1SuccessfulBody', () => {
    it('returns body unchanged for unknown relPath', () => {
      const body = { data: [1, 2] };
      expect(normalizeVisibilityV1SuccessfulBody('/unknown/path', body)).to.equal(body);
    });

    it('returns null body unchanged', () => {
      expect(normalizeVisibilityV1SuccessfulBody('/competitors/gap-prompts', null)).to.be.null;
    });

    it('returns array body unchanged', () => {
      const body = [1, 2, 3];
      expect(normalizeVisibilityV1SuccessfulBody('/competitors/gap-prompts', body)).to.equal(body);
    });

    it('returns body unchanged when it contains "error" key', () => {
      const body = { error: 'fail' };
      expect(normalizeVisibilityV1SuccessfulBody('/competitors/gap-prompts', body)).to.equal(body);
    });

    it('returns non-object primitive body unchanged', () => {
      expect(normalizeVisibilityV1SuccessfulBody('/competitors/gap-prompts', 'string')).to.equal('string');
      expect(normalizeVisibilityV1SuccessfulBody('/competitors/gap-prompts', 42)).to.equal(42);
    });
  });

  describe('gap-prompts normalization', () => {
    const REL = '/competitors/gap-prompts';

    it('normalizes a well-formed response', () => {
      const body = {
        data: [{ id: 1 }, { id: 2 }], offset: 0, limit: 10, total: 50,
      };
      const result = normalizeVisibilityV1SuccessfulBody(REL, body);
      expect(result.data).to.deep.equal([{ id: 1 }, { id: 2 }]);
      expect(result.offset).to.equal(0);
      expect(result.limit).to.equal(10);
      expect(result.total).to.equal(50);
    });

    it('defaults data to empty array if not array', () => {
      const result = normalizeVisibilityV1SuccessfulBody(REL, { data: 'not-array' });
      expect(result.data).to.deep.equal([]);
    });

    it('defaults offset to 0 when missing', () => {
      const result = normalizeVisibilityV1SuccessfulBody(REL, {});
      expect(result.offset).to.equal(0);
    });

    it('coerces string offset to number', () => {
      const result = normalizeVisibilityV1SuccessfulBody(REL, { offset: '10' });
      expect(result.offset).to.equal(10);
    });

    it('defaults offset to 0 for non-finite string', () => {
      const result = normalizeVisibilityV1SuccessfulBody(REL, { offset: 'abc' });
      expect(result.offset).to.equal(0);
    });

    it('defaults offset to 0 for NaN', () => {
      const result = normalizeVisibilityV1SuccessfulBody(REL, { offset: NaN });
      expect(result.offset).to.equal(0);
    });

    it('defaults limit to data.length when missing', () => {
      const result = normalizeVisibilityV1SuccessfulBody(REL, { data: [1, 2, 3] });
      expect(result.limit).to.equal(3);
    });

    it('coerces string limit to number', () => {
      const result = normalizeVisibilityV1SuccessfulBody(REL, { limit: '25' });
      expect(result.limit).to.equal(25);
    });

    it('defaults limit to data.length for empty string', () => {
      const result = normalizeVisibilityV1SuccessfulBody(REL, { limit: '', data: [1] });
      expect(result.limit).to.equal(1);
    });

    it('defaults limit to data.length for null', () => {
      const result = normalizeVisibilityV1SuccessfulBody(REL, { limit: null, data: [1, 2] });
      expect(result.limit).to.equal(2);
    });

    it('defaults limit to data.length for non-finite string limit', () => {
      const result = normalizeVisibilityV1SuccessfulBody(REL, { limit: 'abc', data: [1] });
      expect(result.limit).to.equal(1);
    });

    describe('total extraction', () => {
      it('extracts total from "total" key', () => {
        const result = normalizeVisibilityV1SuccessfulBody(REL, { total: 100 });
        expect(result.total).to.equal(100);
      });

      it('extracts total from "total_count" key', () => {
        const result = normalizeVisibilityV1SuccessfulBody(REL, { total_count: 200 });
        expect(result.total).to.equal(200);
      });

      it('extracts total from "totalCount" key', () => {
        const result = normalizeVisibilityV1SuccessfulBody(REL, { totalCount: 150 });
        expect(result.total).to.equal(150);
      });

      it('extracts total from "row_count" key', () => {
        const result = normalizeVisibilityV1SuccessfulBody(REL, { row_count: 80 });
        expect(result.total).to.equal(80);
      });

      it('extracts total from "rowCount" key', () => {
        const result = normalizeVisibilityV1SuccessfulBody(REL, { rowCount: 90 });
        expect(result.total).to.equal(90);
      });

      it('extracts total from meta.total', () => {
        const result = normalizeVisibilityV1SuccessfulBody(REL, { meta: { total: 300 } });
        expect(result.total).to.equal(300);
      });

      it('extracts total from pagination.total', () => {
        const result = normalizeVisibilityV1SuccessfulBody(REL, { pagination: { total: 400 } });
        expect(result.total).to.equal(400);
      });

      it('extracts total from page.total_count', () => {
        const result = normalizeVisibilityV1SuccessfulBody(REL, { page: { total_count: 500 } });
        expect(result.total).to.equal(500);
      });

      it('skips null nested blocks (meta/pagination/page)', () => {
        const result = normalizeVisibilityV1SuccessfulBody(REL, {
          meta: null, pagination: null, page: null, data: [1],
        });
        expect(result.total).to.equal(1);
      });

      it('skips array nested blocks', () => {
        const result = normalizeVisibilityV1SuccessfulBody(REL, {
          meta: [1, 2], data: [1, 2, 3],
        });
        expect(result.total).to.equal(3);
      });

      it('skips nested block that is a valid object but has no matching total keys', () => {
        const result = normalizeVisibilityV1SuccessfulBody(REL, {
          meta: { unrelated: 'value' }, data: [1, 2],
        });
        expect(result.total).to.equal(2);
      });

      it('calculates total as offset + data.length when no explicit total', () => {
        const result = normalizeVisibilityV1SuccessfulBody(REL, {
          offset: 10, data: [1, 2, 3],
        });
        expect(result.total).to.equal(13);
      });

      it('enforces floor: total cannot be less than offset + data.length', () => {
        const result = normalizeVisibilityV1SuccessfulBody(REL, {
          total: 2, offset: 5, data: [1, 2, 3],
        });
        expect(result.total).to.equal(8);
      });
    });

    describe('total coercion from strings', () => {
      it('coerces string total to number', () => {
        const result = normalizeVisibilityV1SuccessfulBody(REL, { total: '42' });
        expect(result.total).to.equal(42);
      });

      it('handles comma-separated number strings', () => {
        const result = normalizeVisibilityV1SuccessfulBody(REL, { total: '1,234' });
        expect(result.total).to.equal(1234);
      });

      it('truncates float totals', () => {
        const result = normalizeVisibilityV1SuccessfulBody(REL, { total: 10.7 });
        expect(result.total).to.equal(10);
      });

      it('truncates float string totals', () => {
        const result = normalizeVisibilityV1SuccessfulBody(REL, { total: '10.7' });
        expect(result.total).to.equal(10);
      });

      it('returns undefined for empty string total (falls through to fallback)', () => {
        const result = normalizeVisibilityV1SuccessfulBody(REL, { total: '', data: [1] });
        expect(result.total).to.equal(1);
      });

      it('returns undefined for alphabetic string total (falls through to fallback)', () => {
        const result = normalizeVisibilityV1SuccessfulBody(REL, { total: 'abc', data: [1, 2] });
        expect(result.total).to.equal(2);
      });

      it('handles scientific notation strings', () => {
        const result = normalizeVisibilityV1SuccessfulBody(REL, { total: '1e2' });
        expect(result.total).to.equal(100);
      });

      it('returns undefined for boolean total', () => {
        const result = normalizeVisibilityV1SuccessfulBody(REL, { total: true, data: [1] });
        expect(result.total).to.equal(1);
      });

      it('returns undefined for Infinity', () => {
        const result = normalizeVisibilityV1SuccessfulBody(REL, { total: Infinity, data: [] });
        expect(result.total).to.equal(0);
      });

      it('returns undefined for NaN total', () => {
        const result = normalizeVisibilityV1SuccessfulBody(REL, { total: NaN, data: [1] });
        expect(result.total).to.equal(1);
      });

      it('handles string with only commas/whitespace (empty after cleanup)', () => {
        const result = normalizeVisibilityV1SuccessfulBody(REL, { total: ' , , ', data: [] });
        expect(result.total).to.equal(0);
      });

      it('handles mixed alpha string with digits rejected by alpha check', () => {
        const result = normalizeVisibilityV1SuccessfulBody(REL, { total: '12abc', data: [1] });
        expect(result.total).to.equal(1);
      });

      it('returns undefined for non-alpha string that parses to NaN (e.g. ".")', () => {
        const result = normalizeVisibilityV1SuccessfulBody(REL, { total: '.', data: [1, 2] });
        expect(result.total).to.equal(2);
      });
    });

    it('preserves extra body keys', () => {
      const result = normalizeVisibilityV1SuccessfulBody(REL, {
        data: [], extra: 'kept', nested: { a: 1 },
      });
      expect(result.extra).to.equal('kept');
      expect(result.nested).to.deep.equal({ a: 1 });
    });
  });

  describe('source-domains normalization', () => {
    const REL = '/topics/research/source-domains';

    it('normalizes a well-formed source domain row', () => {
      const body = {
        data: [{
          source_domain: 'example.com',
          sourcesCount: 5,
          mentions: 10,
          organic_traffic: 100,
          prompt_example: 'test prompt',
        }],
      };
      const result = normalizeVisibilityV1SuccessfulBody(REL, body);
      expect(result.data[0]).to.deep.equal({
        sourceDomain: 'example.com',
        sourcesCount: 5,
        mentions: 10,
        organicTraffic: 100,
        promptExample: 'test prompt',
      });
    });

    it('defaults data to empty array if not an array', () => {
      const result = normalizeVisibilityV1SuccessfulBody(REL, { data: 'bad' });
      expect(result.data).to.deep.equal([]);
    });

    it('uses sources_count field name variant', () => {
      const body = { data: [{ sources_count: 3 }] };
      const result = normalizeVisibilityV1SuccessfulBody(REL, body);
      expect(result.data[0].sourcesCount).to.equal(3);
    });

    it('prefers sourcesCount over sources_count', () => {
      const body = { data: [{ sourcesCount: 7, sources_count: 3 }] };
      const result = normalizeVisibilityV1SuccessfulBody(REL, body);
      expect(result.data[0].sourcesCount).to.equal(7);
    });

    it('uses overallMentions variant', () => {
      const body = { data: [{ overallMentions: 20 }] };
      const result = normalizeVisibilityV1SuccessfulBody(REL, body);
      expect(result.data[0].mentions).to.equal(20);
    });

    it('uses overall_mentions variant', () => {
      const body = { data: [{ overall_mentions: 15 }] };
      const result = normalizeVisibilityV1SuccessfulBody(REL, body);
      expect(result.data[0].mentions).to.equal(15);
    });

    it('prefers mentions over overallMentions', () => {
      const body = { data: [{ mentions: 5, overallMentions: 20 }] };
      const result = normalizeVisibilityV1SuccessfulBody(REL, body);
      expect(result.data[0].mentions).to.equal(5);
    });

    it('uses domain field when source_domain is absent', () => {
      const body = { data: [{ domain: 'fallback.com' }] };
      const result = normalizeVisibilityV1SuccessfulBody(REL, body);
      expect(result.data[0].sourceDomain).to.equal('fallback.com');
    });

    it('trims source_domain', () => {
      const body = { data: [{ source_domain: '  example.com  ' }] };
      const result = normalizeVisibilityV1SuccessfulBody(REL, body);
      expect(result.data[0].sourceDomain).to.equal('example.com');
    });

    it('defaults source_domain to empty string when both missing', () => {
      const body = { data: [{}] };
      const result = normalizeVisibilityV1SuccessfulBody(REL, body);
      expect(result.data[0].sourceDomain).to.equal('');
    });

    describe('organic_traffic handling', () => {
      it('uses organicTraffic variant', () => {
        const body = { data: [{ organicTraffic: 500 }] };
        const result = normalizeVisibilityV1SuccessfulBody(REL, body);
        expect(result.data[0].organicTraffic).to.equal(500);
      });

      it('defaults to 0 when organic_traffic is undefined', () => {
        const body = { data: [{}] };
        const result = normalizeVisibilityV1SuccessfulBody(REL, body);
        expect(result.data[0].organicTraffic).to.equal(0);
      });

      it('defaults to 0 when organic_traffic is null', () => {
        const body = { data: [{ organic_traffic: null }] };
        const result = normalizeVisibilityV1SuccessfulBody(REL, body);
        expect(result.data[0].organicTraffic).to.equal(0);
      });

      it('defaults to 0 when organic_traffic is empty string', () => {
        const body = { data: [{ organic_traffic: '' }] };
        const result = normalizeVisibilityV1SuccessfulBody(REL, body);
        expect(result.data[0].organicTraffic).to.equal(0);
      });

      it('defaults to 0 when organic_traffic is non-finite (NaN)', () => {
        const body = { data: [{ organic_traffic: NaN }] };
        const result = normalizeVisibilityV1SuccessfulBody(REL, body);
        expect(result.data[0].organicTraffic).to.equal(0);
      });

      it('defaults to 0 when organic_traffic is Infinity', () => {
        const body = { data: [{ organic_traffic: Infinity }] };
        const result = normalizeVisibilityV1SuccessfulBody(REL, body);
        expect(result.data[0].organicTraffic).to.equal(0);
      });

      it('normalizes string organic_traffic', () => {
        const body = { data: [{ organic_traffic: '1,234' }] };
        const result = normalizeVisibilityV1SuccessfulBody(REL, body);
        expect(result.data[0].organicTraffic).to.equal(1234);
      });
    });

    describe('prompt_example extraction', () => {
      it('extracts from prompt_example field', () => {
        const body = { data: [{ prompt_example: 'hello' }] };
        const result = normalizeVisibilityV1SuccessfulBody(REL, body);
        expect(result.data[0].promptExample).to.equal('hello');
      });

      it('extracts from example_prompt field', () => {
        const body = { data: [{ example_prompt: 'from example_prompt' }] };
        const result = normalizeVisibilityV1SuccessfulBody(REL, body);
        expect(result.data[0].promptExample).to.equal('from example_prompt');
      });

      it('extracts from examplePrompt field', () => {
        const body = { data: [{ examplePrompt: 'from examplePrompt' }] };
        const result = normalizeVisibilityV1SuccessfulBody(REL, body);
        expect(result.data[0].promptExample).to.equal('from examplePrompt');
      });

      it('extracts from sample_prompt field', () => {
        const body = { data: [{ sample_prompt: 'from sample_prompt' }] };
        const result = normalizeVisibilityV1SuccessfulBody(REL, body);
        expect(result.data[0].promptExample).to.equal('from sample_prompt');
      });

      it('extracts from samplePrompt field', () => {
        const body = { data: [{ samplePrompt: 'from samplePrompt' }] };
        const result = normalizeVisibilityV1SuccessfulBody(REL, body);
        expect(result.data[0].promptExample).to.equal('from samplePrompt');
      });

      it('extracts from example_prompt_text field', () => {
        const body = { data: [{ example_prompt_text: 'from ept' }] };
        const result = normalizeVisibilityV1SuccessfulBody(REL, body);
        expect(result.data[0].promptExample).to.equal('from ept');
      });

      it('extracts from examplePromptText field', () => {
        const body = { data: [{ examplePromptText: 'from EPT' }] };
        const result = normalizeVisibilityV1SuccessfulBody(REL, body);
        expect(result.data[0].promptExample).to.equal('from EPT');
      });

      it('extracts from example.prompt nested field', () => {
        const body = { data: [{ example: { prompt: 'nested prompt' } }] };
        const result = normalizeVisibilityV1SuccessfulBody(REL, body);
        expect(result.data[0].promptExample).to.equal('nested prompt');
      });

      it('extracts from example.text nested field', () => {
        const body = { data: [{ example: { text: 'nested text' } }] };
        const result = normalizeVisibilityV1SuccessfulBody(REL, body);
        expect(result.data[0].promptExample).to.equal('nested text');
      });

      it('extracts from example.example_prompt nested field', () => {
        const body = { data: [{ example: { example_prompt: 'nested ep' } }] };
        const result = normalizeVisibilityV1SuccessfulBody(REL, body);
        expect(result.data[0].promptExample).to.equal('nested ep');
      });

      it('extracts from example.examplePrompt nested field', () => {
        const body = { data: [{ example: { examplePrompt: 'nested EP' } }] };
        const result = normalizeVisibilityV1SuccessfulBody(REL, body);
        expect(result.data[0].promptExample).to.equal('nested EP');
      });

      it('does not set prompt_example when no candidate matches', () => {
        const body = { data: [{ source_domain: 'x.com' }] };
        const result = normalizeVisibilityV1SuccessfulBody(REL, body);
        expect(result.data[0]).to.not.have.property('promptExample');
      });

      it('skips null example object', () => {
        const body = { data: [{ example: null }] };
        const result = normalizeVisibilityV1SuccessfulBody(REL, body);
        expect(result.data[0]).to.not.have.property('promptExample');
      });

      it('skips array example object', () => {
        const body = { data: [{ example: [1, 2] }] };
        const result = normalizeVisibilityV1SuccessfulBody(REL, body);
        expect(result.data[0]).to.not.have.property('promptExample');
      });

      it('skips example object with no matching sub-fields', () => {
        const body = { data: [{ example: { irrelevant: 'nope' } }] };
        const result = normalizeVisibilityV1SuccessfulBody(REL, body);
        expect(result.data[0]).to.not.have.property('promptExample');
      });

      it('trims prompt_example whitespace', () => {
        const body = { data: [{ prompt_example: '  spaced  ' }] };
        const result = normalizeVisibilityV1SuccessfulBody(REL, body);
        expect(result.data[0].promptExample).to.equal('spaced');
      });

      it('handles numeric prompt_example via nonEmptyTrimmedString', () => {
        const body = { data: [{ prompt_example: 42 }] };
        const result = normalizeVisibilityV1SuccessfulBody(REL, body);
        expect(result.data[0].promptExample).to.equal('42');
      });

      it('skips non-finite numeric prompt_example', () => {
        const body = { data: [{ prompt_example: NaN }] };
        const result = normalizeVisibilityV1SuccessfulBody(REL, body);
        expect(result.data[0]).to.not.have.property('promptExample');
      });

      it('skips Infinity prompt_example', () => {
        const body = { data: [{ prompt_example: Infinity }] };
        const result = normalizeVisibilityV1SuccessfulBody(REL, body);
        expect(result.data[0]).to.not.have.property('promptExample');
      });

      it('prefers first matching candidate in priority order', () => {
        const body = { data: [{ prompt_example: 'first', example_prompt: 'second' }] };
        const result = normalizeVisibilityV1SuccessfulBody(REL, body);
        expect(result.data[0].promptExample).to.equal('first');
      });
    });

    it('passes through non-object data items unchanged', () => {
      const body = { data: [null, 'string', 42, [1]] };
      const result = normalizeVisibilityV1SuccessfulBody(REL, body);
      expect(result.data).to.deep.equal([null, 'string', 42, [1]]);
    });

    it('preserves extra body keys', () => {
      const result = normalizeVisibilityV1SuccessfulBody(REL, { data: [], extra: 'kept' });
      expect(result.extra).to.equal('kept');
    });

    describe('numN helper (exercised via source domain fields)', () => {
      it('returns 0 for null/undefined values', () => {
        const body = { data: [{ sourcesCount: null }] };
        const result = normalizeVisibilityV1SuccessfulBody(REL, body);
        expect(result.data[0].sourcesCount).to.equal(0);
      });

      it('returns 0 for empty string', () => {
        const body = { data: [{ sourcesCount: '' }] };
        const result = normalizeVisibilityV1SuccessfulBody(REL, body);
        expect(result.data[0].sourcesCount).to.equal(0);
      });

      it('coerces comma-separated string numbers', () => {
        const body = { data: [{ sourcesCount: '1,000' }] };
        const result = normalizeVisibilityV1SuccessfulBody(REL, body);
        expect(result.data[0].sourcesCount).to.equal(1000);
      });

      it('returns 0 for non-finite string values', () => {
        const body = { data: [{ sourcesCount: 'not-a-number' }] };
        const result = normalizeVisibilityV1SuccessfulBody(REL, body);
        expect(result.data[0].sourcesCount).to.equal(0);
      });

      it('returns 0 for NaN number', () => {
        const body = { data: [{ sourcesCount: NaN }] };
        const result = normalizeVisibilityV1SuccessfulBody(REL, body);
        expect(result.data[0].sourcesCount).to.equal(0);
      });

      it('returns 0 for Infinity', () => {
        const body = { data: [{ sourcesCount: Infinity }] };
        const result = normalizeVisibilityV1SuccessfulBody(REL, body);
        expect(result.data[0].sourcesCount).to.equal(0);
      });

      it('coerces boolean-like values via Number()', () => {
        const body = { data: [{ sourcesCount: true }] };
        const result = normalizeVisibilityV1SuccessfulBody(REL, body);
        expect(result.data[0].sourcesCount).to.equal(1);
      });
    });
  });
});
