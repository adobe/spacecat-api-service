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

// ignore eslint errors
/* eslint-disable */
/* eslint-env mocha */
/* eslint-disable max-classes-per-file, class-methods-use-this */

import { expect } from 'chai';
import BaseOpportunityMapper from '../../src/mappers/base-mapper.js';

describe('BaseOpportunityMapper', () => {
  let mapper;
  let log;

  beforeEach(() => {
    log = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    };
    mapper = new BaseOpportunityMapper(log);
  });

  describe('abstract methods', () => {
    it('getOpportunityType should throw error', () => {
      expect(() => mapper.getOpportunityType())
        .to.throw('getOpportunityType() must be implemented by subclass');
    });

    it('requiresPrerender should throw error', () => {
      expect(() => mapper.requiresPrerender())
        .to.throw('requiresPrerender() must be implemented by subclass');
    });

    it('suggestionsToPatches should throw error', () => {
      expect(() => mapper.suggestionsToPatches('/path', [], 'opp-123', null))
        .to.throw('suggestionsToPatches() must be implemented by subclass');
    });

    it('canDeploy should throw error if not implemented', () => {
      expect(() => mapper.canDeploy({}))
        .to.throw('canDeploy() must be implemented by subclass');
    });
  });

  describe('createBasePatch', () => {
    it('should use getUpdatedAt method when available', () => {
      // Create a concrete subclass for testing
      class TestMapper extends BaseOpportunityMapper {
        getOpportunityType() { return 'test'; }

        requiresPrerender() { return true; }

        suggestionsToPatches() { return []; }

        canDeploy() { return { eligible: true }; }
      }

      const testMapper = new TestMapper(log);
      const suggestion = {
        getId: () => 'test-123',
        getData: () => ({}),
        getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
      };

      const patch = testMapper.createBasePatch(suggestion, 'opp-456');

      expect(patch.suggestionId).to.equal('test-123');
      expect(patch.opportunityId).to.equal('opp-456');
      expect(patch.lastUpdated).to.equal(new Date('2025-01-15T10:00:00.000Z').getTime());
      expect(patch.prerenderRequired).to.be.true;
    });

    it('should use Date.now() when getUpdatedAt returns null', () => {
      class TestMapper extends BaseOpportunityMapper {
        getOpportunityType() { return 'test'; }

        requiresPrerender() { return true; }

        suggestionsToPatches() { return []; }

        canDeploy() { return { eligible: true }; }
      }

      const testMapper = new TestMapper(log);
      const suggestion = {
        getId: () => 'test-no-date',
        getData: () => ({}),
        getUpdatedAt: () => null, // Returns null
      };

      const beforeTime = Date.now();
      const patch = testMapper.createBasePatch(suggestion, 'opp-fallback');
      const afterTime = Date.now();

      expect(patch.suggestionId).to.equal('test-no-date');
      expect(patch.opportunityId).to.equal('opp-fallback');
      expect(patch.lastUpdated).to.be.at.least(beforeTime);
      expect(patch.lastUpdated).to.be.at.most(afterTime);
      expect(patch.prerenderRequired).to.be.true;
    });

    it('should prioritize scrapedAt from getData()', () => {
      class TestMapper extends BaseOpportunityMapper {
        getOpportunityType() { return 'test'; }

        requiresPrerender() { return true; }

        suggestionsToPatches() { return []; }

        canDeploy() { return { eligible: true }; }
      }

      const testMapper = new TestMapper(log);
      const scrapedTime = '2025-01-20T15:30:00.000Z';
      const suggestion = {
        getId: () => 'test-scraped',
        getData: () => ({ scrapedAt: scrapedTime }),
        getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
      };

      const patch = testMapper.createBasePatch(suggestion, 'opp-scraped');

      expect(patch.lastUpdated).to.equal(new Date(scrapedTime).getTime());
    });

    it('should use transformRules.scrapedAt when scrapedAt is not available', () => {
      class TestMapper extends BaseOpportunityMapper {
        getOpportunityType() { return 'test'; }

        requiresPrerender() { return true; }

        suggestionsToPatches() { return []; }

        canDeploy() { return { eligible: true }; }
      }

      const testMapper = new TestMapper(log);
      const transformScrapedTime = '2025-01-18T12:00:00.000Z';
      const suggestion = {
        getId: () => 'test-transform',
        getData: () => ({ transformRules: { scrapedAt: transformScrapedTime } }),
        getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
      };

      const patch = testMapper.createBasePatch(suggestion, 'opp-transform');

      expect(patch.lastUpdated).to.equal(new Date(transformScrapedTime).getTime());
    });

    it('should handle invalid date strings by using Date.now()', () => {
      class TestMapper extends BaseOpportunityMapper {
        getOpportunityType() { return 'test'; }

        requiresPrerender() { return true; }

        suggestionsToPatches() { return []; }

        canDeploy() { return { eligible: true }; }
      }

      const testMapper = new TestMapper(log);
      const suggestion = {
        getId: () => 'test-invalid',
        getData: () => ({}),
        getUpdatedAt: () => 'invalid-date-string',
      };

      const beforeTime = Date.now();
      const patch = testMapper.createBasePatch(suggestion, 'opp-invalid');
      const afterTime = Date.now();

      // Should fallback to Date.now() for invalid dates
      expect(patch.lastUpdated).to.be.at.least(beforeTime);
      expect(patch.lastUpdated).to.be.at.most(afterTime);
    });

    it('should handle missing getData() gracefully', () => {
      class TestMapper extends BaseOpportunityMapper {
        getOpportunityType() { return 'test'; }

        requiresPrerender() { return true; }

        suggestionsToPatches() { return []; }

        canDeploy() { return { eligible: true }; }
      }

      const testMapper = new TestMapper(log);
      const suggestion = {
        getId: () => 'test-no-data',
        getData: () => null,
        getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
      };

      const patch = testMapper.createBasePatch(suggestion, 'opp-no-data');

      expect(patch.lastUpdated).to.equal(new Date('2025-01-15T10:00:00.000Z').getTime());
    });
  });

  describe('rollbackPatches', () => {
    let testMapper;

    beforeEach(() => {
      class TestMapper extends BaseOpportunityMapper {
        getOpportunityType() { return 'test'; }

        requiresPrerender() { return true; }

        suggestionsToPatches() { return []; }

        canDeploy() { return { eligible: true }; }
      }

      testMapper = new TestMapper(log);
    });

    it('should remove patches by suggestion IDs using default implementation', () => {
      const config = {
        url: 'https://example.com/page1',
        version: '1.0',
        forceFail: false,
        prerender: true,
        patches: [
          {
            opportunityId: 'opp-test',
            suggestionId: 'sugg-1',
            op: 'replace',
            value: 'value-1',
          },
          {
            opportunityId: 'opp-test',
            suggestionId: 'sugg-2',
            op: 'replace',
            value: 'value-2',
          },
        ],
      };

      const result = testMapper.rollbackPatches(config, ['sugg-1'], 'opp-test');

      expect(result.patches).to.have.lengthOf(1);
      expect(result.patches[0].suggestionId).to.equal('sugg-2');
      expect(result.removedCount).to.equal(1);
    });

    it('should handle null/undefined config gracefully', () => {
      const result1 = testMapper.rollbackPatches(null, ['sugg-1'], 'opp-test');
      expect(result1).to.be.null;

      const result2 = testMapper.rollbackPatches(undefined, ['sugg-1'], 'opp-test');
      expect(result2).to.be.undefined;
    });

    it('should remove patches for multiple suggestion IDs', () => {
      const config = {
        url: 'https://example.com/page1',
        version: '1.0',
        forceFail: false,
        prerender: true,
        patches: [
          {
            opportunityId: 'opp-test',
            suggestionId: 'sugg-1',
            op: 'replace',
            value: 'value-1',
          },
          {
            opportunityId: 'opp-test',
            suggestionId: 'sugg-2',
            op: 'replace',
            value: 'value-2',
          },
          {
            opportunityId: 'opp-test',
            suggestionId: 'sugg-3',
            op: 'replace',
            value: 'value-3',
          },
        ],
      };

      const result = testMapper.rollbackPatches(config, ['sugg-1', 'sugg-3'], 'opp-test');

      expect(result.patches).to.have.lengthOf(1);
      expect(result.patches[0].suggestionId).to.equal('sugg-2');
      expect(result.removedCount).to.equal(2);
    });

    it('should remove URL path when all patches are removed', () => {
      const config = {
        url: 'https://example.com/page1',
        version: '1.0',
        forceFail: false,
        prerender: true,
        patches: [
          {
            opportunityId: 'opp-test',
            suggestionId: 'sugg-1',
            op: 'replace',
            value: 'value-1',
          },
        ],
      };

      const result = testMapper.rollbackPatches(config, ['sugg-1'], 'opp-test');

      // All patches removed, patches array should be empty
      expect(result.patches).to.have.lengthOf(0);
      expect(result.removedCount).to.equal(1);
    });

    it('should preserve patches from other opportunities', () => {
      const config = {
        url: 'https://example.com/page1',
        version: '1.0',
        forceFail: false,
        prerender: true,
        patches: [
          {
            opportunityId: 'opp-test',
            suggestionId: 'sugg-1',
            op: 'replace',
            value: 'test-value',
          },
          {
            opportunityId: 'opp-other',
            suggestionId: 'sugg-2',
            op: 'replace',
            value: 'other-value',
          },
        ],
      };

      // Default implementation removes by suggestionId regardless of opportunity
      const result = testMapper.rollbackPatches(config, ['sugg-1'], 'opp-test');

      expect(result.patches).to.have.lengthOf(1);
      expect(result.patches[0].suggestionId).to.equal('sugg-2');
      expect(result.removedCount).to.equal(1);
    });
  });
});
