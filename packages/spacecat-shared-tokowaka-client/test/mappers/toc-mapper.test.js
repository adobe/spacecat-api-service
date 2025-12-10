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
import TocMapper from '../../src/mappers/toc-mapper.js';

describe('TocMapper', () => {
  let mapper;
  let log;

  beforeEach(() => {
    log = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    };
    mapper = new TocMapper(log);
  });

  describe('getOpportunityType', () => {
    it('should return toc', () => {
      expect(mapper.getOpportunityType()).to.equal('toc');
    });
  });

  describe('requiresPrerender', () => {
    it('should return true', () => {
      expect(mapper.requiresPrerender()).to.be.true;
    });
  });

  describe('canDeploy', () => {
    it('should return eligible for valid toc suggestion with insertAfter', () => {
      const suggestion = {
        getData: () => ({
          checkType: 'toc',
          transformRules: {
            action: 'insertAfter',
            selector: 'h1#main-heading',
            valueFormat: 'hast',
            value: {
              type: 'root',
              children: [
                {
                  type: 'element',
                  tagName: 'nav',
                  properties: { className: ['toc'] },
                  children: [],
                },
              ],
            },
          },
        }),
      };

      const result = mapper.canDeploy(suggestion);

      expect(result).to.deep.equal({ eligible: true });
    });

    it('should return eligible for valid toc suggestion with insertBefore', () => {
      const suggestion = {
        getData: () => ({
          checkType: 'toc',
          transformRules: {
            action: 'insertBefore',
            selector: 'main',
            valueFormat: 'hast',
            value: {
              type: 'root',
              children: [
                {
                  type: 'element',
                  tagName: 'nav',
                  properties: { className: ['toc'] },
                  children: [],
                },
              ],
            },
          },
        }),
      };

      const result = mapper.canDeploy(suggestion);

      expect(result).to.deep.equal({ eligible: true });
    });

    it('should return ineligible for non-toc checkType', () => {
      const suggestion = {
        getData: () => ({
          checkType: 'heading-empty',
          transformRules: {
            action: 'insertAfter',
            selector: 'h1',
            valueFormat: 'hast',
            value: {},
          },
        }),
      };

      const result = mapper.canDeploy(suggestion);

      expect(result).to.deep.equal({
        eligible: false,
        reason: 'Only toc checkType can be deployed. This suggestion has checkType: heading-empty',
      });
    });

    it('should return ineligible when checkType is missing', () => {
      const suggestion = {
        getData: () => ({
          transformRules: {
            action: 'insertAfter',
            selector: 'h1',
            valueFormat: 'hast',
            value: {},
          },
        }),
      };

      const result = mapper.canDeploy(suggestion);

      expect(result).to.deep.equal({
        eligible: false,
        reason: 'Only toc checkType can be deployed. This suggestion has checkType: undefined',
      });
    });

    it('should return ineligible when data is null', () => {
      const suggestion = {
        getData: () => null,
      };

      const result = mapper.canDeploy(suggestion);

      expect(result).to.deep.equal({
        eligible: false,
        reason: 'Only toc checkType can be deployed. This suggestion has checkType: undefined',
      });
    });

    it('should return ineligible when transformRules.selector is missing', () => {
      const suggestion = {
        getData: () => ({
          checkType: 'toc',
          transformRules: {
            action: 'insertAfter',
            valueFormat: 'hast',
            value: {},
          },
        }),
      };

      const result = mapper.canDeploy(suggestion);

      expect(result).to.deep.equal({
        eligible: false,
        reason: 'transformRules.selector is required',
      });
    });

    it('should return ineligible when transformRules.selector is empty string', () => {
      const suggestion = {
        getData: () => ({
          checkType: 'toc',
          transformRules: {
            action: 'insertAfter',
            selector: '',
            valueFormat: 'hast',
            value: {},
          },
        }),
      };

      const result = mapper.canDeploy(suggestion);

      expect(result).to.deep.equal({
        eligible: false,
        reason: 'transformRules.selector is required',
      });
    });

    it('should return ineligible when transformRules.value is missing', () => {
      const suggestion = {
        getData: () => ({
          checkType: 'toc',
          transformRules: {
            action: 'insertAfter',
            selector: 'h1',
            valueFormat: 'hast',
          },
        }),
      };

      const result = mapper.canDeploy(suggestion);

      expect(result).to.deep.equal({
        eligible: false,
        reason: 'transformRules.value is required',
      });
    });

    it('should return ineligible when transformRules.valueFormat is not hast', () => {
      const suggestion = {
        getData: () => ({
          checkType: 'toc',
          transformRules: {
            action: 'insertAfter',
            selector: 'h1',
            valueFormat: 'text',
            value: 'some text',
          },
        }),
      };

      const result = mapper.canDeploy(suggestion);

      expect(result).to.deep.equal({
        eligible: false,
        reason: 'transformRules.valueFormat must be hast for toc',
      });
    });

    it('should return ineligible when transformRules.valueFormat is missing', () => {
      const suggestion = {
        getData: () => ({
          checkType: 'toc',
          transformRules: {
            action: 'insertAfter',
            selector: 'h1',
            value: {},
          },
        }),
      };

      const result = mapper.canDeploy(suggestion);

      expect(result).to.deep.equal({
        eligible: false,
        reason: 'transformRules.valueFormat must be hast for toc',
      });
    });

    it('should return ineligible when action is invalid', () => {
      const suggestion = {
        getData: () => ({
          checkType: 'toc',
          transformRules: {
            action: 'replace',
            selector: 'h1',
            valueFormat: 'hast',
            value: {},
          },
        }),
      };

      const result = mapper.canDeploy(suggestion);

      expect(result).to.deep.equal({
        eligible: false,
        reason: 'transformRules.action must be one of insertBefore, insertAfter for toc',
      });
    });

    it('should return ineligible when action is missing', () => {
      const suggestion = {
        getData: () => ({
          checkType: 'toc',
          transformRules: {
            selector: 'h1',
            valueFormat: 'hast',
            value: {},
          },
        }),
      };

      const result = mapper.canDeploy(suggestion);

      expect(result).to.deep.equal({
        eligible: false,
        reason: 'transformRules.action must be one of insertBefore, insertAfter for toc',
      });
    });
  });

  describe('suggestionsToPatches', () => {
    it('should create patch for valid toc suggestion with insertAfter', () => {
      const tocValue = {
        type: 'root',
        children: [
          {
            type: 'element',
            tagName: 'nav',
            properties: { className: ['toc'] },
            children: [
              {
                type: 'element',
                tagName: 'ul',
                children: [
                  {
                    type: 'element',
                    tagName: 'li',
                    children: [
                      {
                        type: 'element',
                        tagName: 'a',
                        properties: { href: '#section1' },
                        children: [{ type: 'text', value: 'Section 1' }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };

      const suggestion = {
        getId: () => 'sugg-toc-1',
        getUpdatedAt: () => '2025-12-09T10:00:00.000Z',
        getData: () => ({
          checkType: 'toc',
          recommendedAction: 'Add a Table of Contents to the page',
          transformRules: {
            action: 'insertAfter',
            selector: 'h1#main-heading',
            valueFormat: 'hast',
            value: tocValue,
            scrapedAt: '2025-12-06T06:27:04.663Z',
          },
        }),
      };

      const patches = mapper.suggestionsToPatches('/path', [suggestion], 'opp-toc-1');
      expect(patches.length).to.equal(1);
      const patch = patches[0];

      expect(patch).to.deep.include({
        op: 'insertAfter',
        selector: 'h1#main-heading',
        value: tocValue,
        valueFormat: 'hast',
        opportunityId: 'opp-toc-1',
        suggestionId: 'sugg-toc-1',
        prerenderRequired: true,
      });
      expect(patch.lastUpdated).to.be.a('number');
      expect(patch.target).to.equal('ai-bots');
    });

    it('should create patch for valid toc suggestion with insertBefore', () => {
      const tocValue = {
        type: 'root',
        children: [
          {
            type: 'element',
            tagName: 'nav',
            properties: { className: ['toc'] },
            children: [],
          },
        ],
      };

      const suggestion = {
        getId: () => 'sugg-toc-2',
        getUpdatedAt: () => '2025-12-09T10:00:00.000Z',
        getData: () => ({
          checkType: 'toc',
          transformRules: {
            action: 'insertBefore',
            selector: 'main',
            valueFormat: 'hast',
            value: tocValue,
          },
        }),
      };

      const patches = mapper.suggestionsToPatches('/path', [suggestion], 'opp-toc-2');
      expect(patches.length).to.equal(1);
      const patch = patches[0];

      expect(patch).to.deep.include({
        op: 'insertBefore',
        selector: 'main',
        value: tocValue,
        valueFormat: 'hast',
        opportunityId: 'opp-toc-2',
        suggestionId: 'sugg-toc-2',
        prerenderRequired: true,
      });
      expect(patch.lastUpdated).to.be.a('number');
    });

    it('should create patch with complex nested toc structure', () => {
      const complexTocValue = {
        type: 'root',
        children: [
          {
            type: 'element',
            tagName: 'nav',
            properties: { className: ['toc'] },
            children: [
              {
                type: 'element',
                tagName: 'ul',
                children: [
                  {
                    type: 'element',
                    tagName: 'li',
                    children: [
                      {
                        type: 'element',
                        tagName: 'a',
                        properties: {
                          'data-selector': 'h1#main-title',
                          href: '#',
                        },
                        children: [{ type: 'text', value: 'Main Title' }],
                      },
                    ],
                  },
                  {
                    type: 'element',
                    tagName: 'li',
                    properties: { className: ['toc-sub'] },
                    children: [
                      {
                        type: 'element',
                        tagName: 'a',
                        properties: {
                          'data-selector': 'h2#section-1',
                          href: '#',
                        },
                        children: [{ type: 'text', value: 'Section 1' }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };

      const suggestion = {
        getId: () => 'sugg-toc-3',
        getUpdatedAt: () => '2025-12-09T10:00:00.000Z',
        getData: () => ({
          checkType: 'toc',
          transformRules: {
            action: 'insertAfter',
            selector: 'h1#heartfelt-birthday-wishes-for-brothers',
            valueFormat: 'hast',
            value: complexTocValue,
          },
        }),
      };

      const patches = mapper.suggestionsToPatches('/path', [suggestion], 'opp-toc-3');
      expect(patches.length).to.equal(1);
      const patch = patches[0];

      expect(patch.value).to.deep.equal(complexTocValue);
      expect(patch.op).to.equal('insertAfter');
    });

    it('should return empty array for invalid toc suggestion', () => {
      const suggestion = {
        getId: () => 'sugg-invalid',
        getData: () => ({
          checkType: 'toc',
          transformRules: {
            action: 'replace', // Invalid action
            selector: 'h1',
            valueFormat: 'hast',
            value: {},
          },
        }),
      };

      const patches = mapper.suggestionsToPatches('/path', [suggestion], 'opp-invalid');
      expect(patches.length).to.equal(0);
    });

    it('should return empty array when transformRules is missing', () => {
      const suggestion = {
        getId: () => 'sugg-no-rules',
        getData: () => ({
          checkType: 'toc',
        }),
      };

      const patches = mapper.suggestionsToPatches('/path', [suggestion], 'opp-no-rules');
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
      const warnMapper = new TocMapper(warnLog);

      const suggestion = {
        getId: () => 'sugg-warn',
        getData: () => ({
          checkType: 'toc',
          transformRules: {
            action: 'replace', // Invalid
            selector: 'h1',
            valueFormat: 'hast',
            value: {},
          },
        }),
      };

      const patches = warnMapper.suggestionsToPatches('/path', [suggestion], 'opp-warn');

      expect(patches.length).to.equal(0);
      expect(warnMessage).to.include('cannot be deployed');
      expect(warnMessage).to.include('sugg-warn');
    });

    it('should handle multiple suggestions', () => {
      const tocValue1 = { type: 'root', children: [] };
      const tocValue2 = { type: 'root', children: [] };

      const suggestions = [
        {
          getId: () => 'sugg-multi-1',
          getUpdatedAt: () => '2025-12-09T10:00:00.000Z',
          getData: () => ({
            checkType: 'toc',
            transformRules: {
              action: 'insertAfter',
              selector: 'h1',
              valueFormat: 'hast',
              value: tocValue1,
            },
          }),
        },
        {
          getId: () => 'sugg-multi-2',
          getUpdatedAt: () => '2025-12-09T10:00:00.000Z',
          getData: () => ({
            checkType: 'toc',
            transformRules: {
              action: 'insertBefore',
              selector: 'main',
              valueFormat: 'hast',
              value: tocValue2,
            },
          }),
        },
      ];

      const patches = mapper.suggestionsToPatches('/path', suggestions, 'opp-multi');
      expect(patches.length).to.equal(2);
      expect(patches[0].suggestionId).to.equal('sugg-multi-1');
      expect(patches[1].suggestionId).to.equal('sugg-multi-2');
    });

    it('should filter out invalid suggestions from multiple suggestions', () => {
      const tocValue = { type: 'root', children: [] };

      const suggestions = [
        {
          getId: () => 'sugg-valid',
          getUpdatedAt: () => '2025-12-09T10:00:00.000Z',
          getData: () => ({
            checkType: 'toc',
            transformRules: {
              action: 'insertAfter',
              selector: 'h1',
              valueFormat: 'hast',
              value: tocValue,
            },
          }),
        },
        {
          getId: () => 'sugg-invalid',
          getData: () => ({
            checkType: 'toc',
            transformRules: {
              action: 'replace', // Invalid
              selector: 'h1',
              valueFormat: 'hast',
              value: tocValue,
            },
          }),
        },
      ];

      const patches = mapper.suggestionsToPatches('/path', suggestions, 'opp-mixed');
      expect(patches.length).to.equal(1);
      expect(patches[0].suggestionId).to.equal('sugg-valid');
    });
  });
});
