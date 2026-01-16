/*
 * Copyright 2025 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

/* eslint-env mocha */

import { expect } from 'chai';

import { SuggestionDto, SUGGESTION_VIEWS } from '../../src/dto/suggestion.js';

describe('Suggestion DTO', () => {
  const createMockSuggestion = (dataOverrides = {}) => ({
    getId: () => 'suggestion-id-123',
    getOpportunityId: () => 'opportunity-id-456',
    getType: () => 'CONTENT_UPDATE',
    getRank: () => 42,
    getStatus: () => 'NEW',
    getData: () => ({ url: 'https://example.com/page', content: 'test', ...dataOverrides }),
    getKpiDeltas: () => ({ improvement: 10 }),
    getCreatedAt: () => '2025-01-01T00:00:00.000Z',
    getUpdatedAt: () => '2025-01-02T00:00:00.000Z',
    getUpdatedBy: () => 'system',
  });

  describe('SUGGESTION_VIEWS', () => {
    it('exports valid view options', () => {
      expect(SUGGESTION_VIEWS).to.deep.equal(['minimal', 'summary', 'full']);
    });
  });

  describe('toJSON', () => {
    describe('full view (default)', () => {
      it('returns all fields when view is not specified', () => {
        const suggestion = createMockSuggestion();

        const json = SuggestionDto.toJSON(suggestion);

        expect(json).to.have.property('id', 'suggestion-id-123');
        expect(json).to.have.property('opportunityId', 'opportunity-id-456');
        expect(json).to.have.property('type', 'CONTENT_UPDATE');
        expect(json).to.have.property('rank', 42);
        expect(json).to.have.property('status', 'NEW');
        expect(json).to.have.property('data');
        expect(json.data).to.have.property('url', 'https://example.com/page');
        expect(json.data).to.have.property('aggregationKey');
        expect(json).to.have.property('kpiDeltas');
        expect(json).to.have.property('createdAt', '2025-01-01T00:00:00.000Z');
        expect(json).to.have.property('updatedAt', '2025-01-02T00:00:00.000Z');
        expect(json).to.have.property('updatedBy', 'system');
      });

      it('returns all fields when view is "full"', () => {
        const suggestion = createMockSuggestion();

        const json = SuggestionDto.toJSON(suggestion, 'full');

        expect(json).to.have.property('id');
        expect(json).to.have.property('opportunityId');
        expect(json).to.have.property('type');
        expect(json).to.have.property('rank');
        expect(json).to.have.property('status');
        expect(json).to.have.property('data');
        expect(json).to.have.property('kpiDeltas');
        expect(json).to.have.property('createdAt');
        expect(json).to.have.property('updatedAt');
        expect(json).to.have.property('updatedBy');
      });
    });

    describe('minimal view', () => {
      it('returns id, status, and URL-related data fields', () => {
        const suggestion = createMockSuggestion();

        const json = SuggestionDto.toJSON(suggestion, 'minimal');

        expect(json).to.have.property('id', 'suggestion-id-123');
        expect(json).to.have.property('status', 'NEW');
        expect(json).to.have.property('data');
        expect(json.data).to.have.property('url', 'https://example.com/page');
        // Should not include non-URL fields like 'content'
        expect(json.data).to.not.have.property('content');
      });

      it('includes pageUrl in data when present', () => {
        const suggestion = createMockSuggestion({ url: undefined, pageUrl: 'https://example.com/page-url' });

        const json = SuggestionDto.toJSON(suggestion, 'minimal');

        expect(json.data).to.have.property('pageUrl', 'https://example.com/page-url');
      });

      it('includes urlFrom and urlTo in data when present', () => {
        const suggestion = createMockSuggestion({
          url: undefined,
          urlFrom: 'https://example.com/from',
          urlTo: 'https://example.com/to',
        });

        const json = SuggestionDto.toJSON(suggestion, 'minimal');

        expect(json.data).to.have.property('urlFrom', 'https://example.com/from');
        expect(json.data).to.have.property('urlTo', 'https://example.com/to');
      });

      it('includes recommendations array in data when present', () => {
        const suggestion = {
          ...createMockSuggestion(),
          getData: () => ({
            recommendations: [
              { pageUrl: 'https://example.com/nested-page', altText: 'description' },
              { pageUrl: 'https://example.com/other-page', altText: 'other' },
            ],
          }),
        };

        const json = SuggestionDto.toJSON(suggestion, 'minimal');

        expect(json.data).to.have.property('recommendations');
        expect(json.data.recommendations).to.have.length(2);
      });

      it('includes multiple URL-related fields when present', () => {
        const suggestion = createMockSuggestion({
          url: 'https://example.com/url',
          sitemapUrl: 'https://example.com/sitemap.xml',
          path: '/some/path',
          pattern: '*.html',
        });

        const json = SuggestionDto.toJSON(suggestion, 'minimal');

        expect(json.data).to.have.property('url', 'https://example.com/url');
        expect(json.data).to.have.property('sitemapUrl', 'https://example.com/sitemap.xml');
        expect(json.data).to.have.property('path', '/some/path');
        expect(json.data).to.have.property('pattern', '*.html');
      });

      it('includes cves, findings, form, page, accessibility when present', () => {
        const suggestion = createMockSuggestion({
          url: undefined,
          cves: [{ id: 'CVE-2025-1234' }],
          findings: [{ type: 'error' }],
          form: { action: '/submit' },
          page: { title: 'Test Page' },
          accessibility: { score: 95 },
        });

        const json = SuggestionDto.toJSON(suggestion, 'minimal');

        expect(json.data).to.have.property('cves');
        expect(json.data).to.have.property('findings');
        expect(json.data).to.have.property('form');
        expect(json.data).to.have.property('page');
        expect(json.data).to.have.property('accessibility');
      });

      it('includes urls array, link, sourceUrl, destinationUrl when present', () => {
        const suggestion = createMockSuggestion({
          url: undefined,
          urls: ['https://example.com/1', 'https://example.com/2'],
          link: 'https://example.com/link',
          sourceUrl: 'https://example.com/source',
          destinationUrl: 'https://example.com/dest',
        });

        const json = SuggestionDto.toJSON(suggestion, 'minimal');

        expect(json.data).to.have.property('urls');
        expect(json.data.urls).to.deep.equal(['https://example.com/1', 'https://example.com/2']);
        expect(json.data).to.have.property('link', 'https://example.com/link');
        expect(json.data).to.have.property('sourceUrl', 'https://example.com/source');
        expect(json.data).to.have.property('destinationUrl', 'https://example.com/dest');
      });

      it('does not include data property when no URL-related fields exist', () => {
        const suggestion = {
          ...createMockSuggestion(),
          getData: () => ({ content: 'no url here', title: 'test' }),
        };

        const json = SuggestionDto.toJSON(suggestion, 'minimal');

        expect(json).to.have.property('id');
        expect(json).to.have.property('status');
        expect(json).to.not.have.property('data');
      });

      it('does not include data property when getData returns null', () => {
        const suggestion = {
          ...createMockSuggestion(),
          getData: () => null,
        };

        const json = SuggestionDto.toJSON(suggestion, 'minimal');

        expect(json).to.deep.equal({
          id: 'suggestion-id-123',
          status: 'NEW',
        });
      });
    });

    describe('summary view', () => {
      it('returns key fields without data and kpiDeltas', () => {
        const suggestion = createMockSuggestion();

        const json = SuggestionDto.toJSON(suggestion, 'summary');

        expect(json).to.deep.equal({
          id: 'suggestion-id-123',
          opportunityId: 'opportunity-id-456',
          type: 'CONTENT_UPDATE',
          rank: 42,
          status: 'NEW',
          url: 'https://example.com/page',
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-02T00:00:00.000Z',
          updatedBy: 'system',
        });
      });

      it('does not include data or kpiDeltas fields', () => {
        const suggestion = createMockSuggestion();

        const json = SuggestionDto.toJSON(suggestion, 'summary');

        expect(json).to.not.have.property('data');
        expect(json).to.not.have.property('kpiDeltas');
      });

      it('extracts url from pageUrl when url is not present', () => {
        const suggestion = createMockSuggestion({ url: undefined, pageUrl: 'https://example.com/summary-url' });

        const json = SuggestionDto.toJSON(suggestion, 'summary');

        expect(json.url).to.equal('https://example.com/summary-url');
      });

      it('extracts url from url_from (snake_case) when url and pageUrl are not present', () => {
        const suggestion = createMockSuggestion({
          url: undefined,
          pageUrl: undefined,
          url_from: 'https://example.com/url-from-snake',
        });

        const json = SuggestionDto.toJSON(suggestion, 'summary');

        expect(json.url).to.equal('https://example.com/url-from-snake');
      });

      it('extracts url from urlFrom (camelCase) when url, pageUrl, url_from are not present', () => {
        const suggestion = createMockSuggestion({
          url: undefined,
          pageUrl: undefined,
          url_from: undefined,
          urlFrom: 'https://example.com/url-from-camel',
        });

        const json = SuggestionDto.toJSON(suggestion, 'summary');

        expect(json.url).to.equal('https://example.com/url-from-camel');
      });

      it('extracts url from nested recommendations[0].pageUrl', () => {
        const suggestion = {
          ...createMockSuggestion(),
          getData: () => ({
            recommendations: [
              { pageUrl: 'https://example.com/rec-page-url', altText: 'test' },
            ],
          }),
        };

        const json = SuggestionDto.toJSON(suggestion, 'summary');

        expect(json.url).to.equal('https://example.com/rec-page-url');
      });

      it('extracts url from nested recommendations[0].url when pageUrl not present', () => {
        const suggestion = {
          ...createMockSuggestion(),
          getData: () => ({
            recommendations: [
              { url: 'https://example.com/rec-url', altText: 'test' },
            ],
          }),
        };

        const json = SuggestionDto.toJSON(suggestion, 'summary');

        expect(json.url).to.equal('https://example.com/rec-url');
      });

      it('returns null url when recommendations array is empty', () => {
        const suggestion = {
          ...createMockSuggestion(),
          getData: () => ({ recommendations: [] }),
        };

        const json = SuggestionDto.toJSON(suggestion, 'summary');

        expect(json.url).to.be.null;
      });

      it('returns null url when getData returns null', () => {
        const suggestion = {
          ...createMockSuggestion(),
          getData: () => null,
        };

        const json = SuggestionDto.toJSON(suggestion, 'summary');

        expect(json.url).to.be.null;
      });
    });
  });
});
