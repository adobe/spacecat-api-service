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
  normalizeEngineFromQuery,
  resolveVisibilityMarketFromSearchParams,
  attachSrFiltersToSuccessfulBody,
} from '../../../src/support/serenity/visibility-filters.js';

describe('visibility-filters', () => {
  describe('normalizeMarketToken', () => {
    it('maps WW variations to WW', () => {
      expect(normalizeMarketToken('WW')).to.equal('WW');
      expect(normalizeMarketToken('ww')).to.equal('WW');
      expect(normalizeMarketToken('WORLDWIDE')).to.equal('WW');
      expect(normalizeMarketToken('worldwide')).to.equal('WW');
    });

    it('maps GB to UK', () => {
      expect(normalizeMarketToken('GB')).to.equal('UK');
      expect(normalizeMarketToken('gb')).to.equal('UK');
    });

    it('returns known market codes as-is (uppercased)', () => {
      expect(normalizeMarketToken('us')).to.equal('US');
      expect(normalizeMarketToken('DE')).to.equal('DE');
      expect(normalizeMarketToken('fr')).to.equal('FR');
    });

    it('falls back to US for unknown codes', () => {
      expect(normalizeMarketToken('XX')).to.equal('US');
      expect(normalizeMarketToken('ZZ')).to.equal('US');
    });

    it('handles whitespace', () => {
      expect(normalizeMarketToken('  US  ')).to.equal('US');
    });
  });

  describe('normalizeEngineFromQuery', () => {
    it('returns null for null, empty string, or "all"', () => {
      expect(normalizeEngineFromQuery(null)).to.equal(null);
      expect(normalizeEngineFromQuery('')).to.equal(null);
      expect(normalizeEngineFromQuery('all')).to.equal(null);
    });

    it('maps known aliases', () => {
      expect(normalizeEngineFromQuery('chatgpt')).to.equal('chatgpt');
      expect(normalizeEngineFromQuery('gemini')).to.equal('gemini');
      expect(normalizeEngineFromQuery('aimode')).to.equal('google_ai_mode');
      expect(normalizeEngineFromQuery('overview')).to.equal('google_ai_overview');
      expect(normalizeEngineFromQuery('google_ai_mode')).to.equal('google_ai_mode');
      expect(normalizeEngineFromQuery('google_ai_overview')).to.equal('google_ai_overview');
    });

    it('returns trimmed original for unknown engine strings', () => {
      expect(normalizeEngineFromQuery('  unknown_engine  ')).to.equal('unknown_engine');
    });
  });

  describe('resolveVisibilityMarketFromSearchParams', () => {
    it('prefers country over region', () => {
      const sp = new URLSearchParams('country=DE&region=FR');
      expect(resolveVisibilityMarketFromSearchParams(sp)).to.equal('DE');
    });

    it('falls back to region when no country', () => {
      const sp = new URLSearchParams('region=FR');
      expect(resolveVisibilityMarketFromSearchParams(sp)).to.equal('FR');
    });

    it('defaults to US when neither present', () => {
      const sp = new URLSearchParams('');
      expect(resolveVisibilityMarketFromSearchParams(sp)).to.equal('US');
    });

    it('normalizes GB to UK', () => {
      const sp = new URLSearchParams('country=GB');
      expect(resolveVisibilityMarketFromSearchParams(sp)).to.equal('UK');
    });

    it('normalizes WORLDWIDE to WW', () => {
      const sp = new URLSearchParams('region=WORLDWIDE');
      expect(resolveVisibilityMarketFromSearchParams(sp)).to.equal('WW');
    });
  });

  describe('attachSrFiltersToSuccessfulBody', () => {
    it('returns body unchanged for non-200 status', () => {
      const body = { data: [] };
      expect(attachSrFiltersToSuccessfulBody(404, body, null)).to.equal(body);
    });

    it('returns body unchanged for null', () => {
      expect(attachSrFiltersToSuccessfulBody(200, null, null)).to.equal(null);
    });

    it('returns body unchanged for arrays', () => {
      const body = [1, 2, 3];
      expect(attachSrFiltersToSuccessfulBody(200, body, null)).to.equal(body);
    });

    it('returns body unchanged when it has an error key', () => {
      const body = { error: 'something' };
      expect(attachSrFiltersToSuccessfulBody(200, body, null)).to.equal(body);
    });

    it('attaches sr_filters with defaults when body has no market/model data', () => {
      const result = attachSrFiltersToSuccessfulBody(200, { data: [] }, null);
      expect(result).to.deep.include({ data: [] });
      expect(result.sr_filters).to.deep.equal({
        markets: [...SR_VISIBILITY_MARKETS_CATALOG],
        models: [...SR_VISIBILITY_MODELS_CATALOG],
        markets_catalog: [...SR_VISIBILITY_MARKETS_CATALOG],
        models_catalog: [...SR_VISIBILITY_MODELS_CATALOG],
      });
    });

    it('infers markets and models from response data', () => {
      const body = {
        data: [
          { country: 'DE', engine: 'chatgpt' },
          { country: 'FR', engine: 'gemini' },
        ],
      };
      const result = attachSrFiltersToSuccessfulBody(200, body, null);
      expect(result.sr_filters.markets).to.include('DE');
      expect(result.sr_filters.markets).to.include('FR');
      expect(result.sr_filters.models).to.include('chatgpt');
      expect(result.sr_filters.models).to.include('gemini');
    });

    it('merges market from searchParams', () => {
      const body = { data: [] };
      const sp = new URLSearchParams('country=JP');
      const result = attachSrFiltersToSuccessfulBody(200, body, sp);
      expect(result.sr_filters.markets).to.include('JP');
    });

    it('includes engine from searchParams in models', () => {
      const body = { data: [] };
      const sp = new URLSearchParams('engine=aimode');
      const result = attachSrFiltersToSuccessfulBody(200, body, sp);
      expect(result.sr_filters.models).to.include('google_ai_mode');
    });

    it('extracts models from mentions breakdown keys', () => {
      const body = {
        data: [{
          mentions: { chatgpt: 5, gemini: 3, all: 8 },
        }],
      };
      const result = attachSrFiltersToSuccessfulBody(200, body, null);
      expect(result.sr_filters.models).to.include('chatgpt');
      expect(result.sr_filters.models).to.include('gemini');
      expect(result.sr_filters.models).not.to.include('all');
    });

    it('extracts models from cited_pages breakdown keys', () => {
      const body = {
        data: [{
          cited_pages: { google_ai_mode: 2, all: 5 },
        }],
      };
      const result = attachSrFiltersToSuccessfulBody(200, body, null);
      expect(result.sr_filters.models).to.include('google_ai_mode');
    });

    it('infers models from llm field', () => {
      const body = { data: [{ llm: 'CHATGPT' }] };
      const result = attachSrFiltersToSuccessfulBody(200, body, null);
      expect(result.sr_filters.models).to.include('chatgpt');
    });

    it('normalizes GB to UK in inferred markets', () => {
      const body = { data: [{ country: 'GB' }] };
      const result = attachSrFiltersToSuccessfulBody(200, body, null);
      expect(result.sr_filters.markets).to.include('UK');
      expect(result.sr_filters.markets).not.to.include('GB');
    });

    it('catalog exports have correct shapes', () => {
      expect(SR_AI_SEO_SUPPORTED_MARKET_CODES).to.include('US');
      expect(SR_AI_SEO_SUPPORTED_MARKET_CODES).to.include('UK');
      expect(SR_VISIBILITY_MARKETS_CATALOG[0]).to.equal('WW');
      expect(SR_VISIBILITY_MODELS_CATALOG).to.include('all');
    });

    it('does not walk past depth 24 (cycle guard)', () => {
      const body = {};
      body.self = body;
      const result = attachSrFiltersToSuccessfulBody(200, body, null);
      expect(result.sr_filters).to.exist;
    });

    it('stops recursion at depth > 24 without cycle', () => {
      // Build 30 levels of nesting to trigger the depth guard
      let nested = { country: 'DE' };
      for (let i = 0; i < 30; i += 1) {
        nested = { child: nested };
      }
      const body = { top: nested };
      const result = attachSrFiltersToSuccessfulBody(200, body, null);
      expect(result.sr_filters).to.exist;
    });
  });
});
