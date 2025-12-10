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
import FaqMapper from '../../src/mappers/faq-mapper.js';

describe('FaqMapper', () => {
  let mapper;
  let log;

  beforeEach(() => {
    log = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    };
    mapper = new FaqMapper(log);
  });

  describe('getOpportunityType', () => {
    it('should return faq', () => {
      expect(mapper.getOpportunityType()).to.equal('faq');
    });
  });

  describe('requiresPrerender', () => {
    it('should return true', () => {
      expect(mapper.requiresPrerender()).to.be.true;
    });
  });

  describe('canDeploy', () => {
    it('should return eligible for valid FAQ suggestion', () => {
      const suggestion = {
        getData: () => ({
          item: {
            question: 'Is this valid?',
            answer: 'Yes, it is.',
          },
          url: 'https://www.example.com/page',
          shouldOptimize: true,
          transformRules: {
            action: 'appendChild',
            selector: 'main',
          },
        }),
      };

      const result = mapper.canDeploy(suggestion);

      expect(result).to.deep.equal({ eligible: true });
    });

    it('should return ineligible when item.question/answer is missing', () => {
      const suggestion = {
        getData: () => ({
          shouldOptimize: true,
          transformRules: {
            action: 'appendChild',
            selector: 'main',
          },
        }),
      };

      const result = mapper.canDeploy(suggestion);

      expect(result).to.deep.equal({
        eligible: false,
        reason: 'item.question and item.answer are required',
      });
    });

    it('should return ineligible when transformRules are missing', () => {
      const suggestion = {
        getData: () => ({
          shouldOptimize: true,
          item: {
            question: 'Is this valid?',
            answer: 'Yes, it is.',
          },
        }),
      };

      const result = mapper.canDeploy(suggestion);

      expect(result).to.deep.equal({
        eligible: false,
        reason: 'transformRules is required',
      });
    });

    it('should return ineligible when transformRules action is invalid', () => {
      const suggestion = {
        getData: () => ({
          shouldOptimize: true,
          item: {
            question: 'Question?',
            answer: 'Answer.',
          },
          transformRules: {
            action: 'replace',
            selector: 'main',
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
          shouldOptimize: true,
          item: {
            question: 'Question?',
            answer: 'Answer.',
          },
          transformRules: {
            action: 'appendChild',
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
        reason: 'shouldOptimize flag is not true',
      });
    });

    it('should accept insertAfter as valid action', () => {
      const suggestion = {
        getData: () => ({
          item: {
            question: 'Question?',
            answer: 'Answer.',
          },
          url: 'https://www.example.com/page',
          shouldOptimize: true,
          transformRules: {
            action: 'insertAfter',
            selector: 'main',
          },
        }),
      };

      const result = mapper.canDeploy(suggestion);

      expect(result).to.deep.equal({ eligible: true });
    });

    it('should accept insertBefore as valid action', () => {
      const suggestion = {
        getData: () => ({
          item: {
            question: 'Question?',
            answer: 'Answer.',
          },
          url: 'https://www.example.com/page',
          shouldOptimize: true,
          transformRules: {
            action: 'insertBefore',
            selector: 'main',
          },
        }),
      };

      const result = mapper.canDeploy(suggestion);

      expect(result).to.deep.equal({ eligible: true });
    });

    it('should return ineligible when URL is invalid', () => {
      const suggestion = {
        getData: () => ({
          item: {
            question: 'Question?',
            answer: 'Answer.',
          },
          url: 'not-a-valid-url',
          shouldOptimize: true,
          transformRules: {
            action: 'appendChild',
            selector: 'main',
          },
        }),
      };

      const result = mapper.canDeploy(suggestion);
      expect(result.eligible).to.be.false;
      expect(result.reason).to.include('not a valid URL');
    });

    it('should return ineligible when shouldOptimize is false', () => {
      const suggestion = {
        getData: () => ({
          item: {
            question: 'Question?',
            answer: 'Answer.',
          },
          url: 'https://www.example.com/page',
          shouldOptimize: false,
          transformRules: {
            action: 'appendChild',
            selector: 'main',
          },
        }),
      };

      const result = mapper.canDeploy(suggestion);
      expect(result).to.deep.equal({
        eligible: false,
        reason: 'shouldOptimize flag is not true',
      });
    });

    it('should return eligible when shouldOptimize is true', () => {
      const suggestion = {
        getData: () => ({
          item: {
            question: 'Question?',
            answer: 'Answer.',
          },
          url: 'https://www.example.com/page',
          shouldOptimize: true,
          transformRules: {
            action: 'appendChild',
            selector: 'main',
          },
        }),
      };

      const result = mapper.canDeploy(suggestion);
      expect(result).to.deep.equal({ eligible: true });
    });
  });

  describe('suggestionsToPatches', () => {
    it('should create patch with HAST value from markdown', () => {
      const suggestion = {
        getId: () => 'sugg-faq-123',
        getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
        getData: () => ({
          item: {
            question: 'Is Bulk better than myprotein?',
            answer: 'Yes, because of **better value**.',
          },
          url: 'https://www.example.com/page',
          headingText: 'FAQs',
          shouldOptimize: true,
          transformRules: {
            action: 'appendChild',
            selector: 'main',
          },
        }),
      };

      const patches = mapper.suggestionsToPatches('/page', [suggestion], 'opp-faq-123', null);

      // Should create 2 patches: heading + FAQ
      expect(patches).to.be.an('array');
      expect(patches.length).to.equal(2);

      // First patch: heading (no suggestionId)
      const headingPatch = patches[0];
      expect(headingPatch.opportunityId).to.equal('opp-faq-123');
      expect(headingPatch.suggestionId).to.be.undefined;
      expect(headingPatch.op).to.equal('appendChild');
      expect(headingPatch.selector).to.equal('main');
      expect(headingPatch.value.tagName).to.equal('h2');
      expect(headingPatch.value.children[0].value).to.equal('FAQs');

      // Second patch: FAQ item
      const faqPatch = patches[1];
      expect(faqPatch.opportunityId).to.equal('opp-faq-123');
      expect(faqPatch.suggestionId).to.equal('sugg-faq-123');
      expect(faqPatch.op).to.equal('appendChild');
      expect(faqPatch.selector).to.equal('main');
      expect(faqPatch.valueFormat).to.equal('hast');
      expect(faqPatch.prerenderRequired).to.be.true;
      expect(faqPatch.lastUpdated).to.be.a('number');

      // Verify FAQ HAST structure: <div><h3>question</h3>answer</div>
      expect(faqPatch.value).to.be.an('object');
      expect(faqPatch.value.type).to.equal('element');
      expect(faqPatch.value.tagName).to.equal('div');
      expect(faqPatch.value.children).to.be.an('array');
      expect(faqPatch.value.children[0].tagName).to.equal('h3');
    });

    it('should convert FAQ markdown with headings and lists to HAST', () => {
      const suggestion1 = {
        getId: () => 'sugg-faq-1',
        getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
        getData: () => ({
          item: {
            question: 'Is Bulk better than myprotein?',
            answer: `Bulk offers several advantages:

1. **Better Value for Money**: High-quality products at competitive prices.
2. **Wider Selection**: Products for diverse fitness goals.
3. **Unique Product Ranges**: Simplified product choices.`,
          },
          url: 'https://www.example.com/page',
          headingText: 'FAQs',
          shouldOptimize: true,
          transformRules: {
            action: 'appendChild',
            selector: 'main',
          },
        }),
      };

      const patches = mapper.suggestionsToPatches('/page', [suggestion1], 'opp-faq-complex', null);

      expect(patches.length).to.equal(2); // heading + FAQ

      // Check heading patch
      expect(patches[0].value.tagName).to.equal('h2');

      // Check FAQ patch
      const faqPatch = patches[1];
      expect(faqPatch).to.exist;
      expect(faqPatch.value.type).to.equal('element');
      expect(faqPatch.value.tagName).to.equal('div');
      expect(faqPatch.value.children).to.be.an('array');

      // Verify structure: div > [h3, ...answer content]
      const h3 = faqPatch.value.children[0];
      expect(h3.tagName).to.equal('h3');
      expect(h3.children[0].value).to.equal('Is Bulk better than myprotein?');

      // The rest should be answer content (paragraph, list, etc.)
      expect(faqPatch.value.children.length).to.be.greaterThan(1);
    });

    it('should handle markdown with bold text', () => {
      const suggestion = {
        getId: () => 'sugg-faq-bold',
        getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
        getData: () => ({
          item: {
            question: 'Question?',
            answer: 'This is **bold** text.',
          },
          url: 'https://www.example.com/page',
          headingText: 'FAQs',
          shouldOptimize: true,
          transformRules: {
            action: 'appendChild',
            selector: 'main',
          },
        }),
      };

      const patches = mapper.suggestionsToPatches('/page', [suggestion], 'opp-faq-bold', null);

      expect(patches.length).to.equal(2); // heading + FAQ

      // Check FAQ patch (second one)
      const faqPatch = patches[1];
      expect(faqPatch).to.exist;
      expect(faqPatch.value.type).to.equal('element');
      expect(faqPatch.value.tagName).to.equal('div');

      // Structure: div > [h3, ...answer]
      expect(faqPatch.value.children[0].tagName).to.equal('h3');

      // Find the paragraph in the answer
      const paragraph = faqPatch.value.children.find((child) => child.type === 'element' && child.tagName === 'p');
      expect(paragraph).to.exist;
      expect(paragraph.children).to.be.an('array');

      // Should contain strong elements
      const hasStrong = paragraph.children.some((child) => child.type === 'element' && child.tagName === 'strong');
      expect(hasStrong).to.be.true;
    });

    it('should return null when item.question/answer is missing', () => {
      const suggestion = {
        getId: () => 'sugg-invalid',
        getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
        getData: () => ({
          transformRules: {
            action: 'appendChild',
            selector: 'main',
          },
        }),
      };

      const patches = mapper.suggestionsToPatches('/page', [suggestion], 'opp-invalid', null);

      expect(patches).to.be.an('array');
      expect(patches.length).to.equal(0);
    });

    it('should return null when transformRules are incomplete', () => {
      const suggestion = {
        getId: () => 'sugg-invalid-2',
        getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
        getData: () => ({
          item: {
            question: 'Question?',
            answer: 'Answer.',
          },
          transformRules: {
            selector: 'main',
          },
        }),
      };

      const patches = mapper.suggestionsToPatches('/page', [suggestion], 'opp-invalid-2', null);

      expect(patches).to.be.an('array');
      expect(patches.length).to.equal(0);
    });

    it('should handle markdown parsing errors gracefully', () => {
      let errorCount = 0;
      const errorLog = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => { errorCount += 1; },
      };

      const errorMapper = new FaqMapper(errorLog);

      // Override buildFaqItemHast to throw an error
      const originalBuildFaqItemHast = errorMapper.buildFaqItemHast;
      errorMapper.buildFaqItemHast = () => {
        throw new Error('Markdown parsing failed');
      };

      const suggestion = {
        getId: () => 'sugg-error',
        getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
        getData: () => ({
          item: {
            question: 'Question?',
            answer: 'Answer.',
          },
          url: 'https://www.example.com/page',
          headingText: 'FAQs',
          shouldOptimize: true,
          transformRules: {
            action: 'appendChild',
            selector: 'main',
          },
        }),
      };

      const patches = errorMapper.suggestionsToPatches('/page', [suggestion], 'opp-error', null);

      // Should only create heading patch, FAQ item should fail gracefully
      expect(patches).to.be.an('array');
      expect(patches.length).to.equal(1); // Only heading
      expect(patches[0].value.tagName).to.equal('h2'); // Heading patch
      expect(errorCount).to.be.greaterThan(0);

      // Restore original method
      errorMapper.buildFaqItemHast = originalBuildFaqItemHast;
    });

    it('should handle real-world FAQ example from user', () => {
      const question1 = 'Is Bulk better than myprotein?';
      const answer1 = `Bulk offers several advantages over MyProtein in sports nutrition:

1. **Better Value for Money**: Bulk provides high-quality products at competitive prices, highlighting products like their Pure Whey Protein™, Europe's best value whey protein.
2. **Wider Selection**: Bulk's range of products caters to diverse fitness goals, including weight loss, muscle building, and performance improvement, making it broader than MyProtein.
3. **Unique Product Ranges**: Bulk simplifies product choices with four distinct ranges—Pure Series™, Complete Series™, Pro Series™, and Active Foods™.
4. **Customer Satisfaction**: Bulk emphasizes strong customer service and boasts a higher Trustpilot rating compared to MyProtein, indicating better customer trust.
5. **Superior Product Formulation**: Popular products, such as Elevate™ pre-workout and Complete Greens™, are noted for their quality and pricing compared to MyProtein's offerings.

Overall, Bulk positions itself as a better choice for sports nutrition through its focus on value, variety, innovation, and customer satisfaction.`;

      const suggestion = {
        getId: () => 'sugg-faq-real',
        getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
        getData: () => ({
          item: {
            question: question1,
            answer: answer1,
          },
          headingText: 'FAQs',
          shouldOptimize: true,
          transformRules: {
            action: 'appendChild',
            selector: 'main',
          },
          url: 'https://www.bulk.com/uk',
        }),
      };

      const patches = mapper.suggestionsToPatches('/page', [suggestion], 'opp-faq-real', null);

      expect(patches.length).to.equal(2); // heading + FAQ

      // Check heading patch
      expect(patches[0].value.tagName).to.equal('h2');

      // Check FAQ patch
      const faqPatch = patches[1];
      expect(faqPatch).to.exist;
      expect(faqPatch.op).to.equal('appendChild');
      expect(faqPatch.selector).to.equal('main');
      expect(faqPatch.valueFormat).to.equal('hast');
      expect(faqPatch.value.type).to.equal('element');
      expect(faqPatch.value.tagName).to.equal('div');
      expect(faqPatch.value.children).to.be.an('array');

      // Verify structure: div > [h3, ...answer content]
      expect(faqPatch.value.children[0].tagName).to.equal('h3');
    });

    it('should create individual patches for multiple FAQ suggestions', () => {
      const suggestions = [
        {
          getId: () => 'sugg-faq-1',
          getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
          getData: () => ({
            url: 'https://www.example.com/page',
            headingText: 'FAQs',
            shouldOptimize: true,
            item: {
              question: 'What is your return policy?',
              answer: 'You can return items within 30 days.',
            },
            transformRules: {
              action: 'appendChild',
              selector: 'main',
            },
          }),
        },
        {
          getId: () => 'sugg-faq-2',
          getUpdatedAt: () => '2025-01-15T11:00:00.000Z',
          getData: () => ({
            url: 'https://www.example.com/page',
            headingText: 'FAQs',
            shouldOptimize: true,
            item: {
              question: 'Do you ship internationally?',
              answer: 'Yes, we ship to over 100 countries.',
            },
            transformRules: {
              action: 'appendChild',
              selector: 'main',
            },
          }),
        },
      ];

      const patches = mapper.suggestionsToPatches('/page', suggestions, 'opp-faq-123', null);

      expect(patches).to.be.an('array');
      expect(patches.length).to.equal(3); // heading + 2 FAQs

      // First patch: heading (no suggestionId)
      const headingPatch = patches[0];
      expect(headingPatch.opportunityId).to.equal('opp-faq-123');
      expect(headingPatch.suggestionId).to.be.undefined;
      expect(headingPatch.op).to.equal('appendChild');
      expect(headingPatch.selector).to.equal('main');
      expect(headingPatch.value.tagName).to.equal('h2');

      // Second patch: first FAQ
      const firstFaqPatch = patches[1];
      expect(firstFaqPatch.opportunityId).to.equal('opp-faq-123');
      expect(firstFaqPatch.suggestionId).to.equal('sugg-faq-1');
      expect(firstFaqPatch.op).to.equal('appendChild');
      expect(firstFaqPatch.selector).to.equal('main');
      expect(firstFaqPatch.value.tagName).to.equal('div');

      // Third patch: second FAQ
      const secondFaqPatch = patches[2];
      expect(secondFaqPatch.opportunityId).to.equal('opp-faq-123');
      expect(secondFaqPatch.suggestionId).to.equal('sugg-faq-2');
      expect(secondFaqPatch.op).to.equal('appendChild');
      expect(secondFaqPatch.selector).to.equal('main');
      expect(secondFaqPatch.value.tagName).to.equal('div');

      // Verify HAST contains both questions
      const hastString1 = JSON.stringify(firstFaqPatch.value);
      const hastString2 = JSON.stringify(secondFaqPatch.value);
      expect(hastString1).to.include('What is your return policy?');
      expect(hastString2).to.include('Do you ship internationally?');
    });

    it('should handle single FAQ suggestion', () => {
      const suggestions = [
        {
          getId: () => 'sugg-faq-1',
          getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
          getData: () => ({
            url: 'https://www.example.com/page',
            headingText: 'FAQs',
            shouldOptimize: true,
            item: {
              question: 'What is your return policy?',
              answer: 'You can return items within 30 days.',
            },
            transformRules: {
              action: 'appendChild',
              selector: 'main',
            },
          }),
        },
      ];

      const patches = mapper.suggestionsToPatches('/page', suggestions, 'opp-faq-123', null);

      expect(patches).to.be.an('array');
      expect(patches.length).to.equal(2); // heading + 1 FAQ
      expect(patches[0].suggestionId).to.be.undefined; // heading
      expect(patches[1].suggestionId).to.equal('sugg-faq-1'); // FAQ
    });

    it('should filter out ineligible suggestions', () => {
      const suggestions = [
        {
          getId: () => 'sugg-faq-1',
          getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
          getData: () => ({
            url: 'https://www.example.com/page',
            headingText: 'FAQs',
            shouldOptimize: true,
            item: {
              question: 'Valid question?',
              answer: 'Valid answer.',
            },
            transformRules: {
              action: 'appendChild',
              selector: 'main',
            },
          }),
        },
        {
          getId: () => 'sugg-faq-2',
          getUpdatedAt: () => '2025-01-15T11:00:00.000Z',
          getData: () => ({
            url: 'https://www.example.com/page',
            shouldOptimize: true,
            // Missing item - should be filtered out
            transformRules: {
              action: 'appendChild',
              selector: 'main',
            },
          }),
        },
      ];

      const patches = mapper.suggestionsToPatches('/page', suggestions, 'opp-faq-123', null);

      expect(patches.length).to.equal(2); // heading + 1 valid FAQ
      expect(patches[0].suggestionId).to.be.undefined; // heading
      expect(patches[1].suggestionId).to.equal('sugg-faq-1'); // FAQ
    });

    it('should return empty array when all suggestions are ineligible', () => {
      const suggestions = [
        {
          getId: () => 'sugg-faq-1',
          getData: () => ({
            // Missing transformRules
            item: {
              question: 'Question?',
              answer: 'Answer.',
            },
          }),
        },
      ];

      const patches = mapper.suggestionsToPatches('/page', suggestions, 'opp-faq-123', null);

      expect(patches).to.be.an('array');
      expect(patches.length).to.equal(0);
    });

    it('should return empty array for empty suggestions', () => {
      const patches = mapper.suggestionsToPatches('/page', [], 'opp-faq-123', null);
      expect(patches).to.be.an('array');
      expect(patches.length).to.equal(0);
    });

    it('should handle suggestions with invalid URLs in allOpportunitySuggestions', () => {
      const suggestions = [
        {
          getId: () => 'sugg-faq-new',
          getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
          getData: () => ({
            url: 'https://www.example.com/page',
            headingText: 'FAQs',
            shouldOptimize: true,
            item: {
              question: 'Q?',
              answer: 'A.',
            },
            transformRules: {
              action: 'appendChild',
              selector: 'main',
            },
          }),
        },
      ];

      const allOpportunitySuggestions = [
        {
          getId: () => 'sugg-deployed-1',
          getData: () => ({
            url: 'invalid-url', // Invalid URL should be filtered out
            item: {
              question: 'Old Q?',
              answer: 'Old A.',
            },
            tokowakaDeployed: 1704884400000,
            transformRules: {
              action: 'appendChild',
              selector: 'main',
            },
          }),
        },
      ];

      const patches = mapper.suggestionsToPatches('/page', suggestions, 'opp-faq-123', allOpportunitySuggestions);

      expect(patches).to.be.an('array');
      expect(patches.length).to.equal(2); // heading + FAQ
      expect(patches[0].suggestionId).to.be.undefined; // heading
      expect(patches[1].suggestionId).to.equal('sugg-faq-new'); // FAQ
    });

    it('should use correct updatedAt timestamp for each patch', () => {
      const suggestions = [
        {
          getId: () => 'sugg-faq-1',
          getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
          getData: () => ({
            url: 'https://www.example.com/page',
            headingText: 'FAQs',
            shouldOptimize: true,
            item: {
              question: 'Q1?',
              answer: 'A1',
            },
            transformRules: {
              action: 'appendChild',
              selector: 'main',
            },
          }),
        },
        {
          getId: () => 'sugg-faq-2',
          getUpdatedAt: () => '2025-01-15T12:00:00.000Z',
          getData: () => ({
            url: 'https://www.example.com/page',
            headingText: 'FAQs',
            shouldOptimize: true,
            item: {
              question: 'Q2?',
              answer: 'A2',
            },
            transformRules: {
              action: 'appendChild',
              selector: 'main',
            },
          }),
        },
      ];

      const patches = mapper.suggestionsToPatches('/page', suggestions, 'opp-faq-123', null);

      const expectedTimestamp1 = new Date('2025-01-15T10:00:00.000Z').getTime();
      const expectedTimestamp2 = new Date('2025-01-15T12:00:00.000Z').getTime();

      expect(patches.length).to.equal(3); // heading + 2 FAQs
      // Heading uses the most recent timestamp from suggestions (12:00:00)
      expect(patches[0].lastUpdated).to.equal(expectedTimestamp2);
      // FAQ patches use their respective suggestion timestamps
      expect(patches[1].lastUpdated).to.equal(expectedTimestamp1);
      expect(patches[2].lastUpdated).to.equal(expectedTimestamp2);
    });

    it('should use Date.now() when getUpdatedAt returns null', () => {
      const suggestions = [
        {
          getId: () => 'sugg-faq-1',
          getUpdatedAt: () => null, // No updatedAt
          getData: () => ({
            url: 'https://www.example.com/page',
            headingText: 'FAQs',
            shouldOptimize: true,
            item: {
              question: 'Q1?',
              answer: 'A1',
            },
            transformRules: {
              action: 'appendChild',
              selector: 'main',
            },
          }),
        },
      ];

      const beforeTime = Date.now();
      const patches = mapper.suggestionsToPatches('/page', suggestions, 'opp-faq-123', null);
      const afterTime = Date.now();

      expect(patches.length).to.equal(2); // heading + FAQ
      // Both heading and FAQ should use Date.now()
      expect(patches[0].lastUpdated).to.be.at.least(beforeTime);
      expect(patches[0].lastUpdated).to.be.at.most(afterTime);
      expect(patches[1].lastUpdated).to.be.at.least(beforeTime);
      expect(patches[1].lastUpdated).to.be.at.most(afterTime);
    });

    it('should handle invalid date strings by using Date.now()', () => {
      const suggestions = [
        {
          getId: () => 'sugg-faq-invalid',
          getUpdatedAt: () => 'invalid-date-string', // Invalid date
          getData: () => ({
            url: 'https://www.example.com/page',
            headingText: 'FAQs',
            shouldOptimize: true,
            item: {
              question: 'Q1?',
              answer: 'A1',
            },
            transformRules: {
              action: 'appendChild',
              selector: 'main',
            },
          }),
        },
      ];

      const beforeTime = Date.now();
      const patches = mapper.suggestionsToPatches('/page', suggestions, 'opp-faq-invalid', null);
      const afterTime = Date.now();

      expect(patches.length).to.equal(2); // heading + FAQ
      // Both heading and FAQ should fallback to Date.now() for invalid dates
      expect(patches[0].lastUpdated).to.be.at.least(beforeTime);
      expect(patches[0].lastUpdated).to.be.at.most(afterTime);
      expect(patches[1].lastUpdated).to.be.at.least(beforeTime);
      expect(patches[1].lastUpdated).to.be.at.most(afterTime);
    });

    it('should handle real-world FAQ structure from user example', () => {
      const suggestion = {
        getId: () => '5ea1c4b1-dd5a-42e5-ad97-35cf8cc03cb9',
        getUpdatedAt: () => '2025-11-05T17:02:37.741Z',
        getData: () => ({
          topic: 'modifier pdf',
          transformRules: {
            action: 'appendChild',
            selector: 'main',
          },
          item: {
            answerSuitabilityReason: 'The answer provides clear instructions...',
            questionRelevanceReason: 'The question is directly related...',
            question: 'Comment modifier un PDF déjà existant ?',
            answer: 'Pour modifier un PDF existant avec Adobe Acrobat, vous pouvez utiliser soit l\'éditeur en ligne...',
            sources: [
              'https://www.adobe.com/in/acrobat/features/modify-pdfs.html',
            ],
          },
          headingText: 'FAQs',
          shouldOptimize: true,
          url: 'https://www.adobe.com/fr/acrobat/online/pdf-editor.html',
        }),
      };

      const patches = mapper.suggestionsToPatches('/page', [suggestion], 'opp-faq-123', null);

      expect(patches).to.be.an('array');
      expect(patches.length).to.equal(2); // heading + FAQ

      // Check heading
      expect(patches[0].value.tagName).to.equal('h2');

      // Check FAQ
      const faqPatch = patches[1];
      expect(faqPatch.op).to.equal('appendChild');
      expect(faqPatch.selector).to.equal('main');
      expect(faqPatch.valueFormat).to.equal('hast');

      const hastString = JSON.stringify(faqPatch.value);
      expect(hastString).to.include('Comment modifier un PDF');
    });

    it('should handle existing config parameter', () => {
      const suggestions = [
        {
          getId: () => 'sugg-faq-new',
          getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
          getData: () => ({
            url: 'https://www.example.com/page',
            headingText: 'FAQs',
            shouldOptimize: true,
            item: {
              question: 'New question?',
              answer: 'New answer.',
            },
            transformRules: {
              action: 'appendChild',
              selector: 'main',
            },
          }),
        },
      ];

      const patches = mapper.suggestionsToPatches('/page', suggestions, 'opp-faq-123', null);

      expect(patches).to.be.an('array');
      expect(patches.length).to.equal(2); // heading + FAQ
    });

    it('should handle existing config with no existing patches for URL', () => {
      const suggestions = [
        {
          getId: () => 'sugg-faq-new',
          getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
          getData: () => ({
            url: 'https://www.example.com/page',
            headingText: 'FAQs',
            shouldOptimize: true,
            item: {
              question: 'New question?',
              answer: 'New answer.',
            },
            transformRules: {
              action: 'appendChild',
              selector: 'main',
            },
          }),
        },
      ];

      const patches = mapper.suggestionsToPatches('/page', suggestions, 'opp-faq-123', null);

      expect(patches).to.be.an('array');
      expect(patches.length).to.equal(2); // heading + FAQ
    });

    it('should handle error when checking existing config', () => {
      const suggestions = [
        {
          getId: () => 'sugg-faq-new',
          getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
          getData: () => ({
            url: 'https://www.example.com/page',
            headingText: 'FAQs',
            shouldOptimize: true,
            item: {
              question: 'New question?',
              answer: 'New answer.',
            },
            transformRules: {
              action: 'appendChild',
              selector: 'main',
            },
          }),
        },
      ];

      // Should handle error gracefully and still create patch
      const patches = mapper.suggestionsToPatches('/page', suggestions, 'opp-faq-123', null);

      expect(patches).to.be.an('array');
      expect(patches.length).to.equal(2); // heading + FAQ
    });

    it('should handle null URL when checking existing config', () => {
      const suggestions = [
        {
          getId: () => 'sugg-faq-new',
          getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
          getData: () => ({
            url: 'https://www.example.com/page',
            headingText: 'FAQs',
            shouldOptimize: true,
            item: {
              question: 'New question?',
              answer: 'New answer.',
            },
            transformRules: {
              action: 'appendChild',
              selector: 'main',
            },
          }),
        },
      ];

      const patches = mapper.suggestionsToPatches('/page', suggestions, 'opp-faq-123', null);

      expect(patches).to.be.an('array');
      expect(patches.length).to.equal(2); // heading + FAQ
    });

    it('should handle markdown to HAST conversion errors in suggestionsToPatches', () => {
      let errorCount = 0;
      const errorLog = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => { errorCount += 1; },
      };

      const errorMapper = new FaqMapper(errorLog);

      // Override buildFaqItemHast to throw an error
      const originalBuildFaqItemHast = errorMapper.buildFaqItemHast;
      errorMapper.buildFaqItemHast = () => {
        throw new Error('Markdown parsing failed');
      };

      const suggestions = [
        {
          getId: () => 'sugg-faq-error',
          getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
          getData: () => ({
            url: 'https://www.example.com/page',
            headingText: 'FAQs',
            shouldOptimize: true,
            item: {
              question: 'Question?',
              answer: 'Answer.',
            },
            transformRules: {
              action: 'appendChild',
              selector: 'main',
            },
          }),
        },
      ];

      const patches = errorMapper.suggestionsToPatches('/page', suggestions, 'opp-faq-error', null);

      expect(patches).to.be.an('array');
      expect(patches.length).to.equal(1); // Only heading, FAQ item fails
      expect(patches[0].value.tagName).to.equal('h2'); // Heading patch
      expect(errorCount).to.be.greaterThan(0);

      // Restore original method
      errorMapper.buildFaqItemHast = originalBuildFaqItemHast;
    });

    it('should handle existing config with urlOptimizations but no patches', () => {
      const suggestion = {
        getId: () => 'sugg-faq-1',
        getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
        getData: () => ({
          url: 'https://www.example.com/page',
          headingText: 'FAQs',
          shouldOptimize: true,
          item: {
            question: 'Question?',
            answer: 'Answer.',
          },
          transformRules: {
            action: 'appendChild',
            selector: 'main',
          },
        }),
      };

      // Config with urlOptimizations but no patches array
      const existingConfig = {
        tokowakaOptimizations: {
          '/page': {
            prerender: true,
            // No patches array
          },
        },
      };

      const patches = mapper.suggestionsToPatches('/page', [suggestion], 'opp-faq-123', existingConfig);

      expect(patches).to.be.an('array');
      expect(patches.length).to.equal(2); // heading + FAQ (both created)
      expect(patches[0].value.tagName).to.equal('h2'); // Heading
      expect(patches[1].value.tagName).to.equal('div'); // FAQ
    });
  });

  describe('canDeploy - new format', () => {
    it('should accept new format with item.question and item.answer', () => {
      const suggestion = {
        getData: () => ({
          item: {
            question: 'Is this the new format?',
            answer: 'Yes, it is.',
          },
          url: 'https://www.example.com/page',
          shouldOptimize: true,
          transformRules: {
            action: 'appendChild',
            selector: 'main',
          },
        }),
      };

      const result = mapper.canDeploy(suggestion);
      expect(result).to.deep.equal({ eligible: true });
    });

    it('should reject when item.question/answer is missing', () => {
      const suggestion = {
        getData: () => ({
          shouldOptimize: true,
          transformRules: {
            action: 'appendChild',
            selector: 'main',
          },
        }),
      };

      const result = mapper.canDeploy(suggestion);
      expect(result.eligible).to.be.false;
      expect(result.reason).to.include('item.question and item.answer are required');
    });
  });

  describe('tokowakaDeployed filtering', () => {
    it('should always create heading patch even when FAQ already deployed for URL', () => {
      const newSuggestion = {
        getId: () => 'sugg-new-1',
        getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
        getData: () => ({
          url: 'https://www.example.com/page',
          headingText: 'FAQs',
          shouldOptimize: true,
          item: {
            question: 'New question?',
            answer: 'New answer.',
          },
          transformRules: {
            action: 'appendChild',
            selector: 'main',
          },
        }),
      };

      // Mock existingConfig with heading already present
      const existingConfig = {
        tokowakaOptimizations: {
          '/page': {
            patches: [
              {
                opportunityId: 'opp-faq-123',
                lastUpdated: new Date('2025-01-01T00:00:00.000Z').getTime(),
                // No suggestionId = heading patch
                op: 'appendChild',
                selector: 'main',
                value: { type: 'element', tagName: 'h2', children: [{ type: 'text', value: 'FAQs' }] },
              },
            ],
          },
        },
      };

      const patches = mapper.suggestionsToPatches(
        '/page',
        [newSuggestion],
        'opp-faq-123',
        existingConfig,
      );

      expect(patches).to.be.an('array');
      expect(patches.length).to.equal(2); // Heading + FAQ (always create heading)

      // First patch: heading with updated timestamp
      expect(patches[0].suggestionId).to.be.undefined;
      expect(patches[0].value.tagName).to.equal('h2');
      expect(patches[0].lastUpdated).to.equal(new Date('2025-01-15T10:00:00.000Z').getTime());

      // Second patch: FAQ
      expect(patches[1].suggestionId).to.equal('sugg-new-1');
      expect(patches[1].value.tagName).to.equal('div');
      expect(patches[1].selector).to.equal('main');
      expect(patches[1].op).to.equal('appendChild');
    });

    it('should create heading when no patches exist for URL', () => {
      const newSuggestion = {
        getId: () => 'sugg-new-1',
        getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
        getData: () => ({
          url: 'https://www.example.com/page',
          headingText: 'FAQs',
          item: {
            question: 'New question?',
            answer: 'New answer.',
          },
          shouldOptimize: true,
          transformRules: {
            action: 'appendChild',
            selector: 'main',
          },
        }),
      };

      // Empty config - no patches
      const existingConfig = null;

      const patches = mapper.suggestionsToPatches(
        '/page',
        [newSuggestion],
        'opp-faq-123',
        existingConfig,
      );

      expect(patches).to.be.an('array');
      expect(patches.length).to.equal(2); // heading + FAQ

      // First should be heading
      expect(patches[0].suggestionId).to.be.undefined;
      expect(patches[0].value.tagName).to.equal('h2');

      // Second should be FAQ
      expect(patches[1].suggestionId).to.equal('sugg-new-1');
      expect(patches[1].value.tagName).to.equal('div');
      expect(patches[1].selector).to.equal('main');
    });

    it('should work without existing config parameter', () => {
      const newSuggestion = {
        getId: () => 'sugg-new-1',
        getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
        getData: () => ({
          url: 'https://www.example.com/page',
          headingText: 'FAQs',
          shouldOptimize: true,
          item: {
            question: 'New question?',
            answer: 'New answer.',
          },
          transformRules: {
            action: 'appendChild',
            selector: 'main',
          },
        }),
      };

      const patches = mapper.suggestionsToPatches(
        '/page',
        [newSuggestion],
        'opp-faq-123',
        null, // No existing config
      );

      expect(patches).to.be.an('array');
      expect(patches.length).to.equal(2); // heading + FAQ
      expect(patches[0].suggestionId).to.be.undefined; // heading
      expect(patches[1].suggestionId).to.equal('sugg-new-1'); // FAQ
    });

    it('should handle invalid existing config', () => {
      const newSuggestion = {
        getId: () => 'sugg-new-1',
        getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
        getData: () => ({
          url: 'https://www.example.com/page',
          headingText: 'FAQs',
          shouldOptimize: true,
          item: {
            question: 'New question?',
            answer: 'New answer.',
          },
          transformRules: {
            action: 'appendChild',
            selector: 'main',
          },
        }),
      };

      // Pass invalid config
      const patches = mapper.suggestionsToPatches(
        '/page',
        [newSuggestion],
        'opp-faq-123',
        'not-valid-config',
      );

      expect(patches).to.be.an('array');
      expect(patches.length).to.equal(2); // heading + FAQ
      expect(patches[0].suggestionId).to.be.undefined; // heading
      expect(patches[1].suggestionId).to.equal('sugg-new-1'); // FAQ
    });
  });

  describe('rollbackPatches', () => {
    it('should remove FAQ heading when last FAQ suggestion is rolled back', () => {
      const config = {
        url: 'https://example.com/page1',
        version: '1.0',
        forceFail: false,
        prerender: true,
        patches: [
          {
            opportunityId: 'opp-faq',
            // FAQ heading patch (no suggestionId)
            op: 'appendChild',
            selector: 'body',
            value: { type: 'element', tagName: 'h2', children: [{ type: 'text', value: 'FAQs' }] },
          },
          {
            opportunityId: 'opp-faq',
            suggestionId: 'sugg-1',
            op: 'appendChild',
            value: { type: 'element', tagName: 'div' },
          },
        ],
      };

      const result = mapper.rollbackPatches(config, ['sugg-1'], 'opp-faq');

      // Both FAQ item and heading should be removed
      expect(result.patches).to.have.lengthOf(0);
      expect(result.removedCount).to.equal(2);
    });

    it('should keep FAQ heading when other FAQ suggestions remain', () => {
      const config = {
        url: 'https://example.com/page1',
        version: '1.0',
        forceFail: false,
        prerender: true,
        patches: [
          {
            opportunityId: 'opp-faq',
            // FAQ heading patch
            op: 'appendChild',
            selector: 'body',
            value: { type: 'element', tagName: 'h2', children: [{ type: 'text', value: 'FAQs' }] },
          },
          {
            opportunityId: 'opp-faq',
            suggestionId: 'sugg-1',
            op: 'appendChild',
            value: { type: 'element', tagName: 'div' },
          },
          {
            opportunityId: 'opp-faq',
            suggestionId: 'sugg-2',
            op: 'appendChild',
            value: { type: 'element', tagName: 'div' },
          },
        ],
      };

      const result = mapper.rollbackPatches(config, ['sugg-1'], 'opp-faq');

      // Only sugg-1 removed, heading and sugg-2 remain
      expect(result.patches).to.have.lengthOf(2);
      expect(result.patches[0]).to.not.have.property('suggestionId'); // Heading
      expect(result.patches[1].suggestionId).to.equal('sugg-2');
      expect(result.removedCount).to.equal(1);
    });

    it('should handle multiple URLs independently', () => {
      // Note: With the new per-URL architecture, each URL has its own config
      // This test validates that rollback works correctly for a single URL config
      const config = {
        url: 'https://example.com/page1',
        version: '1.0',
        forceFail: false,
        prerender: true,
        patches: [
          { opportunityId: 'opp-faq', op: 'appendChild', value: 'FAQs' },
          {
            opportunityId: 'opp-faq',
            suggestionId: 'sugg-1',
            op: 'appendChild',
            value: 'FAQ1',
          },
        ],
      };

      const result = mapper.rollbackPatches(config, ['sugg-1'], 'opp-faq');

      // All patches removed (heading + FAQ item)
      expect(result.patches).to.have.lengthOf(0);
      expect(result.removedCount).to.equal(2);
    });

    it('should handle null/undefined config gracefully', () => {
      const result1 = mapper.rollbackPatches(null, ['sugg-1'], 'opp-faq');
      expect(result1).to.be.null;

      const result2 = mapper.rollbackPatches(undefined, ['sugg-1'], 'opp-faq');
      expect(result2).to.be.undefined;
    });
  });
});
