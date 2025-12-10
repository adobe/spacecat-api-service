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
import GenericMapper from '../../src/mappers/generic-mapper.js';

describe('GenericMapper', () => {
  let mapper;
  let log;

  beforeEach(() => {
    log = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    };
    mapper = new GenericMapper(log);
  });

  describe('getOpportunityType', () => {
    it('should return generic', () => {
      expect(mapper.getOpportunityType()).to.equal('generic-autofix-edge');
    });
  });

  describe('requiresPrerender', () => {
    it('should return true', () => {
      expect(mapper.requiresPrerender()).to.be.true;
    });
  });

  describe('canDeploy', () => {
    it('should return eligible for valid suggestion with all required fields', () => {
      const suggestion = {
        getData: () => ({
          transformRules: {
            action: 'insertAfter',
            selector: '#create-with-multiple-top-ai-models-all-in-one-place',
          },
          patchValue: 'Blah Blah some text',
          url: 'https://www.adobe.com/products/firefly.html',
        }),
      };

      const result = mapper.canDeploy(suggestion);

      expect(result).to.deep.equal({ eligible: true });
    });

    it('should return eligible for insertBefore operation', () => {
      const suggestion = {
        getData: () => ({
          transformRules: {
            action: 'insertBefore',
            selector: 'h1',
          },
          patchValue: 'New content',
          url: 'https://example.com/page',
        }),
      };

      const result = mapper.canDeploy(suggestion);

      expect(result).to.deep.equal({ eligible: true });
    });

    it('should return eligible for replace operation', () => {
      const suggestion = {
        getData: () => ({
          transformRules: {
            action: 'replace',
            selector: '.content',
          },
          patchValue: 'Replaced content',
          url: 'https://example.com/page',
        }),
      };

      const result = mapper.canDeploy(suggestion);

      expect(result).to.deep.equal({ eligible: true });
    });

    it('should return ineligible when transformRules is missing', () => {
      const suggestion = {
        getData: () => ({
          patchValue: 'Some text',
          url: 'https://example.com/page',
        }),
      };

      const result = mapper.canDeploy(suggestion);

      expect(result).to.deep.equal({
        eligible: false,
        reason: 'transformRules is required',
      });
    });

    it('should return ineligible when selector is missing', () => {
      const suggestion = {
        getData: () => ({
          transformRules: {
            action: 'insertAfter',
          },
          patchValue: 'Some text',
          url: 'https://example.com/page',
        }),
      };

      const result = mapper.canDeploy(suggestion);

      expect(result).to.deep.equal({
        eligible: false,
        reason: 'transformRules.selector is required',
      });
    });

    it('should return ineligible when selector is empty string', () => {
      const suggestion = {
        getData: () => ({
          transformRules: {
            action: 'insertAfter',
            selector: '',
          },
          patchValue: 'Some text',
          url: 'https://example.com/page',
        }),
      };

      const result = mapper.canDeploy(suggestion);

      expect(result).to.deep.equal({
        eligible: false,
        reason: 'transformRules.selector is required',
      });
    });

    it('should return ineligible when patchValue is missing', () => {
      const suggestion = {
        getData: () => ({
          transformRules: {
            action: 'insertAfter',
            selector: '#selector',
          },
          url: 'https://example.com/page',
        }),
      };

      const result = mapper.canDeploy(suggestion);

      expect(result).to.deep.equal({
        eligible: false,
        reason: 'patchValue is required',
      });
    });

    it('should return ineligible when patchValue is empty string', () => {
      const suggestion = {
        getData: () => ({
          transformRules: {
            action: 'insertAfter',
            selector: '#selector',
          },
          patchValue: '',
          url: 'https://example.com/page',
        }),
      };

      const result = mapper.canDeploy(suggestion);

      expect(result).to.deep.equal({
        eligible: false,
        reason: 'patchValue is required',
      });
    });

    it('should return ineligible when action is missing', () => {
      const suggestion = {
        getData: () => ({
          transformRules: {
            selector: '#selector',
          },
          patchValue: 'Some text',
          url: 'https://example.com/page',
        }),
      };

      const result = mapper.canDeploy(suggestion);

      expect(result).to.deep.equal({
        eligible: false,
        reason: 'transformRules.action is required',
      });
    });

    it('should return ineligible when action is empty string', () => {
      const suggestion = {
        getData: () => ({
          transformRules: {
            action: '',
            selector: '#selector',
          },
          patchValue: 'Some text',
          url: 'https://example.com/page',
        }),
      };

      const result = mapper.canDeploy(suggestion);

      expect(result).to.deep.equal({
        eligible: false,
        reason: 'transformRules.action is required',
      });
    });

    it('should return ineligible when action is invalid', () => {
      const suggestion = {
        getData: () => ({
          transformRules: {
            action: 'invalidOperation',
            selector: '#selector',
          },
          patchValue: 'Some text',
          url: 'https://example.com/page',
        }),
      };

      const result = mapper.canDeploy(suggestion);

      expect(result).to.deep.equal({
        eligible: false,
        reason: 'transformRules.action must be one of: insertBefore, insertAfter, replace. Got: invalidOperation',
      });
    });

    it('should return ineligible when url is missing', () => {
      const suggestion = {
        getData: () => ({
          transformRules: {
            action: 'insertAfter',
            selector: '#selector',
          },
          patchValue: 'Some text',
        }),
      };

      const result = mapper.canDeploy(suggestion);

      expect(result).to.deep.equal({
        eligible: false,
        reason: 'url is required',
      });
    });

    it('should return ineligible when url is empty string', () => {
      const suggestion = {
        getData: () => ({
          transformRules: {
            action: 'insertAfter',
            selector: '#selector',
          },
          patchValue: 'Some text',
          url: '',
        }),
      };

      const result = mapper.canDeploy(suggestion);

      expect(result).to.deep.equal({
        eligible: false,
        reason: 'url is required',
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

    it('should return ineligible when data is undefined', () => {
      const suggestion = {
        getData: () => undefined,
      };

      const result = mapper.canDeploy(suggestion);

      expect(result).to.deep.equal({
        eligible: false,
        reason: 'transformRules is required',
      });
    });
  });

  describe('suggestionsToPatches', () => {
    it('should create patch for valid suggestion with insertAfter', () => {
      const suggestion = {
        getId: () => 'ee8fc5e8-29c1-4894-9391-efc10b8a5f5c',
        getUpdatedAt: () => '2025-11-27T16:22:14.258Z',
        getData: () => ({
          transformRules: {
            action: 'insertAfter',
            selector: '#create-with-multiple-top-ai-models-all-in-one-place',
          },
          patchValue: 'Blah Blah some text',
          url: 'https://www.adobe.com/products/firefly.html',
          contentBefore: '**Create with multiple top AI models, all in one place.**',
          rationale: 'This makes LLMs read more text about blah blah.',
        }),
      };

      const patches = mapper.suggestionsToPatches(
        '/products/firefly.html',
        [suggestion],
        '7a663e47-e132-4bba-954a-26419e0541b8',
      );

      expect(patches.length).to.equal(1);
      const patch = patches[0];

      expect(patch).to.deep.include({
        op: 'insertAfter',
        selector: '#create-with-multiple-top-ai-models-all-in-one-place',
        value: 'Blah Blah some text',
        valueFormat: 'text',
        opportunityId: '7a663e47-e132-4bba-954a-26419e0541b8',
        suggestionId: 'ee8fc5e8-29c1-4894-9391-efc10b8a5f5c',
        prerenderRequired: true,
      });
      expect(patch.lastUpdated).to.be.a('number');
      expect(patch.target).to.equal('ai-bots');
    });

    it('should create patch for insertBefore operation', () => {
      const suggestion = {
        getId: () => 'sugg-123',
        getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
        getData: () => ({
          transformRules: {
            action: 'insertBefore',
            selector: 'h1',
          },
          patchValue: 'Important notice',
          url: 'https://example.com/page',
        }),
      };

      const patches = mapper.suggestionsToPatches('/page', [suggestion], 'opp-123');

      expect(patches.length).to.equal(1);
      const patch = patches[0];

      expect(patch).to.deep.include({
        op: 'insertBefore',
        selector: 'h1',
        value: 'Important notice',
        valueFormat: 'text',
        opportunityId: 'opp-123',
        suggestionId: 'sugg-123',
        prerenderRequired: true,
      });
      expect(patch.lastUpdated).to.be.a('number');
    });

    it('should create patch for replace operation', () => {
      const suggestion = {
        getId: () => 'sugg-456',
        getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
        getData: () => ({
          transformRules: {
            action: 'replace',
            selector: '.content',
          },
          patchValue: 'Replaced content text',
          url: 'https://example.com/page2',
        }),
      };

      const patches = mapper.suggestionsToPatches('/page2', [suggestion], 'opp-456');

      expect(patches.length).to.equal(1);
      const patch = patches[0];

      expect(patch).to.deep.include({
        op: 'replace',
        selector: '.content',
        value: 'Replaced content text',
        valueFormat: 'text',
        opportunityId: 'opp-456',
        suggestionId: 'sugg-456',
        prerenderRequired: true,
      });
      expect(patch.lastUpdated).to.be.a('number');
    });

    it('should handle multiple suggestions', () => {
      const suggestions = [
        {
          getId: () => 'sugg-1',
          getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
          getData: () => ({
            transformRules: {
              action: 'insertAfter',
              selector: '#selector1',
            },
            patchValue: 'Text 1',
            url: 'https://example.com/page',
          }),
        },
        {
          getId: () => 'sugg-2',
          getUpdatedAt: () => '2025-01-15T11:00:00.000Z',
          getData: () => ({
            transformRules: {
              action: 'insertBefore',
              selector: '#selector2',
            },
            patchValue: 'Text 2',
            url: 'https://example.com/page',
          }),
        },
      ];

      const patches = mapper.suggestionsToPatches('/page', suggestions, 'opp-123');

      expect(patches.length).to.equal(2);
      expect(patches[0].suggestionId).to.equal('sugg-1');
      expect(patches[0].value).to.equal('Text 1');
      expect(patches[1].suggestionId).to.equal('sugg-2');
      expect(patches[1].value).to.equal('Text 2');
    });

    it('should return empty array for invalid suggestion', () => {
      const suggestion = {
        getId: () => 'sugg-invalid',
        getData: () => ({
          transformRules: {
            action: 'insertAfter',
            selector: '#selector',
          },
          // Missing patchValue
          url: 'https://example.com/page',
        }),
      };

      const patches = mapper.suggestionsToPatches('/page', [suggestion], 'opp-invalid');

      expect(patches.length).to.equal(0);
    });

    it('should skip invalid suggestions but process valid ones', () => {
      const suggestions = [
        {
          getId: () => 'sugg-valid',
          getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
          getData: () => ({
            transformRules: {
              action: 'insertAfter',
              selector: '#valid',
            },
            patchValue: 'Valid text',
            url: 'https://example.com/page',
          }),
        },
        {
          getId: () => 'sugg-invalid',
          getData: () => ({
            transformRules: {
              action: 'insertAfter',
              selector: '#invalid',
            },
            // Missing patchValue
            url: 'https://example.com/page',
          }),
        },
      ];

      const patches = mapper.suggestionsToPatches('/page', suggestions, 'opp-123');

      expect(patches.length).to.equal(1);
      expect(patches[0].suggestionId).to.equal('sugg-valid');
    });

    it('should log warning for invalid suggestion', () => {
      let warnMessage = '';
      const warnLog = {
        debug: () => {},
        info: () => {},
        warn: (msg) => { warnMessage = msg; },
        error: () => {},
      };
      const warnMapper = new GenericMapper(warnLog);

      const suggestion = {
        getId: () => 'sugg-warn',
        getData: () => ({
          transformRules: {
            action: 'insertAfter',
            selector: '#selector',
          },
          // Missing patchValue
          url: 'https://example.com/page',
        }),
      };

      const patches = warnMapper.suggestionsToPatches('/page', [suggestion], 'opp-warn');

      expect(patches.length).to.equal(0);
      expect(warnMessage).to.include('Generic suggestion sugg-warn cannot be deployed');
      expect(warnMessage).to.include('patchValue is required');
    });

    it('should handle complex CSS selectors', () => {
      const suggestion = {
        getId: () => 'sugg-complex',
        getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
        getData: () => ({
          transformRules: {
            action: 'insertAfter',
            selector: '#text-85a9876220 > h2:nth-of-type(1)',
          },
          patchValue: 'Complex selector content',
          url: 'https://example.com/page',
        }),
      };

      const patches = mapper.suggestionsToPatches('/page', [suggestion], 'opp-complex');

      expect(patches.length).to.equal(1);
      expect(patches[0].selector).to.equal('#text-85a9876220 > h2:nth-of-type(1)');
    });

    it('should handle multiline patchValue', () => {
      const suggestion = {
        getId: () => 'sugg-multiline',
        getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
        getData: () => ({
          transformRules: {
            action: 'replace',
            selector: '.content',
          },
          patchValue: 'Line 1\nLine 2\nLine 3',
          url: 'https://example.com/page',
        }),
      };

      const patches = mapper.suggestionsToPatches('/page', [suggestion], 'opp-multiline');

      expect(patches.length).to.equal(1);
      expect(patches[0].value).to.equal('Line 1\nLine 2\nLine 3');
    });

    it('should include tag when provided', () => {
      const suggestion = {
        getId: () => 'sugg-with-tag',
        getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
        getData: () => ({
          transformRules: {
            action: 'insertAfter',
            selector: '#selector',
          },
          patchValue: 'Content with tag',
          format: 'hast',
          tag: 'div',
          url: 'https://example.com/page',
        }),
      };

      const patches = mapper.suggestionsToPatches('/page', [suggestion], 'opp-tag');

      expect(patches.length).to.equal(1);
      const patch = patches[0];

      expect(patch).to.deep.include({
        op: 'insertAfter',
        selector: '#selector',
        value: 'Content with tag',
        valueFormat: 'hast',
        tag: 'div',
        opportunityId: 'opp-tag',
        suggestionId: 'sugg-with-tag',
        prerenderRequired: true,
      });
      expect(patch.lastUpdated).to.be.a('number');
    });

    it('should not include tag when not provided', () => {
      const suggestion = {
        getId: () => 'sugg-no-tag',
        getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
        getData: () => ({
          transformRules: {
            action: 'insertAfter',
            selector: '#selector',
          },
          patchValue: 'Content without tag',
          url: 'https://example.com/page',
        }),
      };

      const patches = mapper.suggestionsToPatches('/page', [suggestion], 'opp-no-tag');

      expect(patches.length).to.equal(1);
      const patch = patches[0];

      expect(patch.tag).to.be.undefined;
      expect(patch.valueFormat).to.equal('text');
    });

    it('should not include UI-only fields in patch', () => {
      const suggestion = {
        getId: () => 'sugg-ui',
        getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
        getData: () => ({
          transformRules: {
            action: 'insertAfter',
            selector: '#selector',
          },
          patchValue: 'Text content',
          url: 'https://example.com/page',
          contentBefore: 'Original content',
          expectedContentAfter: 'Expected result',
          rationale: 'This improves SEO',
          aggregationKey: 'some-key',
        }),
      };

      const patches = mapper.suggestionsToPatches('/page', [suggestion], 'opp-ui');

      expect(patches.length).to.equal(1);
      const patch = patches[0];

      // Should not include UI-only fields
      expect(patch.contentBefore).to.be.undefined;
      expect(patch.expectedContentAfter).to.be.undefined;
      expect(patch.rationale).to.be.undefined;
      expect(patch.aggregationKey).to.be.undefined;

      // Should include only operational fields
      expect(patch.op).to.equal('insertAfter');
      expect(patch.selector).to.equal('#selector');
      expect(patch.value).to.equal('Text content');
    });
  });
});
