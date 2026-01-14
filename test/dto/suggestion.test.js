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
      it('returns only id and url', () => {
        const suggestion = createMockSuggestion();

        const json = SuggestionDto.toJSON(suggestion, 'minimal');

        expect(json).to.deep.equal({
          id: 'suggestion-id-123',
          url: 'https://example.com/page',
        });
      });

      it('extracts url from data.pageUrl when data.url is not present', () => {
        const suggestion = createMockSuggestion({ url: undefined, pageUrl: 'https://example.com/page-url' });

        const json = SuggestionDto.toJSON(suggestion, 'minimal');

        expect(json.url).to.equal('https://example.com/page-url');
      });

      it('extracts url from data.url_from when url and pageUrl are not present', () => {
        const suggestion = createMockSuggestion({ url: undefined, pageUrl: undefined, url_from: 'https://example.com/url-from' });

        const json = SuggestionDto.toJSON(suggestion, 'minimal');

        expect(json.url).to.equal('https://example.com/url-from');
      });

      it('extracts url from data.urlFrom as fallback', () => {
        const suggestion = createMockSuggestion({
          url: undefined,
          pageUrl: undefined,
          url_from: undefined,
          urlFrom: 'https://example.com/url-from-camel',
        });

        const json = SuggestionDto.toJSON(suggestion, 'minimal');

        expect(json.url).to.equal('https://example.com/url-from-camel');
      });

      it('returns null url when no URL field is present', () => {
        const suggestion = {
          ...createMockSuggestion(),
          getData: () => ({ content: 'no url here' }),
        };

        const json = SuggestionDto.toJSON(suggestion, 'minimal');

        expect(json.url).to.be.null;
      });

      it('returns null url when getData returns null', () => {
        const suggestion = {
          ...createMockSuggestion(),
          getData: () => null,
        };

        const json = SuggestionDto.toJSON(suggestion, 'minimal');

        expect(json.url).to.be.null;
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

      it('extracts url from various data fields', () => {
        const suggestion = createMockSuggestion({ url: undefined, pageUrl: 'https://example.com/summary-url' });

        const json = SuggestionDto.toJSON(suggestion, 'summary');

        expect(json.url).to.equal('https://example.com/summary-url');
      });
    });
  });
});
