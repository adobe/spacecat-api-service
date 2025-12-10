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
import { mergePatches, removePatchesBySuggestionIds } from '../../src/utils/patch-utils.js';

describe('Patch Utils', () => {
  describe('mergePatches', () => {
    it('should merge individual patches with same key', () => {
      const existingPatches = [
        {
          opportunityId: 'opp-1',
          suggestionId: 'sugg-1',
          op: 'replace',
          value: 'old-value',
        },
      ];

      const newPatches = [
        {
          opportunityId: 'opp-1',
          suggestionId: 'sugg-1',
          op: 'replace',
          value: 'new-value',
        },
      ];

      const result = mergePatches(existingPatches, newPatches);

      expect(result.patches).to.have.lengthOf(1);
      expect(result.patches[0].value).to.equal('new-value');
      expect(result.updateCount).to.equal(1);
      expect(result.addCount).to.equal(0);
    });

    it('should keep individual patches with different keys', () => {
      const existingPatches = [
        {
          opportunityId: 'opp-1',
          suggestionId: 'sugg-1',
          op: 'replace',
          value: 'value-1',
        },
      ];

      const newPatches = [
        {
          opportunityId: 'opp-1',
          suggestionId: 'sugg-2',
          op: 'replace',
          value: 'value-2',
        },
      ];

      const result = mergePatches(existingPatches, newPatches);

      expect(result.patches).to.have.lengthOf(2);
      expect(result.updateCount).to.equal(0);
      expect(result.addCount).to.equal(1);
    });

    it('should handle empty existing patches', () => {
      const existingPatches = [];
      const newPatches = [
        {
          opportunityId: 'opp-1',
          suggestionId: 'sugg-1',
          op: 'replace',
          value: 'value-1',
        },
      ];

      const result = mergePatches(existingPatches, newPatches);

      expect(result.patches).to.have.lengthOf(1);
      expect(result.updateCount).to.equal(0);
      expect(result.addCount).to.equal(1);
    });

    it('should handle empty new patches', () => {
      const existingPatches = [
        {
          opportunityId: 'opp-1',
          suggestionId: 'sugg-1',
          op: 'replace',
          value: 'value-1',
        },
      ];
      const newPatches = [];

      const result = mergePatches(existingPatches, newPatches);

      expect(result.patches).to.have.lengthOf(1);
      expect(result.updateCount).to.equal(0);
      expect(result.addCount).to.equal(0);
    });

    it('should handle patch without suggestionId (heading patch)', () => {
      const existingPatches = [
        {
          opportunityId: 'opp-faq',
          op: 'appendChild',
          value: 'Old Heading',
        },
      ];

      const newPatches = [
        {
          opportunityId: 'opp-faq',
          op: 'appendChild',
          value: 'New Heading',
        },
      ];

      const result = mergePatches(existingPatches, newPatches);

      expect(result.patches).to.have.lengthOf(1);
      expect(result.patches[0].value).to.equal('New Heading');
      expect(result.updateCount).to.equal(1);
      expect(result.addCount).to.equal(0);
    });

    it('should merge heading patches with same opportunityId', () => {
      const existingPatches = [
        {
          opportunityId: 'opp-faq',
          op: 'appendChild',
          value: 'Heading',
        },
        {
          opportunityId: 'opp-faq',
          suggestionId: 'sugg-1',
          op: 'appendChild',
          value: 'FAQ 1',
        },
      ];

      const newPatches = [
        {
          opportunityId: 'opp-faq',
          op: 'appendChild',
          value: 'Updated Heading',
        },
        {
          opportunityId: 'opp-faq',
          suggestionId: 'sugg-2',
          op: 'appendChild',
          value: 'FAQ 2',
        },
      ];

      const result = mergePatches(existingPatches, newPatches);

      expect(result.patches).to.have.lengthOf(3);
      expect(result.patches[0].value).to.equal('Updated Heading');
      expect(result.updateCount).to.equal(1);
      expect(result.addCount).to.equal(1);
    });
  });

  describe('removePatchesBySuggestionIds', () => {
    it('should remove patches with matching suggestion IDs', () => {
      const config = {
        url: 'https://example.com/page1',
        version: '1.0',
        forceFail: false,
        prerender: true,
        patches: [
          {
            opportunityId: 'opp-1',
            suggestionId: 'sugg-1',
            op: 'replace',
            value: 'value-1',
          },
          {
            opportunityId: 'opp-1',
            suggestionId: 'sugg-2',
            op: 'replace',
            value: 'value-2',
          },
        ],
      };

      const result = removePatchesBySuggestionIds(config, ['sugg-1']);

      expect(result.patches).to.have.lengthOf(1);
      expect(result.patches[0].suggestionId).to.equal('sugg-2');
      expect(result.removedCount).to.equal(1);
    });

    it('should remove URL paths with no remaining patches', () => {
      const config = {
        url: 'https://example.com/page1',
        version: '1.0',
        forceFail: false,
        prerender: true,
        patches: [
          {
            opportunityId: 'opp-1',
            suggestionId: 'sugg-1',
            op: 'replace',
            value: 'value-1',
          },
        ],
      };

      const result = removePatchesBySuggestionIds(config, ['sugg-1']);

      expect(result.patches).to.have.lengthOf(0);
      expect(result.removedCount).to.equal(1);
    });

    it('should handle empty suggestion IDs array', () => {
      const config = {
        url: 'https://example.com/page1',
        version: '1.0',
        forceFail: false,
        prerender: true,
        patches: [
          {
            opportunityId: 'opp-1',
            suggestionId: 'sugg-1',
            op: 'replace',
            value: 'value-1',
          },
        ],
      };

      const result = removePatchesBySuggestionIds(config, []);

      expect(result.patches).to.have.lengthOf(1);
      expect(result.removedCount).to.equal(0);
    });

    it('should handle non-matching suggestion IDs', () => {
      const config = {
        url: 'https://example.com/page1',
        version: '1.0',
        forceFail: false,
        prerender: true,
        patches: [
          {
            opportunityId: 'opp-1',
            suggestionId: 'sugg-1',
            op: 'replace',
            value: 'value-1',
          },
        ],
      };

      const result = removePatchesBySuggestionIds(config, ['sugg-999']);

      expect(result.patches).to.have.lengthOf(1);
      expect(result.removedCount).to.equal(0);
    });

    it('should handle null/undefined config gracefully', () => {
      const result1 = removePatchesBySuggestionIds(null, ['sugg-1']);
      const result2 = removePatchesBySuggestionIds(undefined, ['sugg-1']);

      expect(result1).to.be.null;
      expect(result2).to.be.undefined;
    });

    it('should preserve patches without suggestionId (heading patches)', () => {
      const config = {
        url: 'https://example.com/page1',
        version: '1.0',
        forceFail: false,
        prerender: true,
        patches: [
          {
            opportunityId: 'opp-faq',
            op: 'appendChild',
            value: 'FAQs',
          },
          {
            opportunityId: 'opp-faq',
            suggestionId: 'sugg-1',
            op: 'appendChild',
            value: 'FAQ item 1',
          },
        ],
      };

      const result = removePatchesBySuggestionIds(config, ['sugg-1']);

      expect(result.patches).to.have.lengthOf(1);
      expect(result.patches[0].value).to.equal('FAQs');
      expect(result.removedCount).to.equal(1);
    });

    it('should remove patches by additional patch keys', () => {
      const config = {
        url: 'https://example.com/page1',
        version: '1.0',
        forceFail: false,
        prerender: true,
        patches: [
          {
            opportunityId: 'opp-faq',
            op: 'appendChild',
            value: 'FAQs',
          },
          {
            opportunityId: 'opp-faq',
            suggestionId: 'sugg-1',
            op: 'appendChild',
            value: 'FAQ item 1',
          },
          {
            opportunityId: 'opp-faq',
            suggestionId: 'sugg-2',
            op: 'appendChild',
            value: 'FAQ item 2',
          },
        ],
      };

      // Remove all FAQs by passing heading patch key and suggestion IDs
      const result = removePatchesBySuggestionIds(config, ['sugg-1', 'sugg-2'], ['opp-faq']);

      expect(result.patches).to.have.lengthOf(0);
      expect(result.removedCount).to.equal(3);
    });

    it('should remove patches by additional patch keys while keeping other suggestions', () => {
      const config = {
        url: 'https://example.com/page1',
        version: '1.0',
        forceFail: false,
        prerender: true,
        patches: [
          {
            opportunityId: 'opp-faq',
            op: 'appendChild',
            value: 'FAQs',
          },
          {
            opportunityId: 'opp-faq',
            suggestionId: 'sugg-1',
            op: 'appendChild',
            value: 'FAQ item 1',
          },
          {
            opportunityId: 'opp-faq',
            suggestionId: 'sugg-2',
            op: 'appendChild',
            value: 'FAQ item 2',
          },
        ],
      };

      // Remove only sugg-1, heading patch should remain
      const result = removePatchesBySuggestionIds(config, ['sugg-1']);

      expect(result.patches).to.have.lengthOf(2);
      expect(result.patches[0].value).to.equal('FAQs');
      expect(result.patches[1].suggestionId).to.equal('sugg-2');
      expect(result.removedCount).to.equal(1);
    });

    it('should handle both suggestionIds and additional patch keys together', () => {
      const config = {
        url: 'https://example.com/page1',
        version: '1.0',
        forceFail: false,
        prerender: true,
        patches: [
          {
            opportunityId: 'opp-faq',
            op: 'appendChild',
            value: 'FAQs',
          },
          {
            opportunityId: 'opp-faq',
            suggestionId: 'sugg-1',
            op: 'appendChild',
            value: 'FAQ item 1',
          },
          {
            opportunityId: 'opp-other',
            suggestionId: 'sugg-2',
            op: 'replace',
            value: 'Other suggestion',
          },
        ],
      };

      // Remove sugg-1 and the heading patch
      const result = removePatchesBySuggestionIds(config, ['sugg-1'], ['opp-faq']);

      expect(result.patches).to.have.lengthOf(1);
      expect(result.patches[0].suggestionId).to.equal('sugg-2');
      expect(result.removedCount).to.equal(2);
    });
  });
});
