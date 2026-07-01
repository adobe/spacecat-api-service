/* eslint-disable header/header */
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
  COUNTRY_ENUM,
  LLM_ENUM,
  TOPIC_INTENT_ENUM,
  LLM_UI,
  FTS_LLMS,
  EMPTY_ENGINE_BREAKDOWN,
  GAP_SOURCE_DOMAINS_MAX_RANGE_LIMIT,
  PROMPTS_RESPONSES_PROMPTS_SCAN_LIMIT,
  MAX_COMPETITOR_DOMAINS,
  TOPIC_OPPORTUNITY_PROMPTS_MAX_PAGES,
  num,
  brandTarget,
  parseLimitOffset,
  normalizeCountryForGrpc,
  resolveCountry,
  resolveCountryForFts,
  resolveCountryForCompetitorsMetrics,
  resolveCountryForCitedSources,
  restCountryFromGrpcRequestCountry,
  restCountryFromPromptProto,
  restMarketFromSourceDomainCountryField,
  engineToLlm,
  llmToEngine,
  requiredLlmFromQuery,
  optionalLlmFromQuery,
  parseMonthYM,
  exactSnapshotDate,
  statsByLLMDateRange,
  slugHostFromBrandName,
  normalizeTopBrandsByDomainNameKey,
  topBrandsByDomainEntryName,
  topBrandsByDomainEntryCount,
  mentionedBrandRestLabel,
  mentionedBrandsCountFromPromptProto,
  promptMatchesResponsesQuery,
  dateKey,
  sourcesListFromSourcesResponse,
  sourceDomainsListFromResponse,
  sourceDomainsByTopicFtsRows,
  sumVoTotalBySourceCategoryCounts,
  voTotalCountForSourceCategory,
  parseCompetitorDomainsList,
  parseGapKindEnumList,
  coerceProtoCommonGapKind,
  aggregateGapPromptsTotalFromTotals,
  resolveTopicIdsDimensionFilter,
  resolveTopicIds,
  MAX_TOPIC_IDS_DIMENSION_FILTER,
  TOPIC_INTENT_SLUG,
  mergeTopBrandsByDomainResponsesByMax,
  settledValueOrElse,
  settledFulfilledMap,
  buildTextFilterQl,
} from '../../../src/support/ai-visibility/grpc-utils.js';

function sp(query) {
  return new URLSearchParams(query);
}

