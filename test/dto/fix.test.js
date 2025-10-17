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

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';

import { FixDto } from '../../src/dto/fix.js';
import { SuggestionDto } from '../../src/dto/suggestion.js';

use(chaiAsPromised);

describe('Fix DTO', () => {
  const sandbox = sinon.createSandbox();

  afterEach(() => {
    sandbox.restore();
  });

  const createMockFix = (overrides = {}) => ({
    getId: () => 'fix-id-123',
    getOpportunityId: () => 'opportunity-id-456',
    getType: () => 'CODE_CHANGE',
    getCreatedAt: () => '2025-01-01T00:00:00.000Z',
    getUpdatedAt: () => '2025-01-02T00:00:00.000Z',
    getExecutedBy: () => 'user@example.com',
    getExecutedAt: () => '2025-01-03T00:00:00.000Z',
    getPublishedAt: () => '2025-01-04T00:00:00.000Z',
    getChangeDetails: () => ({ field: 'value' }),
    getStatus: () => 'PENDING',
    getOrigin: () => 'MANUAL',
    ...overrides,
  });

  const createMockSuggestion = (id) => ({
    getId: () => id,
    getOpportunityId: () => 'opportunity-id-456',
    getType: () => 'CONTENT_UPDATE',
    getRank: () => 1,
    getStatus: () => 'NEW',
    getData: () => ({ content: 'test' }),
    getKpiDeltas: () => ({ improvement: 10 }),
    getCreatedAt: () => '2025-01-01T00:00:00.000Z',
    getUpdatedAt: () => '2025-01-02T00:00:00.000Z',
    getUpdatedBy: () => 'system',
  });

  describe('toJSON', () => {
    it('converts a fix entity without suggestions to JSON', () => {
      const fix = createMockFix();

      const json = FixDto.toJSON(fix);

      expect(json).to.deep.equal({
        id: 'fix-id-123',
        opportunityId: 'opportunity-id-456',
        type: 'CODE_CHANGE',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-02T00:00:00.000Z',
        executedBy: 'user@example.com',
        executedAt: '2025-01-03T00:00:00.000Z',
        publishedAt: '2025-01-04T00:00:00.000Z',
        changeDetails: { field: 'value' },
        status: 'PENDING',
        origin: 'MANUAL',
      });
      expect(json).to.not.have.property('suggestions');
    });

    it('converts a fix entity with suggestions to JSON', () => {
      const suggestion1 = createMockSuggestion('suggestion-id-1');
      const suggestion2 = createMockSuggestion('suggestion-id-2');

      const fix = createMockFix({
        _suggestions: [suggestion1, suggestion2],
      });

      sandbox.stub(SuggestionDto, 'toJSON')
        .onFirstCall()
        .returns({
          id: 'suggestion-id-1',
          opportunityId: 'opportunity-id-456',
          type: 'CONTENT_UPDATE',
          rank: 1,
          status: 'NEW',
          data: { content: 'test' },
          kpiDeltas: { improvement: 10 },
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-02T00:00:00.000Z',
          updatedBy: 'system',
        })
        .onSecondCall()
        .returns({
          id: 'suggestion-id-2',
          opportunityId: 'opportunity-id-456',
          type: 'CONTENT_UPDATE',
          rank: 1,
          status: 'NEW',
          data: { content: 'test' },
          kpiDeltas: { improvement: 10 },
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-02T00:00:00.000Z',
          updatedBy: 'system',
        });

      const json = FixDto.toJSON(fix);

      expect(json).to.have.property('suggestions');
      expect(json.suggestions).to.be.an('array').with.lengthOf(2);
      expect(json.suggestions[0].id).to.equal('suggestion-id-1');
      expect(json.suggestions[1].id).to.equal('suggestion-id-2');
      expect(SuggestionDto.toJSON).to.have.been.calledTwice;
      expect(SuggestionDto.toJSON).to.have.been.calledWith(suggestion1);
      expect(SuggestionDto.toJSON).to.have.been.calledWith(suggestion2);
    });

    it('converts a fix entity with empty suggestions array to JSON', () => {
      const fix = createMockFix({
        _suggestions: [],
      });

      const json = FixDto.toJSON(fix);

      expect(json).to.have.property('suggestions');
      expect(json.suggestions).to.be.an('array').with.lengthOf(0);
    });

    it('does not include suggestions if _suggestions is undefined', () => {
      const fix = createMockFix({
        _suggestions: undefined,
      });

      const json = FixDto.toJSON(fix);

      expect(json).to.not.have.property('suggestions');
    });

    it('does not include suggestions if _suggestions is null', () => {
      const fix = createMockFix({
        _suggestions: null,
      });

      const json = FixDto.toJSON(fix);

      expect(json).to.not.have.property('suggestions');
    });

    it('does not include suggestions if _suggestions is not an array', () => {
      const fix = createMockFix({
        _suggestions: 'not-an-array',
      });

      const json = FixDto.toJSON(fix);

      expect(json).to.not.have.property('suggestions');
    });

    it('correctly maps suggestions using SuggestionDto.toJSON', () => {
      const suggestion = createMockSuggestion('suggestion-id-123');
      const fix = createMockFix({
        _suggestions: [suggestion],
      });

      const expectedSuggestionJson = {
        id: 'suggestion-id-123',
        opportunityId: 'opportunity-id-456',
        type: 'CONTENT_UPDATE',
        rank: 1,
        status: 'NEW',
        data: { content: 'test' },
        kpiDeltas: { improvement: 10 },
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-02T00:00:00.000Z',
        updatedBy: 'system',
      };

      sandbox.stub(SuggestionDto, 'toJSON').returns(expectedSuggestionJson);

      const json = FixDto.toJSON(fix);

      expect(json.suggestions).to.deep.equal([expectedSuggestionJson]);
      expect(SuggestionDto.toJSON).to.have.been.calledOnceWith(suggestion);
    });
  });
});
