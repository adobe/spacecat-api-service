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

      it('includes url_from and url_to (snake_case) for broken backlinks', () => {
        const suggestion = createMockSuggestion({
          url: undefined,
          url_from: 'https://example.com/source-page',
          url_to: 'https://example.com/target-page',
        });

        const json = SuggestionDto.toJSON(suggestion, 'minimal');

        expect(json.data).to.have.property('url_from', 'https://example.com/source-page');
        expect(json.data).to.have.property('url_to', 'https://example.com/target-page');
      });

      it('includes urlsSuggested array when present', () => {
        const suggestion = createMockSuggestion({
          url: undefined,
          urlsSuggested: ['https://example.com/suggested1', 'https://example.com/suggested2'],
        });

        const json = SuggestionDto.toJSON(suggestion, 'minimal');

        expect(json.data).to.have.property('urlsSuggested');
        expect(json.data.urlsSuggested).to.deep.equal([
          'https://example.com/suggested1',
          'https://example.com/suggested2',
        ]);
      });

      it('includes CWV fields: metrics, type, pageviews when present', () => {
        const suggestion = createMockSuggestion({
          url: 'https://example.com/page',
          metrics: { mobileMetric: 5, desktopMetric: 3 },
          type: 'url',
          pageviews: 1000,
        });

        const json = SuggestionDto.toJSON(suggestion, 'minimal');

        expect(json.data).to.have.property('metrics');
        expect(json.data.metrics).to.deep.equal({ mobileMetric: 5, desktopMetric: 3 });
        expect(json.data).to.have.property('type', 'url');
        expect(json.data).to.have.property('pageviews', 1000);
      });

      it('includes issues array for Accessibility/ColorContrast/Form suggestions', () => {
        const suggestion = createMockSuggestion({
          url: undefined,
          issues: [
            { type: 'color-contrast', occurrences: 5 },
            { type: 'missing-alt', occurrences: 3 },
          ],
        });

        const json = SuggestionDto.toJSON(suggestion, 'minimal');

        expect(json.data).to.have.property('issues');
        expect(json.data.issues).to.have.length(2);
        expect(json.data.issues[0]).to.have.property('occurrences', 5);
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

      describe('accessibility-specific filtering', () => {
        const createMockOpportunity = (type) => ({
          getType: () => type,
        });

        it('filters issues to only occurrences for form-accessibility opportunities', () => {
          const suggestion = createMockSuggestion({
            issues: [
              {
                type: 'missing-label',
                occurrences: 5,
                severity: 'high',
                description: 'Form input missing label',
                element: '<input type="text">',
              },
              {
                type: 'invalid-button',
                occurrences: 3,
                severity: 'medium',
                description: 'Button missing type attribute',
                element: '<button>Submit</button>',
              },
            ],
          });
          const opportunity = createMockOpportunity('form-accessibility');

          const json = SuggestionDto.toJSON(suggestion, 'minimal', opportunity);

          expect(json.data).to.have.property('issues');
          expect(json.data.issues).to.have.length(2);
          expect(json.data.issues[0]).to.deep.equal({ occurrences: 5 });
          expect(json.data.issues[1]).to.deep.equal({ occurrences: 3 });
          expect(json.data.issues[0]).to.not.have.property('severity');
          expect(json.data.issues[0]).to.not.have.property('description');
          expect(json.data.issues[0]).to.not.have.property('element');
        });

        it('filters issues to only occurrences for a11y-color-contrast opportunities', () => {
          const suggestion = createMockSuggestion({
            issues: [
              {
                type: 'low-contrast',
                occurrences: 8,
                severity: 'high',
                ratio: '2.5:1',
              },
            ],
          });
          const opportunity = createMockOpportunity('a11y-color-contrast');

          const json = SuggestionDto.toJSON(suggestion, 'minimal', opportunity);

          expect(json.data.issues).to.have.length(1);
          expect(json.data.issues[0]).to.deep.equal({ occurrences: 8 });
          expect(json.data.issues[0]).to.not.have.property('ratio');
        });

        it('filters issues to only occurrences for a11y-assistive opportunities', () => {
          const suggestion = createMockSuggestion({
            issues: [
              {
                type: 'missing-alt',
                occurrences: 12,
                severity: 'critical',
              },
            ],
          });
          const opportunity = createMockOpportunity('a11y-assistive');

          const json = SuggestionDto.toJSON(suggestion, 'minimal', opportunity);

          expect(json.data.issues[0]).to.deep.equal({ occurrences: 12 });
        });

        it('does not filter issues for non-accessibility opportunities', () => {
          const suggestion = createMockSuggestion({
            issues: [
              {
                type: 'cwv-issue',
                occurrences: 5,
                severity: 'high',
                metric: 'LCP',
              },
            ],
          });
          const opportunity = createMockOpportunity('cwv');

          const json = SuggestionDto.toJSON(suggestion, 'minimal', opportunity);

          expect(json.data.issues[0]).to.have.property('occurrences', 5);
          expect(json.data.issues[0]).to.have.property('severity', 'high');
          expect(json.data.issues[0]).to.have.property('metric', 'LCP');
        });

        it('does not filter issues when opportunity is not provided', () => {
          const suggestion = createMockSuggestion({
            issues: [
              {
                type: 'some-issue',
                occurrences: 5,
                severity: 'high',
              },
            ],
          });

          const json = SuggestionDto.toJSON(suggestion, 'minimal');

          expect(json.data.issues[0]).to.have.property('occurrences', 5);
          expect(json.data.issues[0]).to.have.property('severity', 'high');
        });

        it('handles non-array issues field gracefully', () => {
          const suggestion = createMockSuggestion({
            issues: null,
          });
          const opportunity = createMockOpportunity('form-accessibility');

          const json = SuggestionDto.toJSON(suggestion, 'minimal', opportunity);

          expect(json.data.issues).to.be.null;
        });
      });
    });

    describe('summary view', () => {
      it('returns minimal fields plus metadata (superset of minimal)', () => {
        const suggestion = createMockSuggestion();

        const json = SuggestionDto.toJSON(suggestion, 'summary');

        expect(json).to.have.property('id', 'suggestion-id-123');
        expect(json).to.have.property('status', 'NEW');
        expect(json).to.have.property('data');
        expect(json.data).to.have.property('url', 'https://example.com/page');
        expect(json).to.have.property('opportunityId', 'opportunity-id-456');
        expect(json).to.have.property('type', 'CONTENT_UPDATE');
        expect(json).to.have.property('rank', 42);
        expect(json).to.have.property('createdAt', '2025-01-01T00:00:00.000Z');
        expect(json).to.have.property('updatedAt', '2025-01-02T00:00:00.000Z');
        expect(json).to.have.property('updatedBy', 'system');
      });

      it('includes data with minimal fields but excludes kpiDeltas', () => {
        const suggestion = createMockSuggestion();

        const json = SuggestionDto.toJSON(suggestion, 'summary');

        expect(json).to.have.property('data');
        expect(json.data).to.not.have.property('content'); // Non-URL field excluded
        expect(json).to.not.have.property('kpiDeltas');
      });

      it('does not include url at top level (only in data)', () => {
        const suggestion = createMockSuggestion();

        const json = SuggestionDto.toJSON(suggestion, 'summary');

        expect(json).to.not.have.property('url'); // No top-level URL
        expect(json.data).to.have.property('url'); // URL in data only
      });

      it('extracts url from nested recommendations[0].pageUrl', () => {
        const opportunity = {
          getType: () => 'alt-text',
        };
        const suggestion = {
          ...createMockSuggestion(),
          getData: () => ({
            recommendations: [
              { pageUrl: 'https://example.com/rec-page-url', altText: 'test' },
            ],
          }),
        };

        const json = SuggestionDto.toJSON(suggestion, 'summary', opportunity);

        // URL is in data, not at top level
        expect(json).to.not.have.property('url');
        expect(json.data).to.have.property('recommendations');
      });

      it('does not return null url when getData returns null', () => {
        const suggestion = {
          ...createMockSuggestion(),
          getData: () => null,
        };

        const json = SuggestionDto.toJSON(suggestion, 'summary');

        expect(json).to.not.have.property('url'); // No URL extraction anymore
        expect(json).to.not.have.property('data'); // No data when getData returns null
      });

      describe('accessibility-specific filtering', () => {
        const createMockOpportunity = (type) => ({
          getType: () => type,
        });

        it('filters issues to only occurrences for accessibility opportunities in summary view', () => {
          const suggestion = createMockSuggestion({
            issues: [
              {
                type: 'missing-alt',
                occurrences: 10,
                severity: 'critical',
                element: '<img src="test.jpg">',
              },
            ],
          });
          const opportunity = createMockOpportunity('form-accessibility');

          const json = SuggestionDto.toJSON(suggestion, 'summary', opportunity);

          expect(json.data.issues).to.have.length(1);
          expect(json.data.issues[0]).to.deep.equal({ occurrences: 10 });
          expect(json).to.have.property('opportunityId');
          expect(json).to.have.property('type');
          expect(json).to.have.property('rank');
        });

        it('does not filter issues for non-accessibility opportunities in summary view', () => {
          const suggestion = createMockSuggestion({
            issues: [
              {
                type: 'cwv-issue',
                occurrences: 5,
                severity: 'high',
              },
            ],
          });
          const opportunity = createMockOpportunity('broken-backlinks');

          const json = SuggestionDto.toJSON(suggestion, 'summary', opportunity);

          expect(json.data.issues[0]).to.have.property('occurrences', 5);
          expect(json.data.issues[0]).to.have.property('severity', 'high');
        });
      });
    });
  });
});
