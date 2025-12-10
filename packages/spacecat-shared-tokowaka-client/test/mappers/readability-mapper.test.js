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

/* eslint-disable */
/* eslint-env mocha */

import { expect } from 'chai';
import ReadabilityMapper from '../../src/mappers/readability-mapper.js';

describe('ReadabilityMapper', () => {
  let mapper;
  let log;

  beforeEach(() => {
    log = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    };
    mapper = new ReadabilityMapper(log);
  });

  describe('getOpportunityType', () => {
    it('should return readability', () => {
      expect(mapper.getOpportunityType()).to.equal('readability');
    });
  });

  describe('requiresPrerender', () => {
    it('should return true', () => {
      expect(mapper.requiresPrerender()).to.be.true;
    });
  });

  describe('canDeploy', () => {
    it('should return eligible for valid readability suggestion', () => {
      const suggestion = {
        getData: () => ({
          textPreview: 'Lorem ipsum...',
          url: 'https://www.website.com',
          transformRules: {
            value: 'Tech enthusiasts keep up with the latest tech news...',
            op: 'replace',
            selector: '#main-238828 > div:nth-child(1) > span',
            target: 'ai-bots',
            prerenderRequired: true,
          },
        }),
      };

      const result = mapper.canDeploy(suggestion);

      expect(result).to.deep.equal({ eligible: true });
    });

    it('should return eligible for readability suggestion without target (uses default)', () => {
      const suggestion = {
        getData: () => ({
          textPreview: 'Lorem ipsum...',
          url: 'https://www.website.com',
          transformRules: {
            value: 'Improved readability text...',
            op: 'replace',
            selector: '#content > p',
          },
        }),
      };

      const result = mapper.canDeploy(suggestion);

      expect(result).to.deep.equal({ eligible: true });
    });

    it('should return ineligible when transformRules is missing', () => {
      const suggestion = {
        getData: () => ({
          textPreview: 'Lorem ipsum...',
          url: 'https://www.website.com',
        }),
      };

      const result = mapper.canDeploy(suggestion);

      expect(result).to.deep.equal({
        eligible: false,
        reason: 'transformRules is required',
      });
    });

    it('should return ineligible when data is null', () => {
      const suggestion = {
        getData: () => null,
      };

      const result = mapper.canDeploy(suggestion);

      expect(result).to.deep.equal({
        eligible: false,
        reason: 'transformRules is required',
      });
    });

    it('should return ineligible when transformRules.selector is missing', () => {
      const suggestion = {
        getData: () => ({
          textPreview: 'Text...',
          url: 'https://www.example.com',
          transformRules: {
            value: 'New text',
            op: 'replace',
          },
        }),
      };

      const result = mapper.canDeploy(suggestion);

      expect(result).to.deep.equal({
        eligible: false,
        reason: 'transformRules.selector is required',
      });
    });

    it('should return ineligible when transformRules.op is missing', () => {
      const suggestion = {
        getData: () => ({
          textPreview: 'Text...',
          url: 'https://www.example.com',
          transformRules: {
            value: 'New text',
            selector: '#content',
          },
        }),
      };

      const result = mapper.canDeploy(suggestion);

      expect(result).to.deep.equal({
        eligible: false,
        reason: 'transformRules.op must be "replace" for readability suggestions',
      });
    });

    it('should return ineligible when transformRules.op is not "replace"', () => {
      const suggestion = {
        getData: () => ({
          textPreview: 'Text...',
          url: 'https://www.example.com',
          transformRules: {
            value: 'New text',
            op: 'insertAfter',
            selector: '#content',
          },
        }),
      };

      const result = mapper.canDeploy(suggestion);

      expect(result).to.deep.equal({
        eligible: false,
        reason: 'transformRules.op must be "replace" for readability suggestions',
      });
    });

    it('should return ineligible when transformRules.value is missing', () => {
      const suggestion = {
        getData: () => ({
          textPreview: 'Text...',
          url: 'https://www.example.com',
          transformRules: {
            op: 'replace',
            selector: '#content',
          },
        }),
      };

      const result = mapper.canDeploy(suggestion);

      expect(result).to.deep.equal({
        eligible: false,
        reason: 'transformRules.value is required',
      });
    });

    it('should return ineligible when transformRules.selector is empty string', () => {
      const suggestion = {
        getData: () => ({
          textPreview: 'Text...',
          url: 'https://www.example.com',
          transformRules: {
            value: 'New text',
            op: 'replace',
            selector: '',
          },
        }),
      };

      const result = mapper.canDeploy(suggestion);

      expect(result).to.deep.equal({
        eligible: false,
        reason: 'transformRules.selector is required',
      });
    });

    it('should return ineligible when url is invalid', () => {
      const suggestion = {
        getData: () => ({
          textPreview: 'Text...',
          url: 'not-a-valid-url',
          transformRules: {
            value: 'New text',
            op: 'replace',
            selector: '#content',
          },
        }),
      };

      const result = mapper.canDeploy(suggestion);

      expect(result).to.deep.equal({
        eligible: false,
        reason: 'url not-a-valid-url is not a valid URL',
      });
    });

    it('should return ineligible when url is missing', () => {
      const suggestion = {
        getData: () => ({
          textPreview: 'Text...',
          transformRules: {
            value: 'New text',
            op: 'replace',
            selector: '#content',
          },
        }),
      };

      const result = mapper.canDeploy(suggestion);

      expect(result).to.deep.equal({
        eligible: false,
        reason: 'url undefined is not a valid URL',
      });
    });
  });

  describe('suggestionsToPatches', () => {
    it('should create patch for readability suggestion', () => {
      const suggestion = {
        getId: () => 'sugg-123',
        getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
        getData: () => ({
          textPreview: 'Lorem ipsum...',
          url: 'https://www.website.com',
          scrapedAt: '2025-09-20T06:21:12.584Z',
          transformRules: {
            value: 'Tech enthusiasts keep up with the latest tech news...',
            op: 'replace',
            selector: '#main-238828 > div:nth-child(1) > span',
            target: 'ai-bots',
            prerenderRequired: true,
          },
        }),
      };

      const patches = mapper.suggestionsToPatches('/path', [suggestion], 'opp-123');
      expect(patches.length).to.equal(1);
      const patch = patches[0];

      expect(patch).to.deep.include({
        op: 'replace',
        selector: '#main-238828 > div:nth-child(1) > span',
        value: 'Tech enthusiasts keep up with the latest tech news...',
        valueFormat: 'text',
        currValue: 'Lorem ipsum...',
        target: 'ai-bots',
        opportunityId: 'opp-123',
        suggestionId: 'sugg-123',
        prerenderRequired: true,
      });
      expect(patch.lastUpdated).to.be.a('number');
    });

    it('should create patch with scrapedAt timestamp', () => {
      const suggestion = {
        getId: () => 'sugg-456',
        getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
        getData: () => ({
          textPreview: 'Original text...',
          url: 'https://www.example.com',
          scrapedAt: '2025-09-20T06:21:12.584Z',
          transformRules: {
            value: 'Improved readability text',
            op: 'replace',
            selector: '.content > p',
          },
        }),
      };

      const patches = mapper.suggestionsToPatches('/path', [suggestion], 'opp-456');
      expect(patches.length).to.equal(1);
      const patch = patches[0];

      expect(patch.lastUpdated).to.equal(new Date('2025-09-20T06:21:12.584Z').getTime());
    });

    it('should use default target when not specified', () => {
      const suggestion = {
        getId: () => 'sugg-789',
        getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
        getData: () => ({
          textPreview: 'Text...',
          url: 'https://www.example.com',
          transformRules: {
            value: 'Better text',
            op: 'replace',
            selector: '#content',
          },
        }),
      };

      const patches = mapper.suggestionsToPatches('/path', [suggestion], 'opp-789');
      expect(patches.length).to.equal(1);
      const patch = patches[0];

      expect(patch.target).to.equal('ai-bots');
      expect(patch.currValue).to.equal('Text...');
    });

    it('should return empty array for invalid suggestion', () => {
      const suggestion = {
        getId: () => 'sugg-999',
        getData: () => ({
          textPreview: 'Text...',
          url: 'https://www.example.com',
          // Missing transformRules
        }),
      };

      const patches = mapper.suggestionsToPatches('/path', [suggestion], 'opp-999');
      expect(patches.length).to.equal(0);
    });

    it('should log warning for invalid suggestion', () => {
      let warnMessage = '';
      const warnLog = {
        debug: () => {},
        info: () => {},
        warn: (msg) => { warnMessage = msg; },
        error: () => {},
      };
      const warnMapper = new ReadabilityMapper(warnLog);

      const suggestion = {
        getId: () => 'sugg-warn',
        getData: () => ({
          textPreview: 'Text...',
          url: 'https://www.example.com',
          transformRules: {
            op: 'replace',
            // Missing selector and value
          },
        }),
      };

      const patches = warnMapper.suggestionsToPatches('/path', [suggestion], 'opp-warn');

      expect(patches.length).to.equal(0);
      expect(warnMessage).to.include('cannot be deployed');
      expect(warnMessage).to.include('sugg-warn');
    });

    it('should handle multiple suggestions', () => {
      const suggestions = [
        {
          getId: () => 'sugg-1',
          getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
          getData: () => ({
            textPreview: 'Original text 1',
            url: 'https://www.example.com/page1',
            transformRules: {
              value: 'First improved text',
              op: 'replace',
              selector: '#p1',
            },
          }),
        },
        {
          getId: () => 'sugg-2',
          getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
          getData: () => ({
            textPreview: 'Original text 2',
            url: 'https://www.example.com/page2',
            transformRules: {
              value: 'Second improved text',
              op: 'replace',
              selector: '#p2',
            },
          }),
        },
      ];

      const patches = mapper.suggestionsToPatches('/path', suggestions, 'opp-multi');
      expect(patches.length).to.equal(2);
      expect(patches[0].suggestionId).to.equal('sugg-1');
      expect(patches[0].selector).to.equal('#p1');
      expect(patches[0].currValue).to.equal('Original text 1');
      expect(patches[1].suggestionId).to.equal('sugg-2');
      expect(patches[1].selector).to.equal('#p2');
      expect(patches[1].currValue).to.equal('Original text 2');
    });
  });
});
