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
  buildDomainUrlsPayload,
  transformDomainUrlsResponse,
} from '../../../../src/support/elements/definitions/domain-urls.js';
import { DEFAULT_ELEMENT_MODEL } from '../../../../src/support/elements/constants.js';

function modelFilter(payload) {
  return payload.filters.advanced.filters.find((filter) => filter.filters?.[0]?.col === 'CBF_model');
}

function dateFilters(payload) {
  return payload.filters.advanced.filters.filter(
    (filter) => filter.col === 'CBF_date__start' || filter.col === 'CBF_date__end',
  );
}

describe('domain-urls definitions', () => {
  describe('buildDomainUrlsPayload', () => {
    it('defaults the model to DEFAULT_ELEMENT_MODEL when no platform is provided', () => {
      const payload = buildDomainUrlsPayload();

      expect(modelFilter(payload)).to.deep.equal({
        op: 'or', filters: [{ op: 'eq', val: DEFAULT_ELEMENT_MODEL, col: 'CBF_model' }],
      });
    });

    it('omits the CBF_model filter for platform=all while keeping the date filters', () => {
      const payload = buildDomainUrlsPayload({
        platform: 'all', startDate: '2026-01-01', endDate: '2026-01-31',
      });

      expect(modelFilter(payload)).to.be.undefined;
      expect(dateFilters(payload)).to.deep.equal([
        { op: 'gte', val: '2026-01-01', col: 'CBF_date__start' },
        { op: 'lte', val: '2026-01-31', col: 'CBF_date__end' },
      ]);
    });

    it('keeps the existing platform translation for non-all values', () => {
      const payload = buildDomainUrlsPayload({ platform: 'openai' });

      expect(modelFilter(payload).filters[0].val).to.equal('chatgpt-paid');
    });

    it('uses model over platform when both are provided', () => {
      const payload = buildDomainUrlsPayload({ model: 'all', platform: 'openai' });

      expect(modelFilter(payload)).to.be.undefined;
    });

    it('adds the category tag filter and the top-level project_id when provided', () => {
      const payload = buildDomainUrlsPayload({
        startDate: '2026-01-01',
        endDate: '2026-01-31',
        category: 'category__foo',
        projectId: 'proj-1',
      });

      expect(payload.project_id).to.equal('proj-1');
      expect(payload.filters.advanced.filters).to.deep.include(
        { op: 'eq', val: 'category__foo', col: 'CBF_tags' },
      );
    });
  });

  describe('transformDomainUrlsResponse', () => {
    it('returns all hostnames sorted by citations when hostname is omitted', () => {
      const result = transformDomainUrlsResponse([
        {
          region: 'US',
          stats: {
            blocks: {
              data: [
                {
                  source: 'https://low.example.com/a', citations: 2, prompts_with_citation: 1, domain_type: 'Other',
                },
                {
                  source: 'https://reddit.com/b', citations: 9, prompts_with_citation: 4, domain_type: 'Other',
                },
                {
                  source: 'https://adobe.com/c', citations: 5, prompts_with_citation: 3, domain_type: 'Owned',
                },
              ],
            },
          },
        },
      ], { pageSize: 2 });

      expect(result.totalCount).to.equal(3);
      expect(result.urls.map((url) => url.url)).to.deep.equal([
        'https://reddit.com/b',
        'https://adobe.com/c',
      ]);
    });

    it('filters by a single hostname while preserving subdomain matching', () => {
      const result = transformDomainUrlsResponse([
        {
          region: 'US',
          stats: {
            blocks: {
              data: [
                {
                  source: 'https://www.reddit.com/a',
                  citations: 12,
                  prompts_with_citation: 6,
                  domain_type: 'Other',
                },
                {
                  source: 'https://help.adobe.com/b',
                  citations: 10,
                  prompts_with_citation: 4,
                  domain_type: 'Owned',
                },
                {
                  source: 'https://example.com/c',
                  citations: 99,
                  prompts_with_citation: 8,
                  domain_type: 'Other',
                },
              ],
            },
          },
        },
      ], { hostname: 'adobe.com' });

      expect(result.totalCount).to.equal(1);
      expect(result.urls.map((url) => url.url)).to.deep.equal([
        'https://help.adobe.com/b',
      ]);
    });

    it('treats a whitespace-only hostname as no filter', () => {
      const result = transformDomainUrlsResponse([
        {
          region: 'US',
          stats: {
            blocks: {
              data: [
                {
                  source: 'https://reddit.com/a', citations: 9, prompts_with_citation: 4, domain_type: 'Other',
                },
                {
                  source: 'https://adobe.com/b', citations: 5, prompts_with_citation: 3, domain_type: 'Owned',
                },
              ],
            },
          },
        },
      ], { hostname: '   ' });

      expect(result.totalCount).to.equal(2);
      expect(result.urls.map((url) => url.url)).to.deep.equal([
        'https://reddit.com/a',
        'https://adobe.com/b',
      ]);
    });

    it('applies the channel filter on top of the hostname-omitted (all hosts) mode', () => {
      const result = transformDomainUrlsResponse([
        {
          region: 'US',
          stats: {
            blocks: {
              data: [
                {
                  source: 'https://reddit.com/a', citations: 9, prompts_with_citation: 4, domain_type: 'Other',
                },
                {
                  source: 'https://adobe.com/b', citations: 5, prompts_with_citation: 3, domain_type: 'Owned',
                },
              ],
            },
          },
        },
      ], { channel: 'Owned' });

      expect(result.totalCount).to.equal(1);
      expect(result.urls.map((url) => url.url)).to.deep.equal([
        'https://adobe.com/b',
      ]);
    });

    it('skips statless projects, null rows, sourceless rows, and unparseable sources', () => {
      const result = transformDomainUrlsResponse([
        { region: 'DE', stats: undefined },
        {
          stats: {
            blocks: {
              data: [
                null,
                { citations: 3, prompts_with_citation: 1, domain_type: 'Other' },
                {
                  source: 'not a url', citations: 3, prompts_with_citation: 1, domain_type: 'Other',
                },
                { source: 'https://adobe.com/a', citations: 5 },
              ],
            },
          },
        },
      ], {});

      expect(result.totalCount).to.equal(1);
      // Missing domain_type / prompts_with_citation default to '' / 0; no region
      // on the project → the row's regions string stays empty.
      expect(result.urls[0]).to.include({
        url: 'https://adobe.com/a', contentType: '', promptsCited: 0, regions: '',
      });
    });

    it('merges the same URL across projects, summing counts and joining regions', () => {
      const row = {
        source: 'https://adobe.com/a', citations: 5, prompts_with_citation: 3, domain_type: 'Owned',
      };
      const result = transformDomainUrlsResponse([
        { region: 'US', stats: { blocks: { data: [row] } } },
        { region: 'DE', stats: { blocks: { data: [{ ...row, citations: 'oops' }] } } },
      ], { page: 0, pageSize: 10 });

      expect(result.totalCount).to.equal(1);
      expect(result.urls[0]).to.include({
        url: 'https://adobe.com/a', citations: 5, promptsCited: 6, regions: 'DE,US',
      });
    });
  });

  describe('transformDomainUrlsResponse site scoping', () => {
    const project = (rows) => [{ region: 'US', stats: { blocks: { data: rows } } }];
    const row = (source, citations = 1) => ({
      source, citations, prompts_with_citation: 1, domain_type: 'Other',
    });
    const urlsOf = (result) => result.urls.map((u) => u.url);

    const intuitRows = project([
      row('https://quickbooks.intuit.com/pricing', 9),
      row('https://help.quickbooks.intuit.com/faq', 8),
      row('https://turbotax.intuit.com/deals', 7),
      row('https://www.intuit.com/company', 6),
    ]);
    const nbaRows = project([
      row('https://www.nba.com/kings', 9),
      row('https://nba.com/kings/roster', 8),
      row('https://nba.com/kingsx', 7),
      row('https://nba.com/celtics', 6),
      row('https://cdn.espn.com/kings', 5),
    ]);

    it('returns only the site subtree when the site host is requested (subdomain site)', () => {
      const result = transformDomainUrlsResponse(intuitRows, {
        hostname: 'quickbooks.intuit.com',
        siteBaseUrl: 'https://quickbooks.intuit.com',
      });

      expect(urlsOf(result)).to.deep.equal([
        'https://quickbooks.intuit.com/pricing',
        'https://help.quickbooks.intuit.com/faq',
      ]);
    });

    it('excludes the site subtree from the parent-domain fold (subdomain site)', () => {
      const result = transformDomainUrlsResponse(intuitRows, {
        hostname: 'intuit.com',
        siteBaseUrl: 'https://quickbooks.intuit.com',
      });

      expect(urlsOf(result)).to.deep.equal([
        'https://turbotax.intuit.com/deals',
        'https://www.intuit.com/company',
      ]);
    });

    it('returns only the path subtree when the site scope is requested (subpath site)', () => {
      const result = transformDomainUrlsResponse(nbaRows, {
        hostname: 'nba.com/kings',
        siteBaseUrl: 'https://www.nba.com/kings',
      });

      expect(urlsOf(result)).to.deep.equal([
        'https://www.nba.com/kings',
        'https://nba.com/kings/roster',
      ]);
    });

    it('excludes the path subtree from the host fold (subpath site)', () => {
      const result = transformDomainUrlsResponse(nbaRows, {
        hostname: 'nba.com',
        siteBaseUrl: 'https://www.nba.com/kings',
      });

      expect(urlsOf(result)).to.deep.equal([
        'https://nba.com/kingsx',
        'https://nba.com/celtics',
      ]);
    });

    it('keeps the plain fold for third-party domains regardless of the site scope', () => {
      const result = transformDomainUrlsResponse(nbaRows, {
        hostname: 'espn.com',
        siteBaseUrl: 'https://www.nba.com/kings',
      });

      expect(urlsOf(result)).to.deep.equal(['https://cdn.espn.com/kings']);
    });

    it('keeps the whole fold when no site scope is supplied (legacy behavior)', () => {
      const result = transformDomainUrlsResponse(intuitRows, { hostname: 'intuit.com' });

      expect(result.totalCount).to.equal(4);
    });

    it('narrows a path-bearing third-party scope by its path prefix', () => {
      const result = transformDomainUrlsResponse(nbaRows, {
        hostname: 'nba.com/celtics',
        siteBaseUrl: 'https://www.nba.com/kings',
      });

      expect(urlsOf(result)).to.deep.equal(['https://nba.com/celtics']);
    });

    it('matches nothing for a non-empty hostname without a parseable host', () => {
      const result = transformDomainUrlsResponse(nbaRows, { hostname: '/just/a/path' });

      expect(result).to.deep.equal({ urls: [], totalCount: 0 });
    });

    it('keeps all rows when hostname is omitted, even with a site scope present', () => {
      const result = transformDomainUrlsResponse(nbaRows, {
        siteBaseUrl: 'https://www.nba.com/kings',
      });

      expect(result.totalCount).to.equal(5);
    });
  });
});
