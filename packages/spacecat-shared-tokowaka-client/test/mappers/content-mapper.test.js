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
import ContentMapper from '../../src/mappers/content-summarization-mapper.js';

describe('ContentMapper', () => {
  let mapper;
  let log;

  beforeEach(() => {
    log = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    };
    mapper = new ContentMapper(log);
  });

  describe('getOpportunityType', () => {
    it('should return summarization', () => {
      expect(mapper.getOpportunityType()).to.equal('summarization');
    });
  });

  describe('requiresPrerender', () => {
    it('should return true', () => {
      expect(mapper.requiresPrerender()).to.be.true;
    });
  });

  describe('canDeploy', () => {
    it('should return eligible for valid content suggestion', () => {
      const suggestion = {
        getData: () => ({
          summarizationText: 'Some content',
          transformRules: {
            action: 'insertAfter',
            selector: '#text-85a9876220 > h1:nth-of-type(1)',
          },
        }),
      };

      const result = mapper.canDeploy(suggestion);

      expect(result).to.deep.equal({ eligible: true });
    });

    it('should return ineligible when summarizationText is missing', () => {
      const suggestion = {
        getData: () => ({
          transformRules: {
            action: 'insertAfter',
            selector: '#selector',
          },
        }),
      };

      const result = mapper.canDeploy(suggestion);

      expect(result).to.deep.equal({
        eligible: false,
        reason: 'summarizationText is required',
      });
    });

    it('should return ineligible when transformRules are missing', () => {
      const suggestion = {
        getData: () => ({
          summarizationText: 'Some content',
        }),
      };

      const result = mapper.canDeploy(suggestion);

      expect(result).to.deep.equal({
        eligible: false,
        reason: 'transformRules is required',
      });
    });

    it('should return ineligible when transformRules action is missing', () => {
      const suggestion = {
        getData: () => ({
          summarizationText: 'Some content',
          transformRules: {
            selector: '#selector',
          },
        }),
      };

      const result = mapper.canDeploy(suggestion);

      expect(result).to.deep.equal({
        eligible: false,
        reason: 'transformRules.action must be insertAfter, insertBefore, or appendChild',
      });
    });

    it('should return ineligible when transformRules selector is missing', () => {
      const suggestion = {
        getData: () => ({
          summarizationText: 'Some content',
          transformRules: {
            action: 'insertAfter',
          },
        }),
      };

      const result = mapper.canDeploy(suggestion);

      expect(result).to.deep.equal({
        eligible: false,
        reason: 'transformRules.selector is required',
      });
    });

    it('should return ineligible when data is null', () => {
      const suggestion = {
        getData: () => null,
      };

      const result = mapper.canDeploy(suggestion);

      expect(result).to.deep.equal({
        eligible: false,
        reason: 'summarizationText is required',
      });
    });
  });

  describe('suggestionsToPatches', () => {
    it('should create patch with HAST value from markdown', () => {
      const suggestion = {
        getId: () => 'sugg-content-123',
        getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
        getData: () => ({
          summarizationText: 'Enter your name exactly as it appears on your **government ID**.',
          transformRules: {
            action: 'insertAfter',
            selector: '#text-85a9876220 > h1:nth-of-type(1)',
          },
        }),
      };

      const patches = mapper.suggestionsToPatches('/path', [suggestion], 'opp-content-123');
      expect(patches.length).to.equal(1);
      const patch = patches[0];

      expect(patch).to.exist;
      expect(patch.op).to.equal('insertAfter');
      expect(patch.selector).to.equal('#text-85a9876220 > h1:nth-of-type(1)');
      expect(patch.valueFormat).to.equal('hast');
      expect(patch.opportunityId).to.equal('opp-content-123');
      expect(patch.suggestionId).to.equal('sugg-content-123');
      expect(patch.prerenderRequired).to.be.true;
      expect(patch.lastUpdated).to.be.a('number');

      // Verify HAST structure
      expect(patch.value).to.be.an('object');
      expect(patch.value.type).to.equal('root');
      expect(patch.value.children).to.be.an('array');
      expect(patch.value.children.length).to.be.greaterThan(0);
    });

    it('should convert markdown with bold text to HAST', () => {
      const suggestion = {
        getId: () => 'sugg-bold',
        getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
        getData: () => ({
          summarizationText: 'This is **bold** text.',
          transformRules: {
            action: 'insertAfter',
            selector: '.content',
          },
        }),
      };

      const patches = mapper.suggestionsToPatches('/path', [suggestion], 'opp-bold');
      expect(patches.length).to.equal(1);
      const patch = patches[0];

      expect(patch).to.exist;
      expect(patch.value.type).to.equal('root');
      expect(patch.value.children).to.be.an('array');

      // Find the paragraph
      const paragraph = patch.value.children.find((child) => child.type === 'element' && child.tagName === 'p');
      expect(paragraph).to.exist;
      expect(paragraph.children).to.be.an('array');

      // Should contain text and strong elements
      const hasStrong = paragraph.children.some((child) => child.type === 'element' && child.tagName === 'strong');
      expect(hasStrong).to.be.true;
    });

    it('should convert markdown with headings to HAST', () => {
      const suggestion = {
        getId: () => 'sugg-heading',
        getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
        getData: () => ({
          summarizationText: '## Key Points\n\nImportant information.',
          transformRules: {
            action: 'insertAfter',
            selector: '#intro',
          },
        }),
      };

      const patches = mapper.suggestionsToPatches('/path', [suggestion], 'opp-heading');
      expect(patches.length).to.equal(1);
      const patch = patches[0];

      expect(patch).to.exist;
      expect(patch.value.children).to.be.an('array');

      // Should have h2 and paragraph
      const hasH2 = patch.value.children.some((child) => child.type === 'element' && child.tagName === 'h2');
      const hasP = patch.value.children.some((child) => child.type === 'element' && child.tagName === 'p');
      expect(hasH2).to.be.true;
      expect(hasP).to.be.true;
    });

    it('should convert markdown with lists to HAST', () => {
      const suggestion = {
        getId: () => 'sugg-list',
        getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
        getData: () => ({
          summarizationText: '- Item 1\n- Item 2\n- Item 3',
          transformRules: {
            action: 'insertAfter',
            selector: '#list-section',
          },
        }),
      };

      const patches = mapper.suggestionsToPatches('/path', [suggestion], 'opp-list');
      expect(patches.length).to.equal(1);
      const patch = patches[0];

      expect(patch).to.exist;

      // Should have ul element
      const hasList = patch.value.children.some((child) => child.type === 'element' && child.tagName === 'ul');
      expect(hasList).to.be.true;
    });

    it('should return empty array when summarizationText is missing', () => {
      const suggestion = {
        getId: () => 'sugg-invalid',
        getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
        getData: () => ({
          transformRules: {
            action: 'insertAfter',
            selector: '#selector',
          },
        }),
      };

      const patches = mapper.suggestionsToPatches('/path', [suggestion], 'opp-invalid');
      expect(patches.length).to.equal(0);
    });

    it('should return empty array when transformRules are incomplete', () => {
      const suggestion = {
        getId: () => 'sugg-invalid-2',
        getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
        getData: () => ({
          summarizationText: 'Some content',
          transformRules: {
            selector: '#selector',
          },
        }),
      };

      const patches = mapper.suggestionsToPatches('/path', [suggestion], 'opp-invalid-2');
      expect(patches.length).to.equal(0);
    });

    it('should handle complex markdown with multiple elements', () => {
      const markdownText = `Enter your name exactly as it appears on your **government ID** when booking flights. The same name must be on your **ticket and travel documents**. Rules for names may be different for some countries, such as **Canada, UAE, Australia, and New Zealand**. If your name is spelled wrong, contact support before you travel. There may be a fee to make changes.

**Key Points**

- Name on booking must match your government-issued ID or passport.
- Exact spelling is required for both ticket and travel documents.
- Special requirements may apply for Canada, UAE, Australia, and New Zealand.`;

      const suggestion = {
        getId: () => 'sugg-complex',
        getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
        getData: () => ({
          summarizationText: markdownText,
          transformRules: {
            action: 'insertAfter',
            selector: '#content-section',
          },
        }),
      };

      const patches = mapper.suggestionsToPatches('/path', [suggestion], 'opp-complex');
      expect(patches.length).to.equal(1);
      const patch = patches[0];

      expect(patch).to.exist;
      expect(patch.value.children).to.be.an('array');
      expect(patch.value.children.length).to.be.greaterThan(2);

      // Should have paragraphs and list
      const hasP = patch.value.children.some((child) => child.type === 'element' && child.tagName === 'p');
      const hasList = patch.value.children.some((child) => child.type === 'element' && child.tagName === 'ul');
      expect(hasP).to.be.true;
      expect(hasList).to.be.true;
    });

    it('should handle markdown parsing errors gracefully', () => {
      let errorMessage = '';
      const errorLog = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: (msg) => { errorMessage = msg; },
      };

      const errorMapper = new ContentMapper(errorLog);

      // Pass an object instead of string to trigger natural error in markdown parser
      const suggestion = {
        getId: () => 'sugg-error',
        getData: () => ({
          summarizationText: { invalid: 'object' }, // This will cause markdown parser to fail
          transformRules: {
            action: 'insertAfter',
            selector: '#selector',
          },
        }),
      };

      const patches = errorMapper.suggestionsToPatches('/path', [suggestion], 'opp-error');

      expect(patches.length).to.equal(0);
      expect(errorMessage).to.include('Failed to convert markdown to HAST');
    });
  });
});
