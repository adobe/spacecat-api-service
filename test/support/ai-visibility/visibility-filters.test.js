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
  SR_AI_SEO_SUPPORTED_MARKET_CODES,
  SR_VISIBILITY_MARKETS_CATALOG,
  SR_VISIBILITY_MODELS_CATALOG,
  normalizeMarketToken,
  resolveVisibilityMarketFromSearchParams,
  normalizeEngineFromQuery,
  attachSrFiltersToSuccessfulBody,
} from '../../../src/support/ai-visibility/visibility-filters.js';

describe('visibility-filters', () => {
  describe('SR_AI_SEO_SUPPORTED_MARKET_CODES', () => {
    it('is an array of uppercase two-letter codes', () => {
      expect(SR_AI_SEO_SUPPORTED_MARKET_CODES).to.be.an('array').that.is.not.empty;
      for (const code of SR_AI_SEO_SUPPORTED_MARKET_CODES) {
        expect(code).to.match(/^[A-Z]{2}$/);
      }
    });

    it('contains expected market codes', () => {
      expect(SR_AI_SEO_SUPPORTED_MARKET_CODES).to.include.members(['US', 'UK', 'DE', 'FR', 'JP']);
    });
  });

  describe('SR_VISIBILITY_MARKETS_CATALOG', () => {
    it('starts with WW followed by all supported market codes', () => {
      expect(SR_VISIBILITY_MARKETS_CATALOG[0]).to.equal('WW');
      const tail = SR_VISIBILITY_MARKETS_CATALOG.slice(1);
      expect(tail).to.deep.equal(SR_AI_SEO_SUPPORTED_MARKET_CODES);
    });
  });

  describe('SR_VISIBILITY_MODELS_CATALOG', () => {
    it('lists the expected models', () => {
      expect(SR_VISIBILITY_MODELS_CATALOG).to.deep.equal([
        'all', 'chatgpt', 'gemini', 'googleAiMode', 'googleAiOverview',
      ]);
    });
  });

  describe('normalizeMarketToken', () => {
    it('returns WW for "WW"', () => {
      expect(normalizeMarketToken('WW')).to.equal('WW');
    });

    it('returns WW for "ww" (case-insensitive)', () => {
      expect(normalizeMarketToken('ww')).to.equal('WW');
    });

    it('returns WW for "WORLDWIDE"', () => {
      expect(normalizeMarketToken('WORLDWIDE')).to.equal('WW');
    });

    it('returns WW for "worldwide" (case-insensitive)', () => {
      expect(normalizeMarketToken('worldwide')).to.equal('WW');
    });

    it('maps GB to UK', () => {
      expect(normalizeMarketToken('GB')).to.equal('UK');
      expect(normalizeMarketToken('gb')).to.equal('UK');
    });

    it('returns valid supported market codes as-is (uppercased)', () => {
      expect(normalizeMarketToken('us')).to.equal('US');
      expect(normalizeMarketToken('DE')).to.equal('DE');
      expect(normalizeMarketToken('jp')).to.equal('JP');
    });

    it('defaults unknown codes to US', () => {
      expect(normalizeMarketToken('XX')).to.equal('US');
      expect(normalizeMarketToken('NOPE')).to.equal('US');
    });

    it('trims whitespace before normalizing', () => {
      expect(normalizeMarketToken('  DE  ')).to.equal('DE');
      expect(normalizeMarketToken(' ww ')).to.equal('WW');
    });
  });

  describe('resolveVisibilityMarketFromSearchParams', () => {
    function sp(params) {
      return new URLSearchParams(params);
    }

    it('returns normalized country when present', () => {
      expect(resolveVisibilityMarketFromSearchParams(sp({ country: 'de' }))).to.equal('DE');
    });

    it('falls back to region when country is absent', () => {
      expect(resolveVisibilityMarketFromSearchParams(sp({ region: 'JP' }))).to.equal('JP');
    });

    it('defaults to US when neither country nor region is present', () => {
      expect(resolveVisibilityMarketFromSearchParams(sp({}))).to.equal('US');
    });

    it('defaults to US when region is empty', () => {
      expect(resolveVisibilityMarketFromSearchParams(sp({ region: '' }))).to.equal('US');
    });

    it('defaults to US when region is whitespace', () => {
      expect(resolveVisibilityMarketFromSearchParams(sp({ region: '   ' }))).to.equal('US');
    });

    it('prefers country over region', () => {
      expect(resolveVisibilityMarketFromSearchParams(sp({ country: 'FR', region: 'DE' }))).to.equal('FR');
    });

    it('trims country param', () => {
      expect(resolveVisibilityMarketFromSearchParams(sp({ country: '  GB  ' }))).to.equal('UK');
    });
  });

  describe('normalizeEngineFromQuery', () => {
    it('returns null for null', () => {
      expect(normalizeEngineFromQuery(null)).to.be.null;
    });

    it('returns null for undefined', () => {
      expect(normalizeEngineFromQuery(undefined)).to.be.null;
    });

    it('returns null for empty string', () => {
      expect(normalizeEngineFromQuery('')).to.be.null;
    });

    it('returns null for "all"', () => {
      expect(normalizeEngineFromQuery('all')).to.be.null;
    });

    it('maps known engines', () => {
      expect(normalizeEngineFromQuery('chatgpt')).to.equal('chatgpt');
      expect(normalizeEngineFromQuery('gemini')).to.equal('gemini');
      expect(normalizeEngineFromQuery('aimode')).to.equal('googleAiMode');
      expect(normalizeEngineFromQuery('overview')).to.equal('googleAiOverview');
      expect(normalizeEngineFromQuery('googleAiMode')).to.equal('googleAiMode');
      expect(normalizeEngineFromQuery('googleAiOverview')).to.equal('googleAiOverview');
      expect(normalizeEngineFromQuery('google_ai_mode')).to.equal('googleAiMode');
      expect(normalizeEngineFromQuery('google_ai_overview')).to.equal('googleAiOverview');
    });

    it('is case-insensitive for known engines', () => {
      expect(normalizeEngineFromQuery('ChatGPT')).to.equal('chatgpt');
      expect(normalizeEngineFromQuery('GEMINI')).to.equal('gemini');
      expect(normalizeEngineFromQuery('AiMode')).to.equal('googleAiMode');
    });

    it('returns trimmed original for unknown engines', () => {
      expect(normalizeEngineFromQuery('  perplexity  ')).to.equal('perplexity');
    });
  });

  describe('attachSrFiltersToSuccessfulBody', () => {
    it('returns body unchanged for non-200 status', () => {
      const body = { foo: 'bar' };
      expect(attachSrFiltersToSuccessfulBody(404, body)).to.equal(body);
      expect(attachSrFiltersToSuccessfulBody(500, body)).to.equal(body);
    });

    it('returns body unchanged when body has "error" key', () => {
      const body = { error: 'something failed' };
      expect(attachSrFiltersToSuccessfulBody(200, body)).to.equal(body);
    });

    it('returns body unchanged when body is null', () => {
      expect(attachSrFiltersToSuccessfulBody(200, null)).to.be.null;
    });

    it('returns body unchanged when body is an array', () => {
      const body = [1, 2, 3];
      expect(attachSrFiltersToSuccessfulBody(200, body)).to.equal(body);
    });

    it('returns body unchanged when body is a non-object primitive', () => {
      expect(attachSrFiltersToSuccessfulBody(200, 'string')).to.equal('string');
    });

    it('attaches srFilters with default catalogs for empty body', () => {
      const result = attachSrFiltersToSuccessfulBody(200, {});
      expect(result).to.have.property('srFilters');
      expect(result.srFilters.markets).to.deep.equal([...SR_VISIBILITY_MARKETS_CATALOG]);
      expect(result.srFilters.models).to.deep.equal([...SR_VISIBILITY_MODELS_CATALOG]);
      expect(result.srFilters.marketsCatalog).to.deep.equal([...SR_VISIBILITY_MARKETS_CATALOG]);
      expect(result.srFilters.modelsCatalog).to.deep.equal([...SR_VISIBILITY_MODELS_CATALOG]);
    });

    it('extracts countries from nested data', () => {
      const body = { data: [{ country: 'DE' }, { country: 'JP' }] };
      const result = attachSrFiltersToSuccessfulBody(200, body);
      expect(result.srFilters.markets).to.include('DE');
      expect(result.srFilters.markets).to.include('JP');
    });

    it('extracts engines from nested data', () => {
      const body = { data: [{ engine: 'chatgpt' }, { engine: 'gemini' }] };
      const result = attachSrFiltersToSuccessfulBody(200, body);
      expect(result.srFilters.models).to.include('chatgpt');
      expect(result.srFilters.models).to.include('gemini');
    });

    it('extracts llm field as model', () => {
      const body = { data: [{ llm: 'chatgpt' }] };
      const result = attachSrFiltersToSuccessfulBody(200, body);
      expect(result.srFilters.models).to.include('chatgpt');
    });

    it('includes searchParams country in filters', () => {
      const sp = new URLSearchParams({ country: 'FR' });
      const result = attachSrFiltersToSuccessfulBody(200, {}, sp);
      expect(result.srFilters.markets).to.include('FR');
    });

    it('includes searchParams engine in filters', () => {
      const sp = new URLSearchParams({ engine: 'gemini' });
      const result = attachSrFiltersToSuccessfulBody(200, {}, sp);
      expect(result.srFilters.models).to.include('gemini');
    });

    it('does not add model when searchParams engine is "all"', () => {
      const sp = new URLSearchParams({ engine: 'all' });
      const result = attachSrFiltersToSuccessfulBody(200, {}, sp);
      expect(result.srFilters.models).to.deep.equal([...SR_VISIBILITY_MODELS_CATALOG]);
    });

    it('handles null searchParams', () => {
      const result = attachSrFiltersToSuccessfulBody(200, {}, null);
      expect(result.srFilters.markets).to.deep.equal([...SR_VISIBILITY_MARKETS_CATALOG]);
    });

    it('returns sorted unique markets when body has countries', () => {
      const body = { data: [{ country: 'JP' }, { country: 'DE' }, { country: 'JP' }] };
      const result = attachSrFiltersToSuccessfulBody(200, body);
      const { markets } = result.srFilters;
      const sorted = [...markets].sort((a, b) => a.localeCompare(b));
      expect(markets).to.deep.equal(sorted);
    });

    it('returns sorted unique models when body has engines', () => {
      const body = { data: [{ engine: 'gemini' }, { engine: 'chatgpt' }, { engine: 'gemini' }] };
      const result = attachSrFiltersToSuccessfulBody(200, body);
      const { models } = result.srFilters;
      const sorted = [...models].sort((a, b) => a.localeCompare(b));
      expect(models).to.deep.equal(sorted);
    });

    it('extracts models from mentions breakdown objects', () => {
      const body = {
        data: [{
          mentions: {
            all: 10,
            chatgpt: 5,
            gemini: 5,
          },
        }],
      };
      const result = attachSrFiltersToSuccessfulBody(200, body);
      expect(result.srFilters.models).to.include('chatgpt');
      expect(result.srFilters.models).to.include('gemini');
    });

    it('extracts models from citedPages breakdown objects', () => {
      const body = {
        data: [{
          citedPages: {
            all: 20,
            googleAiMode: 10,
            googleAiOverview: 10,
          },
        }],
      };
      const result = attachSrFiltersToSuccessfulBody(200, body);
      expect(result.srFilters.models).to.include('googleAiMode');
      expect(result.srFilters.models).to.include('googleAiOverview');
    });

    it('skips non-object mentions/citedPages (null, array, primitive)', () => {
      const body = {
        data: [{
          mentions: null,
          citedPages: [1, 2],
        }],
      };
      const result = attachSrFiltersToSuccessfulBody(200, body);
      expect(result.srFilters.models).to.deep.equal([...SR_VISIBILITY_MODELS_CATALOG]);
    });

    it('skips "all" key in breakdown objects', () => {
      const body = {
        data: [{
          mentions: { all: 10 },
        }],
      };
      const result = attachSrFiltersToSuccessfulBody(200, body);
      expect(result.srFilters.models).to.deep.equal([...SR_VISIBILITY_MODELS_CATALOG]);
    });

    it('ignores non-string country/engine values in addMarket/addModel', () => {
      const body = { data: [{ country: 123, engine: 456 }] };
      const result = attachSrFiltersToSuccessfulBody(200, body);
      expect(result.srFilters.markets).to.deep.equal([...SR_VISIBILITY_MARKETS_CATALOG]);
      expect(result.srFilters.models).to.deep.equal([...SR_VISIBILITY_MODELS_CATALOG]);
    });

    it('ignores empty-string country/engine values', () => {
      const body = { data: [{ country: '', engine: '' }] };
      const result = attachSrFiltersToSuccessfulBody(200, body);
      expect(result.srFilters.markets).to.deep.equal([...SR_VISIBILITY_MARKETS_CATALOG]);
      expect(result.srFilters.models).to.deep.equal([...SR_VISIBILITY_MODELS_CATALOG]);
    });

    it('ignores whitespace-only country/engine values', () => {
      const body = { data: [{ country: '   ', engine: '   ' }] };
      const result = attachSrFiltersToSuccessfulBody(200, body);
      expect(result.srFilters.markets).to.deep.equal([...SR_VISIBILITY_MARKETS_CATALOG]);
      expect(result.srFilters.models).to.deep.equal([...SR_VISIBILITY_MODELS_CATALOG]);
    });

    it('stops recursion for depth > 24', () => {
      let nested = { country: 'DE' };
      for (let i = 0; i < 30; i += 1) {
        nested = { child: nested };
      }
      const result = attachSrFiltersToSuccessfulBody(200, nested);
      expect(result.srFilters.markets).to.deep.equal([...SR_VISIBILITY_MARKETS_CATALOG]);
    });

    it('handles deeply nested objects within the depth limit', () => {
      let nested = { country: 'JP' };
      for (let i = 0; i < 20; i += 1) {
        nested = { child: nested };
      }
      const result = attachSrFiltersToSuccessfulBody(200, nested);
      expect(result.srFilters.markets).to.include('JP');
    });

    it('preserves original body keys alongside srFilters', () => {
      const body = { foo: 'bar', baz: 42 };
      const result = attachSrFiltersToSuccessfulBody(200, body);
      expect(result.foo).to.equal('bar');
      expect(result.baz).to.equal(42);
      expect(result).to.have.property('srFilters');
    });

    it('models catalog remains default when no engines found and no searchParams engine', () => {
      const result = attachSrFiltersToSuccessfulBody(200, { data: [{ country: 'DE' }] });
      expect(result.srFilters.models).to.deep.equal([...SR_VISIBILITY_MODELS_CATALOG]);
    });

    it('handles engine "all" in addModel (normalize returns null, nothing added)', () => {
      const body = { data: [{ engine: 'all' }] };
      const result = attachSrFiltersToSuccessfulBody(200, body);
      expect(result.srFilters.models).to.deep.equal([...SR_VISIBILITY_MODELS_CATALOG]);
    });

    it('handles circular-like references gracefully via WeakSet', () => {
      const inner = { country: 'FR' };
      const body = { a: inner, b: inner };
      const result = attachSrFiltersToSuccessfulBody(200, body);
      expect(result.srFilters.markets).to.include('FR');
    });
  });
});