describe('grpc-utils', () => {
  describe('buildTextFilterQl', () => {
    it('builds a CONTAINS clause for the given column', () => {
      expect(buildTextFilterQl('pdf', 'prompt')).to.equal('prompt CONTAINS "pdf"');
      expect(buildTextFilterQl('adobe', 'name')).to.equal('name CONTAINS "adobe"');
    });
    it('trims the filter text', () => {
      expect(buildTextFilterQl('  coffee  ', 'topic')).to.equal('topic CONTAINS "coffee"');
    });
    it('escapes embedded quotes and backslashes', () => {
      expect(buildTextFilterQl('a"b\\c', 'domain')).to.equal('domain CONTAINS "a\\"b\\\\c"');
    });
    it('returns empty string for empty / whitespace / nullish input', () => {
      expect(buildTextFilterQl('', 'prompt')).to.equal('');
      expect(buildTextFilterQl('   ', 'prompt')).to.equal('');
      expect(buildTextFilterQl(undefined, 'prompt')).to.equal('');
      expect(buildTextFilterQl(null, 'prompt')).to.equal('');
    });
  });

  describe('settledValueOrElse / settledFulfilledMap', () => {
    it('settledValueOrElse returns value when fulfilled', () => {
      expect(settledValueOrElse({ status: 'fulfilled', value: 42 }, 0)).to.equal(42);
    });
    it('settledValueOrElse returns fallback when rejected', () => {
      expect(settledValueOrElse({ status: 'rejected', reason: new Error('x') }, [])).to.deep.equal([]);
    });
    it('settledFulfilledMap applies mapFn when fulfilled', () => {
      expect(settledFulfilledMap({ status: 'fulfilled', value: { n: 2 } }, (v) => v.n * 3, null)).to.equal(6);
    });
    it('settledFulfilledMap returns fallback when rejected', () => {
      expect(settledFulfilledMap({ status: 'rejected', reason: new Error('x') }, () => 1, null)).to.equal(null);
    });
  });

  describe('exported constants', () => {
    it('LLM_UI maps known LLM enum values to UI strings', () => {
      expect(LLM_UI[LLM_ENUM.CHAT_GPT]).to.equal('chatgpt');
      expect(LLM_UI[LLM_ENUM.GEMINI]).to.equal('gemini');
      expect(LLM_UI[LLM_ENUM.GOOGLE_AI_MODE]).to.equal('googleAiMode');
      expect(LLM_UI[LLM_ENUM.GOOGLE_AI_OVERVIEW]).to.equal('googleAiOverview');
    });

    it('FTS_LLMS contains the four supported LLM values', () => {
      expect(FTS_LLMS).to.deep.equal([
        LLM_ENUM.CHAT_GPT,
        LLM_ENUM.GEMINI,
        LLM_ENUM.GOOGLE_AI_MODE,
        LLM_ENUM.GOOGLE_AI_OVERVIEW,
      ]);
    });

    it('EMPTY_ENGINE_BREAKDOWN returns a fresh zeroed object', () => {
      const a = EMPTY_ENGINE_BREAKDOWN();
      const b = EMPTY_ENGINE_BREAKDOWN();
      expect(a).to.deep.equal({
        all: 0, chatgpt: 0, gemini: 0, googleAiMode: 0, googleAiOverview: 0,
      });
      expect(a).to.not.equal(b);
    });

    it('numeric constants have correct values', () => {
      expect(GAP_SOURCE_DOMAINS_MAX_RANGE_LIMIT).to.equal(100);
      expect(PROMPTS_RESPONSES_PROMPTS_SCAN_LIMIT).to.equal(500);
      expect(MAX_COMPETITOR_DOMAINS).to.equal(5);
      expect(TOPIC_OPPORTUNITY_PROMPTS_MAX_PAGES).to.equal(15);
      expect(MAX_TOPIC_IDS_DIMENSION_FILTER).to.equal(50);
    });

    it('TOPIC_INTENT_SLUG maps all topic intent enums', () => {
      expect(TOPIC_INTENT_SLUG[TOPIC_INTENT_ENUM.TASK]).to.equal('task');
      expect(TOPIC_INTENT_SLUG[TOPIC_INTENT_ENUM.INFORMATIONAL]).to.equal('informational');
      expect(TOPIC_INTENT_SLUG[TOPIC_INTENT_ENUM.NAVIGATIONAL]).to.equal('navigational');
      expect(TOPIC_INTENT_SLUG[TOPIC_INTENT_ENUM.COMMERCIAL]).to.equal('commercial');
      expect(TOPIC_INTENT_SLUG[TOPIC_INTENT_ENUM.TRANSACTIONAL]).to.equal('transactional');
    });
  });

  describe('num', () => {
    it('returns 0 for null', () => expect(num(null)).to.equal(0));
    it('returns 0 for undefined', () => expect(num(undefined)).to.equal(0));
    it('returns truncated number', () => expect(num(3.7)).to.equal(3));
    it('handles normal integers', () => expect(num(42)).to.equal(42));
    it('converts bigint to number', () => expect(num(BigInt(123))).to.equal(123));
    it('parses numeric strings', () => expect(num('99')).to.equal(99));
    it('returns 0 for non-numeric strings', () => expect(num('abc')).to.equal(0));
    it('returns 0 for NaN', () => expect(num(NaN)).to.equal(0));
    it('returns 0 for Infinity', () => expect(num(Infinity)).to.equal(0));
    it('returns 0 for -Infinity', () => expect(num(-Infinity)).to.equal(0));
    it('truncates negative decimals', () => expect(num(-2.9)).to.equal(-2));
  });

  describe('resolveTopicIdsDimensionFilter', () => {
    it('returns empty dimensionFilterQl when no topicIds', () => {
      const r = resolveTopicIdsDimensionFilter(sp('domain=x.com'));
      expect(r.ok).to.be.true;
      expect(r.dimensionFilterQl).to.equal('');
    });

    it('builds single-hash filter', () => {
      const r = resolveTopicIdsDimensionFilter(sp('topicIds=42'));
      expect(r.ok).to.be.true;
      expect(r.dimensionFilterQl).to.equal('topic_hash = 42');
    });

    it('builds OR filter for multiple ids', () => {
      const r = resolveTopicIdsDimensionFilter(sp('topicIds=1&topicIds=2'));
      expect(r.ok).to.be.true;
      expect(r.dimensionFilterQl).to.equal('topic_hash = 1 OR topic_hash = 2');
    });

    it('rejects non-numeric topicIds', () => {
      const r = resolveTopicIdsDimensionFilter(sp('topicIds=1%20OR%201'));
      expect(r.ok).to.be.false;
      expect(r.body.error).to.equal('invalid_topic_ids');
    });

    it('rejects too many topicIds', () => {
      const params = new URLSearchParams();
      for (let i = 0; i <= MAX_TOPIC_IDS_DIMENSION_FILTER; i += 1) {
        params.append('topicIds', String(i));
      }
      const r = resolveTopicIdsDimensionFilter(params);
      expect(r.ok).to.be.false;
      expect(r.body.error).to.equal('topic_ids_limit_exceeded');
    });
  });

  describe('resolveTopicIds', () => {
    it('returns empty topicIds when no param', () => {
      const r = resolveTopicIds(sp('searchQuery=q'));
      expect(r.ok).to.be.true;
      expect(r.topicIds).to.deep.equal([]);
    });

    it('reads the singular topicId as a one-element bigint array', () => {
      const r = resolveTopicIds(sp('topicId=42'));
      expect(r.ok).to.be.true;
      expect(r.topicIds).to.deep.equal([42n]);
    });

    it('reads repeated topicIds (and merges a singular topicId)', () => {
      const r = resolveTopicIds(sp('topicIds=1&topicIds=2&topicId=3'));
      expect(r.ok).to.be.true;
      expect(r.topicIds).to.deep.equal([1n, 2n, 3n]);
    });

    it('rejects non-numeric topic ids', () => {
      const r = resolveTopicIds(sp('topicId=1%20OR%201'));
      expect(r.ok).to.be.false;
      expect(r.body.error).to.equal('invalid_topic_ids');
    });

    it('rejects too many topic ids', () => {
      const params = new URLSearchParams();
      for (let i = 0; i <= MAX_TOPIC_IDS_DIMENSION_FILTER; i += 1) {
        params.append('topicIds', String(i));
      }
      const r = resolveTopicIds(params);
      expect(r.ok).to.be.false;
      expect(r.body.error).to.equal('topic_ids_limit_exceeded');
    });
  });

  describe('brandTarget', () => {
    it('normalizes domain to lowercase trimmed', () => {
      expect(brandTarget(' Example.COM ')).to.deep.equal({ domain: 'example.com', name: 'example.com' });
    });
  });

  describe('parseLimitOffset', () => {
    it('defaults limit to 100 and offset to 0 when absent', () => {
      expect(parseLimitOffset(sp(''))).to.deep.equal({ limit: 100, offset: 0 });
    });

    it('parses valid limit and offset', () => {
      expect(parseLimitOffset(sp('limit=10&offset=5'))).to.deep.equal({ limit: 10, offset: 5 });
    });

    it('defaults limit to 100 for whitespace-only value', () => {
      expect(parseLimitOffset(sp('limit=%20'))).to.deep.equal({ limit: 100, offset: 0 });
    });

    it('defaults limit to 100 for non-numeric value', () => {
      expect(parseLimitOffset(sp('limit=abc'))).to.deep.equal({ limit: 100, offset: 0 });
    });

    it('defaults limit to 100 for negative value', () => {
      expect(parseLimitOffset(sp('limit=-5'))).to.deep.equal({ limit: 100, offset: 0 });
    });

    it('defaults limit to 100 for zero', () => {
      expect(parseLimitOffset(sp('limit=0'))).to.deep.equal({ limit: 100, offset: 0 });
    });

    it('clamps negative offset to 0', () => {
      expect(parseLimitOffset(sp('offset=-10'))).to.deep.equal({ limit: 100, offset: 0 });
    });

    it('defaults offset to 0 for non-numeric value', () => {
      expect(parseLimitOffset(sp('offset=abc'))).to.deep.equal({ limit: 100, offset: 0 });
    });

    it('defaults offset to 0 for whitespace-only value', () => {
      expect(parseLimitOffset(sp('offset=%20'))).to.deep.equal({ limit: 100, offset: 0 });
    });
  });

  describe('normalizeCountryForGrpc', () => {
    it('maps WW to WORLDWIDE', () => {
      expect(normalizeCountryForGrpc('WW')).to.equal(COUNTRY_ENUM.WORLDWIDE);
    });

    it('maps WORLDWIDE to WORLDWIDE', () => {
      expect(normalizeCountryForGrpc('WORLDWIDE')).to.equal(COUNTRY_ENUM.WORLDWIDE);
    });

    it('is case-insensitive', () => {
      expect(normalizeCountryForGrpc('ww')).to.equal(COUNTRY_ENUM.WORLDWIDE);
    });

    it('maps GB to UK enum value', () => {
      expect(normalizeCountryForGrpc('GB')).to.equal(COUNTRY_ENUM.UK);
    });

    it('maps valid country codes via COUNTRY_ENUM', () => {
      expect(normalizeCountryForGrpc('US')).to.equal(COUNTRY_ENUM.US);
      expect(normalizeCountryForGrpc('DE')).to.equal(COUNTRY_ENUM.DE);
    });

    it('defaults to US for unknown country', () => {
      expect(normalizeCountryForGrpc('ZZ')).to.equal(COUNTRY_ENUM.US);
    });
  });

  describe('resolveCountry', () => {
    it('uses country param when present', () => {
      expect(resolveCountry(sp('country=DE'))).to.equal(COUNTRY_ENUM.DE);
    });

    it('falls back to region WW as WORLDWIDE', () => {
      expect(resolveCountry(sp('region=WW'))).to.equal(COUNTRY_ENUM.WORLDWIDE);
    });

    it('falls back to region WORLDWIDE as WORLDWIDE', () => {
      expect(resolveCountry(sp('region=WORLDWIDE'))).to.equal(COUNTRY_ENUM.WORLDWIDE);
    });

    it('falls back to valid 2-letter region', () => {
      expect(resolveCountry(sp('region=FR'))).to.equal(COUNTRY_ENUM.FR);
    });

    it('defaults to US when no country or region', () => {
      expect(resolveCountry(sp(''))).to.equal(COUNTRY_ENUM.US);
    });

    it('defaults to US for invalid region format', () => {
      expect(resolveCountry(sp('region=INVALID'))).to.equal(COUNTRY_ENUM.US);
    });

    it('trims country param', () => {
      expect(resolveCountry(sp('country=%20US%20'))).to.equal(COUNTRY_ENUM.US);
    });
  });

  describe('resolveCountryForFts', () => {
    it('returns US when resolved country is WORLDWIDE', () => {
      expect(resolveCountryForFts(sp('country=WW'))).to.equal(COUNTRY_ENUM.US);
    });

    it('passes through non-WORLDWIDE country', () => {
      expect(resolveCountryForFts(sp('country=DE'))).to.equal(COUNTRY_ENUM.DE);
    });
  });

  describe('resolveCountryForCompetitorsMetrics', () => {
    it('returns US when resolved country is WORLDWIDE', () => {
      expect(resolveCountryForCompetitorsMetrics(sp('country=WW'))).to.equal(COUNTRY_ENUM.US);
    });

    it('passes through non-WORLDWIDE country', () => {
      expect(resolveCountryForCompetitorsMetrics(sp('country=FR'))).to.equal(COUNTRY_ENUM.FR);
    });
  });

  describe('resolveCountryForCitedSources', () => {
    it('returns US when resolved country is WORLDWIDE', () => {
      expect(resolveCountryForCitedSources(sp('country=WW'))).to.equal(COUNTRY_ENUM.US);
    });

    it('passes through non-WORLDWIDE country', () => {
      expect(resolveCountryForCitedSources(sp('country=IT'))).to.equal(COUNTRY_ENUM.IT);
    });
  });

  describe('restCountryFromGrpcRequestCountry', () => {
    it('returns undefined for null', () => {
      expect(restCountryFromGrpcRequestCountry(null)).to.be.undefined;
    });

    it('returns undefined for 0', () => {
      expect(restCountryFromGrpcRequestCountry(0)).to.be.undefined;
    });

    it('returns undefined for WORLDWIDE', () => {
      expect(restCountryFromGrpcRequestCountry(COUNTRY_ENUM.WORLDWIDE)).to.be.undefined;
    });

    it('returns GB for UK enum', () => {
      expect(restCountryFromGrpcRequestCountry(COUNTRY_ENUM.UK)).to.equal('GB');
    });

    it('returns country string for known enum value', () => {
      expect(restCountryFromGrpcRequestCountry(COUNTRY_ENUM.US)).to.equal('US');
      expect(restCountryFromGrpcRequestCountry(COUNTRY_ENUM.DE)).to.equal('DE');
    });

    it('returns undefined for unknown numeric value', () => {
      expect(restCountryFromGrpcRequestCountry(9999)).to.be.undefined;
    });
  });

  describe('restCountryFromPromptProto', () => {
    it('returns undefined for null', () => {
      expect(restCountryFromPromptProto(null)).to.be.undefined;
    });

    it('returns undefined for non-object', () => {
      expect(restCountryFromPromptProto(42)).to.be.undefined;
      expect(restCountryFromPromptProto('str')).to.be.undefined;
    });

    it('returns undefined when country is null', () => {
      expect(restCountryFromPromptProto({ country: null })).to.be.undefined;
    });

    it('returns undefined when country is 0', () => {
      expect(restCountryFromPromptProto({ country: 0 })).to.be.undefined;
    });

    it('returns undefined for WORLDWIDE numeric', () => {
      expect(restCountryFromPromptProto({ country: COUNTRY_ENUM.WORLDWIDE })).to.be.undefined;
    });

    it('returns GB for UK numeric', () => {
      expect(restCountryFromPromptProto({ country: COUNTRY_ENUM.UK })).to.equal('GB');
    });

    it('returns country string for known numeric value', () => {
      expect(restCountryFromPromptProto({ country: COUNTRY_ENUM.US })).to.equal('US');
    });

    it('returns undefined for unknown numeric value', () => {
      expect(restCountryFromPromptProto({ country: 9999 })).to.be.undefined;
    });

    it('returns undefined for empty string country', () => {
      expect(restCountryFromPromptProto({ country: '' })).to.be.undefined;
    });

    it('returns undefined for WORLDWIDE string', () => {
      expect(restCountryFromPromptProto({ country: 'WORLDWIDE' })).to.be.undefined;
    });

    it('returns undefined for WW string', () => {
      expect(restCountryFromPromptProto({ country: 'WW' })).to.be.undefined;
    });

    it('returns GB for UK string', () => {
      expect(restCountryFromPromptProto({ country: 'UK' })).to.equal('GB');
    });

    it('returns valid 2-letter string as-is (uppercased)', () => {
      expect(restCountryFromPromptProto({ country: 'us' })).to.equal('US');
    });

    it('returns undefined for invalid string country', () => {
      expect(restCountryFromPromptProto({ country: 'XYZ' })).to.be.undefined;
    });
  });

  describe('restMarketFromSourceDomainCountryField', () => {
    it('returns undefined for null input', () => {
      expect(restMarketFromSourceDomainCountryField(null)).to.be.undefined;
    });

    it('returns undefined when country is null', () => {
      expect(restMarketFromSourceDomainCountryField({ country: null })).to.be.undefined;
    });

    it('returns undefined when country is 0', () => {
      expect(restMarketFromSourceDomainCountryField({ country: 0 })).to.be.undefined;
    });

    it('returns WW for WORLDWIDE numeric', () => {
      expect(restMarketFromSourceDomainCountryField({ country: COUNTRY_ENUM.WORLDWIDE })).to.equal('WW');
    });

    it('returns GB for UK numeric', () => {
      expect(restMarketFromSourceDomainCountryField({ country: COUNTRY_ENUM.UK })).to.equal('GB');
    });

    it('returns country string for known numeric value', () => {
      expect(restMarketFromSourceDomainCountryField({ country: COUNTRY_ENUM.US })).to.equal('US');
    });

    it('returns undefined for unknown numeric value', () => {
      expect(restMarketFromSourceDomainCountryField({ country: 9999 })).to.be.undefined;
    });

    it('returns WW for WORLDWIDE string', () => {
      expect(restMarketFromSourceDomainCountryField({ country: 'WORLDWIDE' })).to.equal('WW');
    });

    it('returns uppercased string country', () => {
      expect(restMarketFromSourceDomainCountryField({ country: 'us' })).to.equal('US');
    });
  });

  describe('engineToLlm', () => {
    it('returns undefined for null', () => {
      expect(engineToLlm(null)).to.be.undefined;
    });

    it('returns undefined for empty string', () => {
      expect(engineToLlm('')).to.be.undefined;
    });

    it('maps chatgpt', () => {
      expect(engineToLlm('chatgpt')).to.equal(LLM_ENUM.CHAT_GPT);
    });

    it('maps gemini', () => {
      expect(engineToLlm('gemini')).to.equal(LLM_ENUM.GEMINI);
    });

    it('maps aimode', () => {
      expect(engineToLlm('aimode')).to.equal(LLM_ENUM.GOOGLE_AI_MODE);
    });

    it('maps overview', () => {
      expect(engineToLlm('overview')).to.equal(LLM_ENUM.GOOGLE_AI_OVERVIEW);
    });

    it('maps googleAiMode', () => {
      expect(engineToLlm('googleAiMode')).to.equal(LLM_ENUM.GOOGLE_AI_MODE);
    });

    it('maps google_ai_mode (legacy slug)', () => {
      expect(engineToLlm('google_ai_mode')).to.equal(LLM_ENUM.GOOGLE_AI_MODE);
    });

    it('maps googleAiOverview', () => {
      expect(engineToLlm('googleAiOverview')).to.equal(LLM_ENUM.GOOGLE_AI_OVERVIEW);
    });

    it('maps google_ai_overview (legacy slug)', () => {
      expect(engineToLlm('google_ai_overview')).to.equal(LLM_ENUM.GOOGLE_AI_OVERVIEW);
    });

    it('is case-insensitive', () => {
      expect(engineToLlm('CHATGPT')).to.equal(LLM_ENUM.CHAT_GPT);
    });

    it('returns undefined for unknown engine', () => {
      expect(engineToLlm('unknown')).to.be.undefined;
    });
  });

  describe('llmToEngine', () => {
    it('maps known LLM values', () => {
      expect(llmToEngine(LLM_ENUM.CHAT_GPT)).to.equal('chatgpt');
      expect(llmToEngine(LLM_ENUM.GEMINI)).to.equal('gemini');
      expect(llmToEngine(LLM_ENUM.GOOGLE_AI_MODE)).to.equal('googleAiMode');
      expect(llmToEngine(LLM_ENUM.GOOGLE_AI_OVERVIEW)).to.equal('googleAiOverview');
    });

    it('lowercases unknown LLM numeric value', () => {
      expect(llmToEngine(LLM_ENUM.ALL)).to.equal('999');
    });

    it('returns empty string for null', () => {
      expect(llmToEngine(null)).to.equal('');
    });

    it('returns empty string for undefined', () => {
      expect(llmToEngine(undefined)).to.equal('');
    });
  });

  describe('requiredLlmFromQuery', () => {
    it('returns LLM value when engine param is valid', () => {
      expect(requiredLlmFromQuery(sp('engine=chatgpt'))).to.equal(LLM_ENUM.CHAT_GPT);
    });

    it('returns LLM_ENUM.ALL when engine param is absent', () => {
      expect(requiredLlmFromQuery(sp(''))).to.equal(LLM_ENUM.ALL);
    });

    it('returns LLM_ENUM.ALL when engine is unknown', () => {
      expect(requiredLlmFromQuery(sp('engine=unknown'))).to.equal(LLM_ENUM.ALL);
    });
  });

  describe('optionalLlmFromQuery', () => {
    it('returns LLM value when engine param is valid', () => {
      expect(optionalLlmFromQuery(sp('engine=gemini'))).to.equal(LLM_ENUM.GEMINI);
    });

    it('returns null when engine param is absent', () => {
      expect(optionalLlmFromQuery(sp(''))).to.be.null;
    });

    it('returns null for whitespace-only engine', () => {
      expect(optionalLlmFromQuery(sp('engine=%20'))).to.be.null;
    });
  });

  describe('parseMonthYM', () => {
    it('parses valid YYYY-MM format', () => {
      expect(parseMonthYM(sp('month=2024-06'))).to.deep.equal({ year: 2024, month: 6 });
    });

    it('returns null when month param is missing', () => {
      expect(parseMonthYM(sp(''))).to.be.null;
    });

    it('returns null for empty month value', () => {
      expect(parseMonthYM(sp('month='))).to.be.null;
    });

    it('returns null for invalid format', () => {
      expect(parseMonthYM(sp('month=2024-1'))).to.be.null;
      expect(parseMonthYM(sp('month=abc'))).to.be.null;
    });

    it('returns null for whitespace-only month', () => {
      expect(parseMonthYM(sp('month=%20'))).to.be.null;
    });
  });

  describe('exactSnapshotDate', () => {
    it('returns the value for an exact YYYY-MM-DD date', () => {
      expect(exactSnapshotDate(sp('date=2026-07-01'))).to.equal('2026-07-01');
    });

    it('returns undefined for a month-only YYYY-MM date', () => {
      expect(exactSnapshotDate(sp('date=2026-07'))).to.be.undefined;
    });

    it('returns undefined when date param is missing', () => {
      expect(exactSnapshotDate(sp(''))).to.be.undefined;
    });

    it('returns undefined for empty or whitespace-only date', () => {
      expect(exactSnapshotDate(sp('date='))).to.be.undefined;
      expect(exactSnapshotDate(sp('date=%20'))).to.be.undefined;
    });

    it('returns undefined for malformed dates', () => {
      expect(exactSnapshotDate(sp('date=2026-7-1'))).to.be.undefined;
      expect(exactSnapshotDate(sp('date=abc'))).to.be.undefined;
    });
  });

  describe('statsByLLMDateRange', () => {
    it('returns single-month range', () => {
      expect(statsByLLMDateRange(2024, 6, 1)).to.deep.equal({
        from: { year: 2024, month: 6, day: 1 },
        till: { year: 2024, month: 6, day: 1 },
      });
    });

    it('returns multi-month range within same year', () => {
      expect(statsByLLMDateRange(2024, 6, 3)).to.deep.equal({
        from: { year: 2024, month: 4, day: 1 },
        till: { year: 2024, month: 6, day: 1 },
      });
    });

    it('wraps year when fromMonth goes negative', () => {
      expect(statsByLLMDateRange(2024, 2, 6)).to.deep.equal({
        from: { year: 2023, month: 9, day: 1 },
        till: { year: 2024, month: 2, day: 1 },
      });
    });

    it('wraps multiple years', () => {
      expect(statsByLLMDateRange(2024, 1, 25)).to.deep.equal({
        from: { year: 2022, month: 1, day: 1 },
        till: { year: 2024, month: 1, day: 1 },
      });
    });
  });

  describe('slugHostFromBrandName', () => {
    it('normalizes brand name to slug host', () => {
      expect(slugHostFromBrandName('Adobe Inc.')).to.equal('adobeinc.com');
    });

    it('returns brand.example for empty name', () => {
      expect(slugHostFromBrandName('')).to.equal('brand.example');
    });

    it('returns brand.example for null', () => {
      expect(slugHostFromBrandName(null)).to.equal('brand.example');
    });

    it('truncates long names to 48 chars', () => {
      const long = 'a'.repeat(100);
      expect(slugHostFromBrandName(long)).to.equal(`${'a'.repeat(48)}.com`);
    });
  });

  describe('normalizeTopBrandsByDomainNameKey', () => {
    it('lowercases and strips whitespace', () => {
      expect(normalizeTopBrandsByDomainNameKey('Adobe Inc ')).to.equal('adobeinc');
    });

    it('returns empty for empty string', () => {
      expect(normalizeTopBrandsByDomainNameKey('')).to.equal('');
    });

    it('returns empty for null', () => {
      expect(normalizeTopBrandsByDomainNameKey(null)).to.equal('');
    });
  });

  describe('topBrandsByDomainEntryName', () => {
    it('returns trimmed brandName', () => {
      expect(topBrandsByDomainEntryName({ brandName: ' Test ' })).to.equal('Test');
    });

    it('returns empty for null brandName', () => {
      expect(topBrandsByDomainEntryName({ brandName: null })).to.equal('');
    });

    it('returns empty for missing brandName', () => {
      expect(topBrandsByDomainEntryName({})).to.equal('');
    });
  });

  describe('topBrandsByDomainEntryCount', () => {
    it('returns count via num()', () => {
      expect(topBrandsByDomainEntryCount({ count: 42 })).to.equal(42);
    });

    it('returns 0 for null count', () => {
      expect(topBrandsByDomainEntryCount({ count: null })).to.equal(0);
    });
  });

  describe('mentionedBrandRestLabel', () => {
    it('returns trimmed string when input is a string', () => {
      expect(mentionedBrandRestLabel(' Adobe ')).to.equal('Adobe');
    });

    it('uses name field when present', () => {
      expect(mentionedBrandRestLabel({ name: 'BrandName' })).to.equal('BrandName');
    });

    it('falls back to domain when name is empty', () => {
      expect(mentionedBrandRestLabel({ name: '', domain: 'example.com' })).to.equal('example.com');
    });

    it('falls back to domain when name is null', () => {
      expect(mentionedBrandRestLabel({ name: null, domain: 'example.com' })).to.equal('example.com');
    });

    it('returns empty when both name and domain are missing', () => {
      expect(mentionedBrandRestLabel({})).to.equal('');
    });
  });

  describe('mentionedBrandsCountFromPromptProto', () => {
    it('returns list length when greater than count', () => {
      expect(mentionedBrandsCountFromPromptProto({
        mentionedBrandsCount: 2,
        mentionedBrands: ['a', 'b', 'c'],
      })).to.equal(3);
    });

    it('returns count when greater than list length', () => {
      expect(mentionedBrandsCountFromPromptProto({
        mentionedBrandsCount: 5,
        mentionedBrands: ['a', 'b'],
      })).to.equal(5);
    });

    it('returns count when list is empty', () => {
      expect(mentionedBrandsCountFromPromptProto({
        mentionedBrandsCount: 4,
        mentionedBrands: [],
      })).to.equal(4);
    });

    it('returns count when list is not an array', () => {
      expect(mentionedBrandsCountFromPromptProto({
        mentionedBrandsCount: 3,
      })).to.equal(3);
    });
  });

  describe('promptMatchesResponsesQuery', () => {
    it('returns true for empty query', () => {
      expect(promptMatchesResponsesQuery('anything', '')).to.be.true;
      expect(promptMatchesResponsesQuery('anything', null)).to.be.true;
    });

    it('returns false for empty prompt with non-empty query', () => {
      expect(promptMatchesResponsesQuery('', 'query')).to.be.false;
      expect(promptMatchesResponsesQuery(null, 'query')).to.be.false;
    });

    it('returns true for exact match', () => {
      expect(promptMatchesResponsesQuery('hello world', 'hello world')).to.be.true;
    });

    it('normalizes non-breaking spaces', () => {
      expect(promptMatchesResponsesQuery('hello\u00a0world', 'hello\u00a0world')).to.be.true;
    });

    it('returns false when shorter string is under 12 chars', () => {
      expect(promptMatchesResponsesQuery('short', 'a much longer query text here')).to.be.false;
    });

    it('returns true when prompt includes query (both long enough)', () => {
      expect(promptMatchesResponsesQuery(
        'this is a longer prompt text about something',
        'longer prompt text',
      )).to.be.true;
    });

    it('returns true when query includes prompt (both long enough)', () => {
      expect(promptMatchesResponsesQuery(
        'longer prompt text',
        'this is a longer prompt text about something',
      )).to.be.true;
    });

    it('returns false when neither includes the other', () => {
      expect(promptMatchesResponsesQuery(
        'completely different text here',
        'something entirely else now',
      )).to.be.false;
    });

    it('collapses multiple spaces', () => {
      expect(promptMatchesResponsesQuery('hello  world  test', 'hello world test')).to.be.true;
    });
  });

  describe('dateKey', () => {
    it('computes YYYYMMDD integer', () => {
      expect(dateKey({ year: 2024, month: 6, day: 15 })).to.equal(20240615);
    });

    it('returns 0 for null', () => {
      expect(dateKey(null)).to.equal(0);
    });

    it('returns 0 for undefined', () => {
      expect(dateKey(undefined)).to.equal(0);
    });
  });

  describe('sourcesListFromSourcesResponse', () => {
    it('returns empty array for null', () => {
      expect(sourcesListFromSourcesResponse(null)).to.deep.equal([]);
    });

    it('returns empty array for non-object', () => {
      expect(sourcesListFromSourcesResponse('str')).to.deep.equal([]);
    });

    it('returns source array', () => {
      const rows = [{ url: 'a' }];
      expect(sourcesListFromSourcesResponse({ source: rows })).to.deep.equal(rows);
    });

    it('returns sources array', () => {
      const rows = [{ url: 'b' }];
      expect(sourcesListFromSourcesResponse({ sources: rows })).to.deep.equal(rows);
    });

    it('returns empty array when value is not an array', () => {
      expect(sourcesListFromSourcesResponse({ source: 'not-array' })).to.deep.equal([]);
    });

    it('returns empty array for empty object', () => {
      expect(sourcesListFromSourcesResponse({})).to.deep.equal([]);
    });
  });

  describe('sourceDomainsListFromResponse', () => {
    it('returns empty array for null', () => {
      expect(sourceDomainsListFromResponse(null)).to.deep.equal([]);
    });

    it('returns domains array', () => {
      const rows = [{ d: 'a' }];
      expect(sourceDomainsListFromResponse({ domains: rows })).to.deep.equal(rows);
    });

    it('returns sourceDomains array', () => {
      const rows = [{ d: 'b' }];
      expect(sourceDomainsListFromResponse({ sourceDomains: rows })).to.deep.equal(rows);
    });

    it('returns empty array for empty object', () => {
      expect(sourceDomainsListFromResponse({})).to.deep.equal([]);
    });

    it('returns empty array when value is not an array', () => {
      expect(sourceDomainsListFromResponse({ domains: 'not-array' })).to.deep.equal([]);
    });
  });

  describe('sourceDomainsByTopicFtsRows', () => {
    it('returns sourceDomains from raw', () => {
      expect(sourceDomainsByTopicFtsRows({ sourceDomains: [1, 2] })).to.deep.equal([1, 2]);
    });

    it('returns empty array when sourceDomains is absent', () => {
      expect(sourceDomainsByTopicFtsRows({})).to.deep.equal([]);
    });
  });

  describe('sumVoTotalBySourceCategoryCounts', () => {
    it('returns null for null', () => {
      expect(sumVoTotalBySourceCategoryCounts(null)).to.be.null;
    });

    it('returns null for non-object', () => {
      expect(sumVoTotalBySourceCategoryCounts('str')).to.be.null;
    });

    it('returns null for empty totals', () => {
      expect(sumVoTotalBySourceCategoryCounts({ totals: [] })).to.be.null;
    });

    it('returns null when totals is not an array', () => {
      expect(sumVoTotalBySourceCategoryCounts({ totals: 'not-array' })).to.be.null;
    });

    it('sums count fields', () => {
      expect(sumVoTotalBySourceCategoryCounts({
        totals: [{ count: 5 }, { count: 3 }],
      })).to.equal(8);
    });

    it('returns null for missing totals key', () => {
      expect(sumVoTotalBySourceCategoryCounts({})).to.be.null;
    });
  });

  describe('voTotalCountForSourceCategory', () => {
    it('returns null for null raw', () => {
      expect(voTotalCountForSourceCategory(null, 'X')).to.be.null;
    });

    it('returns null for null categoryName', () => {
      expect(voTotalCountForSourceCategory({ totals: [] }, null)).to.be.null;
    });

    it('returns null for empty categoryName', () => {
      expect(voTotalCountForSourceCategory({ totals: [] }, '')).to.be.null;
    });

    it('returns null when totals is not an array', () => {
      expect(voTotalCountForSourceCategory({ totals: 'x' }, 'Y')).to.be.null;
    });

    it('matches by string category', () => {
      expect(voTotalCountForSourceCategory(
        { totals: [{ category: 'OWNED_BY_TARGET', count: 10 }] },
        'OWNED_BY_TARGET',
      )).to.equal(10);
    });

    it('maps numeric category to name', () => {
      expect(voTotalCountForSourceCategory(
        { totals: [{ category: 1, count: 7 }] },
        'OWNED_BY_TARGET',
      )).to.equal(7);
      expect(voTotalCountForSourceCategory(
        { totals: [{ category: 2, count: 3 }] },
        'MENTIONS_TARGET',
      )).to.equal(3);
      expect(voTotalCountForSourceCategory(
        { totals: [{ category: 3, count: 1 }] },
        'MISSES_TARGET',
      )).to.equal(1);
    });

    it('returns null for unmatched category', () => {
      expect(voTotalCountForSourceCategory(
        { totals: [{ category: 'OTHER', count: 5 }] },
        'OWNED_BY_TARGET',
      )).to.be.null;
    });

    it('returns null for null category in row', () => {
      expect(voTotalCountForSourceCategory(
        { totals: [{ category: null, count: 5 }] },
        'OWNED_BY_TARGET',
      )).to.be.null;
    });

    it('returns null for unknown numeric category', () => {
      expect(voTotalCountForSourceCategory(
        { totals: [{ category: 99, count: 5 }] },
        'OWNED_BY_TARGET',
      )).to.be.null;
    });

    it('returns null when totals key is missing but other args valid', () => {
      expect(voTotalCountForSourceCategory({}, 'OWNED_BY_TARGET')).to.be.null;
    });
  });

  describe('parseCompetitorDomainsList', () => {
    it('parses CSV competitors param', () => {
      expect(parseCompetitorDomainsList(sp('competitors=a.com,b.com')))
        .to.deep.equal(['a.com', 'b.com']);
    });

    it('parses repeated competitor params', () => {
      expect(parseCompetitorDomainsList(sp('competitor=a.com&competitor=b.com')))
        .to.deep.equal(['a.com', 'b.com']);
    });

    it('strips www. prefix', () => {
      expect(parseCompetitorDomainsList(sp('competitors=www.a.com')))
        .to.deep.equal(['a.com']);
    });

    it('strips www. from repeated params', () => {
      expect(parseCompetitorDomainsList(sp('competitor=www.b.com')))
        .to.deep.equal(['b.com']);
    });

    it('deduplicates domains', () => {
      expect(parseCompetitorDomainsList(sp('competitors=a.com,a.com')))
        .to.deep.equal(['a.com']);
    });

    it('limits to MAX_COMPETITOR_DOMAINS', () => {
      const parts = Array.from({ length: 10 }, (_, i) => `d${i}.com`).join(',');
      const result = parseCompetitorDomainsList(sp(`competitors=${parts}`));
      expect(result).to.have.lengthOf(MAX_COMPETITOR_DOMAINS);
    });

    it('returns empty for no params', () => {
      expect(parseCompetitorDomainsList(sp(''))).to.deep.equal([]);
    });

    it('lowercases domains', () => {
      expect(parseCompetitorDomainsList(sp('competitors=A.COM'))).to.deep.equal(['a.com']);
    });

    it('skips empty parts in CSV', () => {
      expect(parseCompetitorDomainsList(sp('competitors=a.com,,b.com')))
        .to.deep.equal(['a.com', 'b.com']);
    });

    it('combines CSV and repeated params', () => {
      expect(parseCompetitorDomainsList(sp('competitors=a.com&competitor=b.com')))
        .to.deep.equal(['a.com', 'b.com']);
    });
  });

  describe('parseGapKindEnumList', () => {
    it('defaults to [1] for all-prompts tab', () => {
      expect(parseGapKindEnumList(sp('tab=all-prompts'))).to.deep.equal([1]);
    });

    it('maps all tab to [1]', () => {
      expect(parseGapKindEnumList(sp('tab=all'))).to.deep.equal([1]);
    });

    it('maps missing tab to [2]', () => {
      expect(parseGapKindEnumList(sp('tab=missing'))).to.deep.equal([2]);
    });

    it('maps shared tab to [4]', () => {
      expect(parseGapKindEnumList(sp('tab=shared'))).to.deep.equal([4]);
    });

    it('maps unique tab to [6]', () => {
      expect(parseGapKindEnumList(sp('tab=unique'))).to.deep.equal([6]);
    });

    it('replaces underscores with dashes in tab value', () => {
      expect(parseGapKindEnumList(sp('tab=all_prompts'))).to.deep.equal([1]);
    });

    it('uses topic_tab param', () => {
      expect(parseGapKindEnumList(sp('topic_tab=missing'))).to.deep.equal([2]);
    });

    it('uses prompt_tab param', () => {
      expect(parseGapKindEnumList(sp('prompt_tab=shared'))).to.deep.equal([4]);
    });

    it('parses gap_kinds CSV for unknown tab', () => {
      expect(parseGapKindEnumList(sp('tab=custom&gap_kinds=MISSING,SHARED')))
        .to.deep.equal([2, 4]);
    });

    it('defaults to [1] for unknown tab without gap_kinds', () => {
      expect(parseGapKindEnumList(sp('tab=custom'))).to.deep.equal([1]);
    });

    it('defaults to [1] for invalid gap_kinds names', () => {
      expect(parseGapKindEnumList(sp('tab=custom&gap_kinds=INVALID'))).to.deep.equal([1]);
    });

    it('defaults to [1] when no tab or gap_kinds params', () => {
      expect(parseGapKindEnumList(sp(''))).to.deep.equal([1]);
    });
  });

  describe('coerceProtoCommonGapKind', () => {
    it('returns null for null', () => {
      expect(coerceProtoCommonGapKind(null)).to.be.null;
    });

    it('returns null for undefined', () => {
      expect(coerceProtoCommonGapKind(undefined)).to.be.null;
    });

    it('returns finite numbers as-is', () => {
      expect(coerceProtoCommonGapKind(3)).to.equal(3);
    });

    it('returns null for NaN', () => {
      expect(coerceProtoCommonGapKind(NaN)).to.be.null;
    });

    it('returns null for Infinity', () => {
      expect(coerceProtoCommonGapKind(Infinity)).to.be.null;
    });

    it('parses numeric string', () => {
      expect(coerceProtoCommonGapKind('5')).to.equal(5);
    });

    it('maps named string to number', () => {
      expect(coerceProtoCommonGapKind('ALL')).to.equal(1);
      expect(coerceProtoCommonGapKind('MISSING')).to.equal(2);
      expect(coerceProtoCommonGapKind('WEAK')).to.equal(3);
      expect(coerceProtoCommonGapKind('SHARED')).to.equal(4);
      expect(coerceProtoCommonGapKind('STRONG')).to.equal(5);
      expect(coerceProtoCommonGapKind('UNIQUE')).to.equal(6);
      expect(coerceProtoCommonGapKind('UNSPECIFIED')).to.equal(0);
    });

    it('strips GAP_KIND_ prefix', () => {
      expect(coerceProtoCommonGapKind('GAP_KIND_MISSING')).to.equal(2);
    });

    it('handles dotted proto enum format', () => {
      expect(coerceProtoCommonGapKind('some.GAP_KIND_STRONG')).to.equal(5);
    });

    it('is case-insensitive', () => {
      expect(coerceProtoCommonGapKind('missing')).to.equal(2);
    });

    it('returns null for unknown string', () => {
      expect(coerceProtoCommonGapKind('UNKNOWN_VALUE')).to.be.null;
    });

    it('handles dotted format without GAP_KIND_ prefix', () => {
      expect(coerceProtoCommonGapKind('pkg.ALL')).to.equal(1);
    });
  });

  describe('aggregateGapPromptsTotalFromTotals', () => {
    it('returns null for null raw', () => {
      expect(aggregateGapPromptsTotalFromTotals(null, [1])).to.be.null;
    });

    it('returns null for non-object raw', () => {
      expect(aggregateGapPromptsTotalFromTotals('str', [1])).to.be.null;
    });

    it('returns total when positive', () => {
      expect(aggregateGapPromptsTotalFromTotals({ total: 42 }, [1])).to.equal(42);
    });

    it('returns null for empty totals', () => {
      expect(aggregateGapPromptsTotalFromTotals({ total: 0, totals: [] }, [1])).to.be.null;
    });

    it('returns null when kinds filter produces empty set', () => {
      expect(aggregateGapPromptsTotalFromTotals(
        { total: 0, totals: [{ kind: 1, count: 5 }] },
        [NaN, -1, Infinity],
      )).to.be.null;
    });

    it('sums matching kind totals', () => {
      expect(aggregateGapPromptsTotalFromTotals(
        { total: 0, totals: [{ kind: 1, count: 5 }, { kind: 2, count: 3 }] },
        [1, 2],
      )).to.equal(8);
    });

    it('uses gapKind field as fallback', () => {
      expect(aggregateGapPromptsTotalFromTotals(
        { total: 0, totals: [{ gapKind: 1, count: 10 }] },
        [1],
      )).to.equal(10);
    });

    it('returns null when no kinds match', () => {
      expect(aggregateGapPromptsTotalFromTotals(
        { total: 0, totals: [{ kind: 3, count: 5 }] },
        [1],
      )).to.be.null;
    });

    it('ignores rows with null kind', () => {
      expect(aggregateGapPromptsTotalFromTotals(
        { total: 0, totals: [{ kind: null, count: 5 }, { kind: 1, count: 2 }] },
        [1],
      )).to.equal(2);
    });

    it('returns null when totals key is missing', () => {
      expect(aggregateGapPromptsTotalFromTotals({ total: 0 }, [1])).to.be.null;
    });
  });

  describe('mergeTopBrandsByDomainResponsesByMax', () => {
    it('returns empty brands for empty input', () => {
      expect(mergeTopBrandsByDomainResponsesByMax([])).to.deep.equal({ brands: [] });
    });

    it('passes through single response brands', () => {
      const result = mergeTopBrandsByDomainResponsesByMax([
        { brands: [{ brandName: 'Adobe', count: 10 }] },
      ]);
      expect(result.brands).to.deep.equal([{ brandName: 'Adobe', count: 10 }]);
    });

    it('merges by max count across responses', () => {
      const result = mergeTopBrandsByDomainResponsesByMax([
        { brands: [{ brandName: 'Adobe', count: 5 }] },
        { brands: [{ brandName: 'Adobe', count: 10 }] },
      ]);
      expect(result.brands).to.deep.equal([{ brandName: 'Adobe', count: 10 }]);
    });

    it('prefers longer name at equal count', () => {
      const result = mergeTopBrandsByDomainResponsesByMax([
        { brands: [{ brandName: 'ab', count: 5 }] },
        { brands: [{ brandName: 'a b', count: 5 }] },
      ]);
      expect(result.brands[0].brandName).to.equal('a b');
      expect(result.brands[0].count).to.equal(5);
    });

    it('skips entries with empty brandName', () => {
      const result = mergeTopBrandsByDomainResponsesByMax([
        { brands: [{ brandName: '', count: 10 }, { brandName: 'Valid', count: 3 }] },
      ]);
      expect(result.brands).to.deep.equal([{ brandName: 'Valid', count: 3 }]);
    });

    it('normalizes keys for dedup (case-insensitive, no spaces)', () => {
      const result = mergeTopBrandsByDomainResponsesByMax([
        { brands: [{ brandName: 'Adobe Inc', count: 5 }] },
        { brands: [{ brandName: 'adobe inc', count: 3 }] },
      ]);
      expect(result.brands).to.have.lengthOf(1);
      expect(result.brands[0].count).to.equal(5);
    });

    it('handles responses without brands key', () => {
      const result = mergeTopBrandsByDomainResponsesByMax([{}, { brands: [{ brandName: 'A', count: 1 }] }]);
      expect(result.brands).to.deep.equal([{ brandName: 'A', count: 1 }]);
    });

    it('updates brandName to longer one when count is not higher', () => {
      const result = mergeTopBrandsByDomainResponsesByMax([
        { brands: [{ brandName: 'ab', count: 10 }] },
        { brands: [{ brandName: 'a b', count: 3 }] },
      ]);
      expect(result.brands[0].brandName).to.equal('a b');
      expect(result.brands[0].count).to.equal(10);
    });

    it('keeps existing name when new name is not longer and count not higher', () => {
      const result = mergeTopBrandsByDomainResponsesByMax([
        { brands: [{ brandName: 'a b', count: 10 }] },
        { brands: [{ brandName: 'ab', count: 3 }] },
      ]);
      expect(result.brands[0].brandName).to.equal('a b');
      expect(result.brands[0].count).to.equal(10);
    });
  });
});
