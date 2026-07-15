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
 * Contract tests for the domain-urls element definition (LLMO-6160 POC, previously
 * c8-ignored). transformDomainUrlsResponse is the Phase-2 domain drilldown: it keeps
 * only URLs whose host matches the domain (apex OR subdomain — the load-bearing
 * `hostMatches` rule), sums across projects, applies the content-type filter, and
 * paginates client-side.
 */

import { expect } from 'chai';
import {
  buildDomainUrlsPayload,
  transformDomainUrlsResponse,
} from '../../../../src/support/elements/definitions/domain-urls.js';

const project = ({ region, data = [] }) => ({ region, stats: { blocks: { data } } });
const statsRow = (o = {}) => ({
  source: 'https://openai.com/a', domain_type: 'Other', citations: 10, prompts_with_citation: 2, ...o,
});

describe('domain-urls definition', () => {
  describe('buildDomainUrlsPayload', () => {
    it('encodes model, dates, category tag and projectId', () => {
      const payload = buildDomainUrlsPayload({
        platform: 'chatgpt', startDate: '2026-03-01', endDate: '2026-03-31', category: 'Firefly', projectId: 'proj-9',
      });
      expect(payload.project_id).to.equal('proj-9');
      expect(payload.filters.advanced.filters.find((f) => f.op === 'or').filters[0])
        .to.deep.equal({ op: 'eq', val: 'search-gpt', col: 'CBF_model' });
      expect(payload.filters.advanced.filters).to.deep.include({ op: 'eq', val: 'category:Firefly', col: 'CBF_tags' });
    });
  });

  describe('transformDomainUrlsResponse', () => {
    it('maps matching rows to the domain-urls contract (regions as a sorted comma string)', () => {
      const result = transformDomainUrlsResponse(
        [project({ region: 'US', data: [statsRow()] })],
        { hostname: 'openai.com' },
      );
      expect(result.totalCount).to.equal(1);
      expect(result.urls[0]).to.deep.equal({
        urlId: '',
        url: 'https://openai.com/a',
        contentType: 'Other',
        citations: 10,
        promptsCited: 2,
        categories: '',
        regions: 'US',
      });
    });

    it('matches the apex and subdomains but not lookalike domains (hostMatches)', () => {
      const result = transformDomainUrlsResponse(
        [project({
          region: 'US',
          data: [
            statsRow({ source: 'https://openai.com/apex' }),
            statsRow({ source: 'https://help.openai.com/sub' }),
            statsRow({ source: 'https://notopenai.com/nope', citations: 999 }),
          ],
        })],
        { hostname: 'openai.com' },
      );
      expect(result.urls.map((u) => u.url)).to.have.members([
        'https://openai.com/apex', 'https://help.openai.com/sub',
      ]);
      expect(result.totalCount).to.equal(2);
    });

    it('normalizes www and case on both the hostname param and the row host', () => {
      const result = transformDomainUrlsResponse(
        [project({ region: 'US', data: [statsRow({ source: 'https://WWW.OpenAI.com/x' })] })],
        { hostname: 'www.OPENAI.com' },
      );
      expect(result.totalCount).to.equal(1);
    });

    it('sums citations/prompts and joins regions (sorted, comma, no space) across projects', () => {
      const result = transformDomainUrlsResponse(
        [
          project({ region: 'US', data: [statsRow({ citations: 10, prompts_with_citation: 2 })] }),
          project({ region: 'EU', data: [statsRow({ citations: 5, prompts_with_citation: 1 })] }),
        ],
        { hostname: 'openai.com' },
      );
      expect(result.urls[0]).to.include({ citations: 15, promptsCited: 3, regions: 'EU,US' });
    });

    it('applies the content-type (channel) filter case-insensitively', () => {
      const result = transformDomainUrlsResponse(
        [project({
          region: 'US',
          data: [
            statsRow({ source: 'https://openai.com/owned', domain_type: 'Owned' }),
            statsRow({ source: 'https://openai.com/other', domain_type: 'Other' }),
          ],
        })],
        { hostname: 'openai.com', channel: 'owned' },
      );
      expect(result.urls.map((u) => u.url)).to.deep.equal(['https://openai.com/owned']);
      expect(result.totalCount).to.equal(1);
    });

    it('paginates client-side with totalCount as the post-filter, pre-slice count', () => {
      const data = Array.from({ length: 5 }, (_, i) => statsRow({ source: `https://openai.com/${i}`, citations: 100 - i }));
      const result = transformDomainUrlsResponse(
        [project({ region: 'US', data })],
        { hostname: 'openai.com', page: 1, pageSize: 2 },
      );
      expect(result.totalCount).to.equal(5);
      expect(result.urls.map((u) => u.url)).to.deep.equal(['https://openai.com/2', 'https://openai.com/3']);
    });

    it('skips null-source and unparseable-host rows and coerces non-numeric metrics to 0', () => {
      const result = transformDomainUrlsResponse(
        [project({
          region: 'US',
          data: [
            statsRow({ source: null }),
            statsRow({ source: 'not a url' }),
            statsRow({ source: 'https://openai.com/x', citations: 'nope', prompts_with_citation: null }),
          ],
        })],
        { hostname: 'openai.com' },
      );
      expect(result.totalCount).to.equal(1);
      expect(result.urls[0]).to.include({ url: 'https://openai.com/x', citations: 0, promptsCited: 0 });
    });

    it('tolerates a project missing stats blocks and defaults a missing contentType to ""', () => {
      const result = transformDomainUrlsResponse(
        [
          { region: 'US', stats: {} }, // no blocks → row loop falls back to []
          project({ region: 'US', data: [statsRow({ source: 'https://openai.com/x', domain_type: undefined })] }),
        ],
        { hostname: 'openai.com' },
      );
      expect(result.totalCount).to.equal(1);
      expect(result.urls[0]).to.include({ url: 'https://openai.com/x', contentType: '' });
    });

    it('returns an empty result for empty input', () => {
      expect(transformDomainUrlsResponse([], { hostname: 'openai.com' })).to.deep.equal({ urls: [], totalCount: 0 });
      expect(transformDomainUrlsResponse()).to.deep.equal({ urls: [], totalCount: 0 });
    });
  });
});
