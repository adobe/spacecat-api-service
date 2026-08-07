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
  buildCitedDomainsPayload,
  transformCitedDomainsResponse,
  transformCitedDomainsResponses,
} from '../../../../src/support/elements/definitions/cited-domains.js';
import { DEFAULT_ELEMENT_MODEL } from '../../../../src/support/elements/constants.js';

const domainRow = (overrides = {}) => ({
  domain: 'example.com',
  mentions_end: 5,
  urls_count: 2,
  prompts_with_citations: 3,
  domain_type: 'Other',
  ...overrides,
});

const rawWith = (...rows) => ({ blocks: { data: rows } });

describe('cited-domains definitions', () => {
  describe('buildCitedDomainsPayload', () => {
    it('uses the default model when no params are provided', () => {
      const payload = buildCitedDomainsPayload();
      const modelFilter = payload.filters.advanced.filters[0];
      expect(modelFilter).to.deep.equal({
        op: 'or', filters: [{ op: 'eq', val: DEFAULT_ELEMENT_MODEL, col: 'CBF_model' }],
      });
    });

    it('defaults the date range to a rolling 28 days when omitted', () => {
      const payload = buildCitedDomainsPayload();
      const start = payload.filters.simple.CBF_date__start;
      const end = payload.filters.simple.CBF_date__end;
      const spanDays = (Date.parse(end) - Date.parse(start)) / 86400000;
      expect(spanDays).to.equal(28);
    });

    it('sends the date range in BOTH simple and advanced blocks', () => {
      const payload = buildCitedDomainsPayload({ startDate: '2026-06-01', endDate: '2026-06-30' });
      expect(payload.filters.simple).to.deep.equal({
        CBF_date__start: '2026-06-01', CBF_date__end: '2026-06-30',
      });
      expect(payload.filters.advanced.filters).to.deep.include({
        op: 'gte', val: '2026-06-01', col: 'CBF_date__start',
      });
      expect(payload.filters.advanced.filters).to.deep.include({
        op: 'lte', val: '2026-06-30', col: 'CBF_date__end',
      });
    });

    it('includes a top-level project_id when projectId is provided', () => {
      const payload = buildCitedDomainsPayload({ projectId: 'proj-42' });
      expect(payload.project_id).to.equal('proj-42');
    });

    it('omits project_id when projectId is not provided', () => {
      const payload = buildCitedDomainsPayload();
      expect(payload).to.not.have.property('project_id');
    });

    it('pushes the category tag onto CBF_tags as-is when provided', () => {
      const payload = buildCitedDomainsPayload({ category: 'category__travel' });
      expect(payload.filters.advanced.filters).to.deep.include({
        op: 'eq', val: 'category__travel', col: 'CBF_tags',
      });
    });

    it('sets comparison_data_formatting to union', () => {
      expect(buildCitedDomainsPayload().comparison_data_formatting).to.equal('union');
    });
  });

  describe('transformCitedDomainsResponse (single project)', () => {
    it('returns an empty domains array and totalCount 0 for a missing/empty response', () => {
      expect(transformCitedDomainsResponse()).to.deep.equal({ domains: [], totalCount: 0 });
      expect(transformCitedDomainsResponse({})).to.deep.equal({ domains: [], totalCount: 0 });
    });

    it('maps element field names to the legacy contract', () => {
      const raw = rawWith(domainRow());
      const { domains } = transformCitedDomainsResponse(raw);
      expect(domains).to.deep.equal([{
        domain: 'example.com',
        totalCitations: 5,
        totalUrls: 2,
        promptsCited: 3,
        contentType: 'Other',
        categories: '',
        regions: '',
      }]);
    });

    it('coerces non-numeric citation/url/prompt fields to 0 instead of NaN', () => {
      const raw = rawWith(domainRow({
        mentions_end: 'n/a', urls_count: undefined, prompts_with_citations: null,
      }));
      const { domains } = transformCitedDomainsResponse(raw);
      expect(domains[0]).to.include({ totalCitations: 0, totalUrls: 0, promptsCited: 0 });
    });

    it('skips rows with a null/undefined domain', () => {
      const raw = rawWith(domainRow({ domain: null }), domainRow({ domain: 'b.com' }));
      const { domains, totalCount } = transformCitedDomainsResponse(raw);
      expect(totalCount).to.equal(1);
      expect(domains[0].domain).to.equal('b.com');
    });

    it('sorts by totalCitations descending', () => {
      const raw = rawWith(
        domainRow({ domain: 'low.com', mentions_end: 1 }),
        domainRow({ domain: 'high.com', mentions_end: 9 }),
      );
      const { domains } = transformCitedDomainsResponse(raw);
      expect(domains.map((d) => d.domain)).to.deep.equal(['high.com', 'low.com']);
    });

    it('applies the channel (content-type) filter client-side, case-insensitively', () => {
      const raw = rawWith(
        domainRow({ domain: 'owned.com', domain_type: 'Owned' }),
        domainRow({ domain: 'other.com', domain_type: 'Other' }),
      );
      const { domains, totalCount } = transformCitedDomainsResponse(raw, { channel: 'owned' });
      expect(totalCount).to.equal(1);
      expect(domains[0].domain).to.equal('owned.com');
    });

    it('paginates client-side using page/pageSize (0-based, default size 50)', () => {
      const rows = Array.from({ length: 3 }, (_, i) => domainRow({ domain: `d${i}.com`, mentions_end: 3 - i }));
      const raw = rawWith(...rows);
      const { domains, totalCount } = transformCitedDomainsResponse(raw, { page: 1, pageSize: 1 });
      expect(totalCount).to.equal(3);
      expect(domains).to.have.length(1);
      expect(domains[0].domain).to.equal('d1.com');
    });
  });

  describe('transformCitedDomainsResponses (multi-project fan-out merge)', () => {
    it('returns an empty domains array and totalCount 0 for an empty list', () => {
      expect(transformCitedDomainsResponses([])).to.deep.equal({ domains: [], totalCount: 0 });
    });

    it('keeps a domain cited under only one of several projects as a single row', () => {
      const rawList = [
        rawWith(domainRow({ domain: 'only-in-us.com' })),
        rawWith(),
      ];
      const { domains, totalCount } = transformCitedDomainsResponses(rawList);
      expect(totalCount).to.equal(1);
      expect(domains[0].domain).to.equal('only-in-us.com');
    });

    it('sums numeric fields for a domain cited under more than one project', () => {
      const rawList = [
        rawWith(domainRow({
          domain: 'shared.com', mentions_end: 5, urls_count: 2, prompts_with_citations: 3,
        })),
        rawWith(domainRow({
          domain: 'shared.com', mentions_end: 4, urls_count: 1, prompts_with_citations: 2,
        })),
      ];
      const { domains, totalCount } = transformCitedDomainsResponses(rawList);
      expect(totalCount).to.equal(1);
      expect(domains[0]).to.include({ totalCitations: 9, totalUrls: 3, promptsCited: 5 });
    });

    it('does not double-count a domain across 3+ projects (sums all of them, not just 2)', () => {
      const rawList = [
        rawWith(domainRow({ domain: 'shared.com', mentions_end: 1 })),
        rawWith(domainRow({ domain: 'shared.com', mentions_end: 2 })),
        rawWith(domainRow({ domain: 'shared.com', mentions_end: 3 })),
      ];
      const { domains } = transformCitedDomainsResponses(rawList);
      expect(domains[0].totalCitations).to.equal(6);
    });

    it('backfills contentType from a later project when the first project left it empty', () => {
      const rawList = [
        rawWith(domainRow({ domain: 'shared.com', domain_type: '' })),
        rawWith(domainRow({ domain: 'shared.com', domain_type: 'Owned' })),
      ];
      const { domains } = transformCitedDomainsResponses(rawList);
      expect(domains[0].contentType).to.equal('Owned');
    });

    it('sorts and paginates the MERGED set once, not per-project', () => {
      const rawList = [
        rawWith(domainRow({ domain: 'a.com', mentions_end: 1 })),
        rawWith(domainRow({ domain: 'b.com', mentions_end: 9 })),
      ];
      const { domains, totalCount } = transformCitedDomainsResponses(
        rawList,
        { page: 0, pageSize: 1 },
      );
      expect(totalCount).to.equal(2);
      expect(domains).to.have.length(1);
      expect(domains[0].domain).to.equal('b.com');
    });

    it('applies the channel filter after merging, across all projects', () => {
      const rawList = [
        rawWith(domainRow({ domain: 'owned.com', domain_type: 'Owned' })),
        rawWith(domainRow({ domain: 'other.com', domain_type: 'Other' })),
      ];
      const { domains, totalCount } = transformCitedDomainsResponses(rawList, { channel: 'other' });
      expect(totalCount).to.equal(1);
      expect(domains[0].domain).to.equal('other.com');
    });
  });
});
