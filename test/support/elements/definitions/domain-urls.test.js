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
  });
});
