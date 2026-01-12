/*
 * Copyright 2026 Adobe. All rights reserved.
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

import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import {
  OPPORTUNITY_TAG_MAPPINGS,
  getTagsForOpportunityType,
  mergeTagsWithHardcodedTags,
} from '../../src/common/tagMappings.js';

use(sinonChai);

describe('tagMappings', () => {
  describe('OPPORTUNITY_TAG_MAPPINGS', () => {
    it('should contain all expected opportunity type mappings', () => {
      expect(OPPORTUNITY_TAG_MAPPINGS).to.be.an('object');
      expect(OPPORTUNITY_TAG_MAPPINGS).to.have.property('cwv');
      expect(OPPORTUNITY_TAG_MAPPINGS).to.have.property('meta-tags');
      expect(OPPORTUNITY_TAG_MAPPINGS).to.have.property('alt-text');
      expect(OPPORTUNITY_TAG_MAPPINGS).to.have.property('high-form-views-low-conversions');
      expect(OPPORTUNITY_TAG_MAPPINGS).to.have.property('generic-opportunity');
    });

    it('should have correct tags for cwv', () => {
      expect(OPPORTUNITY_TAG_MAPPINGS.cwv).to.deep.equal(['Core Web Vitals', 'Web Performance']);
    });

    it('should have correct tags for meta-tags', () => {
      expect(OPPORTUNITY_TAG_MAPPINGS['meta-tags']).to.deep.equal(['Meta Tags', 'SEO']);
    });

    it('should have correct tags for alt-text', () => {
      expect(OPPORTUNITY_TAG_MAPPINGS['alt-text']).to.deep.equal(['Alt-Text', 'Accessibility', 'SEO']);
    });

    it('should have correct tags for high-form-views-low-conversions', () => {
      expect(OPPORTUNITY_TAG_MAPPINGS['high-form-views-low-conversions']).to.deep.equal(['Form Conversion', 'Conversion']);
    });

    it('should have correct tags for generic-opportunity', () => {
      expect(OPPORTUNITY_TAG_MAPPINGS['generic-opportunity']).to.deep.equal(['Generic', 'Opportunity']);
    });
  });

  describe('getTagsForOpportunityType', () => {
    it('should return tags for valid opportunity type', () => {
      const result = getTagsForOpportunityType('cwv');
      expect(result).to.deep.equal(['Core Web Vitals', 'Web Performance']);
    });

    it('should return tags for meta-tags opportunity type', () => {
      const result = getTagsForOpportunityType('meta-tags');
      expect(result).to.deep.equal(['Meta Tags', 'SEO']);
    });

    it('should return tags for alt-text opportunity type', () => {
      const result = getTagsForOpportunityType('alt-text');
      expect(result).to.deep.equal(['Alt-Text', 'Accessibility', 'SEO']);
    });

    it('should return tags for high-form-views-low-conversions opportunity type', () => {
      const result = getTagsForOpportunityType('high-form-views-low-conversions');
      expect(result).to.deep.equal(['Form Conversion', 'Conversion']);
    });

    it('should return tags for a11y-assistive opportunity type', () => {
      const result = getTagsForOpportunityType('a11y-assistive');
      expect(result).to.deep.equal(['ARIA Labels', 'Accessibility']);
    });

    it('should return tags for a11y-color-contrast opportunity type', () => {
      const result = getTagsForOpportunityType('a11y-color-contrast');
      expect(result).to.deep.equal(['Color Contrast', 'Accessibility', 'Engagement']);
    });

    it('should return tags for form-accessibility opportunity type', () => {
      const result = getTagsForOpportunityType('form-accessibility');
      expect(result).to.deep.equal(['Form Accessibility', 'Accessibility', 'Engagement']);
    });

    it('should return empty array for unknown opportunity type', () => {
      const result = getTagsForOpportunityType('unknown-type');
      expect(result).to.deep.equal([]);
    });

    it('should return empty array for undefined opportunity type', () => {
      const result = getTagsForOpportunityType(undefined);
      expect(result).to.deep.equal([]);
    });

    it('should return empty array for null opportunity type', () => {
      const result = getTagsForOpportunityType(null);
      expect(result).to.deep.equal([]);
    });

    it('should return empty array for empty string opportunity type', () => {
      const result = getTagsForOpportunityType('');
      expect(result).to.deep.equal([]);
    });
  });

  describe('mergeTagsWithHardcodedTags', () => {
    it('should return current tags for generic-opportunity type', () => {
      const result = mergeTagsWithHardcodedTags('generic-opportunity', ['Custom Tag', 'isElmo']);
      expect(result).to.deep.equal(['Custom Tag', 'isElmo']);
    });

    it('should return current tags for generic-opportunity type even if empty', () => {
      const result = mergeTagsWithHardcodedTags('generic-opportunity', []);
      expect(result).to.deep.equal([]);
    });

    it('should return current tags for unknown opportunity type', () => {
      const result = mergeTagsWithHardcodedTags('unknown-type', ['Custom Tag']);
      expect(result).to.deep.equal(['Custom Tag']);
    });

    it('should return hardcoded tags when currentTags is empty', () => {
      const result = mergeTagsWithHardcodedTags('cwv', []);
      expect(result).to.deep.equal(['Core Web Vitals', 'Web Performance']);
    });

    it('should return hardcoded tags when currentTags is undefined', () => {
      const result = mergeTagsWithHardcodedTags('cwv', undefined);
      expect(result).to.deep.equal(['Core Web Vitals', 'Web Performance']);
    });

    it('should return hardcoded tags when currentTags is null', () => {
      const result = mergeTagsWithHardcodedTags('cwv', null);
      expect(result).to.deep.equal(['Core Web Vitals', 'Web Performance']);
    });

    it('should replace existing tags with hardcoded tags', () => {
      const result = mergeTagsWithHardcodedTags('meta-tags', ['Old Tag', 'Another Tag']);
      expect(result).to.deep.equal(['Meta Tags', 'SEO']);
    });

    it('should preserve isElmo tag', () => {
      const result = mergeTagsWithHardcodedTags('cwv', ['isElmo', 'Custom Tag']);
      expect(result).to.deep.equal(['Core Web Vitals', 'Web Performance', 'isElmo']);
    });

    it('should preserve isASO tag', () => {
      const result = mergeTagsWithHardcodedTags('alt-text', ['isASO', 'Custom Tag']);
      expect(result).to.deep.equal(['Alt-Text', 'Accessibility', 'SEO', 'isASO']);
    });

    it('should preserve both isElmo and isASO tags', () => {
      const result = mergeTagsWithHardcodedTags('meta-tags', ['isElmo', 'isASO', 'Custom Tag']);
      expect(result).to.deep.equal(['Meta Tags', 'SEO', 'isElmo', 'isASO']);
    });

    it('should not duplicate preserved tags if already in hardcoded tags', () => {
      // This test ensures that if isElmo or isASO somehow appear in hardcoded tags,
      // they won't be duplicated
      const result = mergeTagsWithHardcodedTags('meta-tags', ['isElmo', 'isASO']);
      expect(result).to.deep.equal(['Meta Tags', 'SEO', 'isElmo', 'isASO']);
    });

    it('should handle multiple opportunity types correctly', () => {
      const cwvResult = mergeTagsWithHardcodedTags('cwv', ['isElmo']);
      expect(cwvResult).to.deep.equal(['Core Web Vitals', 'Web Performance', 'isElmo']);

      const altTextResult = mergeTagsWithHardcodedTags('alt-text', ['isASO']);
      expect(altTextResult).to.deep.equal(['Alt-Text', 'Accessibility', 'SEO', 'isASO']);

      const formResult = mergeTagsWithHardcodedTags('high-form-views-low-conversions', []);
      expect(formResult).to.deep.equal(['Form Conversion', 'Conversion']);
    });

    it('should preserve isElmo and isASO for all opportunity types', () => {
      const opportunityTypes = Object.keys(OPPORTUNITY_TAG_MAPPINGS).filter(
        (type) => type !== 'generic-opportunity',
      );
      opportunityTypes.forEach((type) => {
        const result = mergeTagsWithHardcodedTags(type, ['isElmo', 'isASO', 'Custom Tag']);
        expect(result).to.include('isElmo');
        expect(result).to.include('isASO');
        expect(result).to.not.include('Custom Tag');
        expect(result).to.deep.equal([
          ...OPPORTUNITY_TAG_MAPPINGS[type],
          'isElmo',
          'isASO',
        ]);
      });
    });

    it('should handle empty array for currentTags', () => {
      const result = mergeTagsWithHardcodedTags('a11y-assistive', []);
      expect(result).to.deep.equal(['ARIA Labels', 'Accessibility']);
    });

    it('should handle array with only preserved tags', () => {
      const result = mergeTagsWithHardcodedTags('readability', ['isElmo']);
      expect(result).to.deep.equal(['Readability', 'Accessibility', 'Engagement', 'isElmo']);
    });

    it('should handle array with mixed preserved and non-preserved tags', () => {
      const result = mergeTagsWithHardcodedTags('toc', ['isElmo', 'isASO', 'Random Tag', 'Another Tag']);
      expect(result).to.deep.equal(['Table of Contents', 'Content', 'Engagement', 'isElmo', 'isASO']);
    });
  });
});
