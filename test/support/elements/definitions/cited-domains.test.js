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
 * Contract tests for the Cited Domains element definition (LLMO-6020 POC).
 *
 * transformCitedDomainsResponse is load-bearing data massaging: it maps raw Semrush
 * Elements rows to the URL Inspector `cited-domains` contract, coerces numbers
 * NaN-safely, applies the content-type filter that drives the UI's owned-vs-third-
 * party split, sorts by citations, and paginates client-side. It shipped under a
 * `c8 ignore` ("unit tests intentionally deferred"); this closes that hole and
 * follows the owned-urls-traffic pattern. See TEST-COVERAGE-FINDINGS.md §5 Tier 1.
 */

import { expect } from 'chai';
import {
  buildCitedDomainsPayload,
  transformCitedDomainsResponse,
} from '../../../../src/support/elements/definitions/cited-domains.js';

// A raw Elements "table" response row (blocks.data), snake_case as Semrush returns it.
const rawRow = (overrides = {}) => ({
  domain: 'example.com',
  mentions_end: 42,
  urls_count: 7,
  prompts_with_citations: 3,
  domain_type: 'Other',
  ...overrides,
});

const rawResponse = (rows) => ({ blocks: { data: rows } });

describe('cited-domains definition', () => {
  describe('buildCitedDomainsPayload', () => {
    it('translates a UI platform code to the Semrush model inside the advanced or-block', () => {
      const payload = buildCitedDomainsPayload({ platform: 'openai', startDate: '2026-03-01', endDate: '2026-03-31' });
      const modelFilter = payload.filters.advanced.filters.find((f) => f.op === 'or');
      expect(modelFilter.filters[0]).to.deep.equal({ op: 'eq', val: 'gpt-5', col: 'CBF_model' });
    });

    it('prefers model over platform and falls back to the default model for unknown values', () => {
      const payload = buildCitedDomainsPayload({ model: 'not-a-real-model', platform: 'openai' });
      const modelFilter = payload.filters.advanced.filters.find((f) => f.op === 'or');
      // model takes precedence, unknown → DEFAULT_ELEMENT_MODEL ('search-gpt')
      expect(modelFilter.filters[0].val).to.equal('search-gpt');
    });

    it('duplicates the date range across the simple and advanced blocks', () => {
      const payload = buildCitedDomainsPayload({ startDate: '2026-03-01', endDate: '2026-03-31' });
      expect(payload.filters.simple).to.deep.equal({ CBF_date__start: '2026-03-01', CBF_date__end: '2026-03-31' });
      const adv = payload.filters.advanced.filters;
      expect(adv).to.deep.include({ op: 'gte', val: '2026-03-01', col: 'CBF_date__start' });
      expect(adv).to.deep.include({ op: 'lte', val: '2026-03-31', col: 'CBF_date__end' });
    });

    it('defaults to a rolling 28-day window when dates are omitted', () => {
      const payload = buildCitedDomainsPayload({});
      const { CBF_date__start: start, CBF_date__end: end } = payload.filters.simple;
      const days = (new Date(end) - new Date(start)) / (1000 * 60 * 60 * 24);
      expect(days).to.equal(28);
    });

    it('adds a namespaced category tag filter only when a category is provided', () => {
      const withCat = buildCitedDomainsPayload({ category: 'Firefly' });
      expect(withCat.filters.advanced.filters).to.deep.include({ op: 'eq', val: 'category:Firefly', col: 'CBF_tags' });

      const withoutCat = buildCitedDomainsPayload({});
      expect(withoutCat.filters.advanced.filters.some((f) => f.col === 'CBF_tags')).to.equal(false);
    });

    it('includes project_id for region scoping only when provided', () => {
      expect(buildCitedDomainsPayload({ projectId: 'proj-1' }).project_id).to.equal('proj-1');
      expect(buildCitedDomainsPayload({})).to.not.have.property('project_id');
    });
  });

  describe('transformCitedDomainsResponse', () => {
    it('maps raw rows to the URL Inspector cited-domains contract', () => {
      const result = transformCitedDomainsResponse(rawResponse([rawRow()]));
      expect(result.totalCount).to.equal(1);
      expect(result.domains[0]).to.deep.equal({
        domain: 'example.com',
        totalCitations: 42,
        totalUrls: 7,
        promptsCited: 3,
        contentType: 'Other',
        categories: '',
        regions: '',
      });
    });

    it('coerces non-numeric metrics to 0 and defaults a missing content type to ""', () => {
      const result = transformCitedDomainsResponse(rawResponse([
        rawRow({
          mentions_end: 'nope', urls_count: undefined, prompts_with_citations: null, domain_type: undefined,
        }),
      ]));
      expect(result.domains[0]).to.include({
        totalCitations: 0, totalUrls: 0, promptsCited: 0, contentType: '',
      });
    });

    it('keeps an empty-string domain but skips null/absent domains', () => {
      const result = transformCitedDomainsResponse(rawResponse([
        rawRow({ domain: 'keep.com' }),
        rawRow({ domain: '' }), // '' passes the `!= null` filter and maps to domain ''
        rawRow({ domain: null }), // skipped
        { mentions_end: 5 }, // absent domain → skipped
      ]));
      expect(result.totalCount).to.equal(2);
      expect(result.domains.map((d) => d.domain)).to.have.members(['keep.com', '']);
    });

    it('sorts domains by totalCitations descending', () => {
      const result = transformCitedDomainsResponse(rawResponse([
        rawRow({ domain: 'a.com', mentions_end: 10 }),
        rawRow({ domain: 'b.com', mentions_end: 90 }),
        rawRow({ domain: 'c.com', mentions_end: 50 }),
      ]));
      expect(result.domains.map((d) => d.domain)).to.deep.equal(['b.com', 'c.com', 'a.com']);
    });

    it('filters by content type case-insensitively (the owned vs third-party split)', () => {
      const result = transformCitedDomainsResponse(
        rawResponse([
          rawRow({ domain: 'owned.com', domain_type: 'Owned' }),
          rawRow({ domain: 'other.com', domain_type: 'Other' }),
        ]),
        { channel: 'owned' },
      );
      expect(result.totalCount).to.equal(1);
      expect(result.domains[0].domain).to.equal('owned.com');
    });

    it('paginates client-side with totalCount reflecting the post-filter, pre-slice count', () => {
      const rows = Array.from({ length: 5 }, (_, i) => rawRow({ domain: `d${i}.com`, mentions_end: 100 - i }));
      const result = transformCitedDomainsResponse(rawResponse(rows), { page: 1, pageSize: 2 });
      expect(result.totalCount).to.equal(5);
      // page 1 (0-based), size 2 → the 3rd and 4th by citation-desc
      expect(result.domains.map((d) => d.domain)).to.deep.equal(['d2.com', 'd3.com']);
    });

    it('returns an empty result for a missing/empty blocks payload', () => {
      const empty = { domains: [], totalCount: 0 };
      expect(transformCitedDomainsResponse(undefined)).to.deep.equal(empty);
      expect(transformCitedDomainsResponse({})).to.deep.equal(empty);
    });
  });
});
