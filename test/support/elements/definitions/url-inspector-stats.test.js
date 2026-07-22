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
import { aggregateUrlInspectorStats } from '../../../../src/support/elements/definitions/url-inspector-stats.js';

const statsRow = (overrides = {}) => ({
  source: 'https://example.com/page',
  citations: 5,
  prompts_with_citation: 2,
  domain_type: 'Owned',
  ...overrides,
});

describe('url-inspector-stats definitions', () => {
  describe('aggregateUrlInspectorStats', () => {
    it('returns all zeros for an empty project list', () => {
      expect(aggregateUrlInspectorStats([])).to.deep.equal({
        uniqueUrls: 0, totalCitations: 0, totalPromptsCited: 0,
      });
    });

    it('returns all zeros when called with no argument', () => {
      expect(aggregateUrlInspectorStats()).to.deep.equal({
        uniqueUrls: 0, totalCitations: 0, totalPromptsCited: 0,
      });
    });

    it('counts a single owned URL row', () => {
      const projectResults = [{ stats: { blocks: { data: [statsRow()] } } }];
      expect(aggregateUrlInspectorStats(projectResults)).to.deep.equal({
        uniqueUrls: 1, totalCitations: 5, totalPromptsCited: 2,
      });
    });

    it('sums citations/promptsCited across multiple distinct owned URLs', () => {
      const projectResults = [{
        stats: {
          blocks: {
            data: [
              statsRow({ source: '/a', citations: 5, prompts_with_citation: 2 }),
              statsRow({ source: '/b', citations: 3, prompts_with_citation: 1 }),
            ],
          },
        },
      }];
      expect(aggregateUrlInspectorStats(projectResults)).to.deep.equal({
        uniqueUrls: 2, totalCitations: 8, totalPromptsCited: 3,
      });
    });

    it('dedupes the same URL appearing across multiple project (region) fan-outs, summing its counts', () => {
      const projectResults = [
        { stats: { blocks: { data: [statsRow({ source: '/a', citations: 5, prompts_with_citation: 2 })] } } },
        { stats: { blocks: { data: [statsRow({ source: '/a', citations: 3, prompts_with_citation: 1 })] } } },
      ];
      expect(aggregateUrlInspectorStats(projectResults)).to.deep.equal({
        uniqueUrls: 1, totalCitations: 8, totalPromptsCited: 3,
      });
    });

    it('excludes non-owned (third-party) rows', () => {
      const projectResults = [{
        stats: {
          blocks: {
            data: [
              statsRow({ source: '/owned', domain_type: 'Owned' }),
              statsRow({ source: 'https://competitor.com', domain_type: 'Third-party' }),
            ],
          },
        },
      }];
      expect(aggregateUrlInspectorStats(projectResults)).to.deep.equal({
        uniqueUrls: 1, totalCitations: 5, totalPromptsCited: 2,
      });
    });

    it('is case-insensitive on domain_type when matching "owned"', () => {
      const projectResults = [{ stats: { blocks: { data: [statsRow({ domain_type: 'OWNED' })] } } }];
      expect(aggregateUrlInspectorStats(projectResults).uniqueUrls).to.equal(1);
    });

    it('skips rows with a null/undefined source', () => {
      const projectResults = [{
        stats: { blocks: { data: [statsRow({ source: null }), statsRow({ source: undefined })] } },
      }];
      expect(aggregateUrlInspectorStats(projectResults)).to.deep.equal({
        uniqueUrls: 0, totalCitations: 0, totalPromptsCited: 0,
      });
    });

    it('coerces non-numeric citations/prompts_with_citation to 0 instead of NaN', () => {
      const projectResults = [{
        stats: {
          blocks: {
            data: [statsRow({ citations: 'not-a-number', prompts_with_citation: undefined })],
          },
        },
      }];
      expect(aggregateUrlInspectorStats(projectResults)).to.deep.equal({
        uniqueUrls: 1, totalCitations: 0, totalPromptsCited: 0,
      });
    });

    it('tolerates a missing blocks.data (empty upstream response)', () => {
      const projectResults = [{ stats: {} }, { stats: { blocks: {} } }, { stats: null }];
      expect(aggregateUrlInspectorStats(projectResults)).to.deep.equal({
        uniqueUrls: 0, totalCitations: 0, totalPromptsCited: 0,
      });
    });
  });
});
