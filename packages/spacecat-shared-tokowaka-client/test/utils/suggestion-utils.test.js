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
import { groupSuggestionsByUrlPath, filterEligibleSuggestions } from '../../src/utils/suggestion-utils.js';

describe('Suggestion Utils', () => {
  describe('groupSuggestionsByUrlPath', () => {
    const log = {
      warn: () => {},
      debug: () => {},
    };

    it('should group suggestions by URL path', () => {
      const suggestions = [
        {
          getId: () => 'sugg-1',
          getData: () => ({ url: 'https://example.com/page1' }),
        },
        {
          getId: () => 'sugg-2',
          getData: () => ({ url: 'https://example.com/page1' }),
        },
        {
          getId: () => 'sugg-3',
          getData: () => ({ url: 'https://example.com/page2' }),
        },
      ];

      const result = groupSuggestionsByUrlPath(suggestions, 'https://example.com', log);

      expect(result).to.have.property('/page1');
      expect(result).to.have.property('/page2');
      expect(result['/page1']).to.have.lengthOf(2);
      expect(result['/page2']).to.have.lengthOf(1);
    });

    it('should skip suggestions without URL', () => {
      const suggestions = [
        {
          getId: () => 'sugg-1',
          getData: () => ({}), // No URL
        },
        {
          getId: () => 'sugg-2',
          getData: () => ({ url: 'https://example.com/page1' }),
        },
      ];

      const result = groupSuggestionsByUrlPath(suggestions, 'https://example.com', log);

      expect(result).to.not.have.property('undefined');
      expect(result).to.have.property('/page1');
      expect(result['/page1']).to.have.lengthOf(1);
    });

    it('should skip suggestions with invalid URL', () => {
      const suggestions = [
        {
          getId: () => 'sugg-1',
          getData: () => ({ url: 'not-a-valid-url' }),
        },
        {
          getId: () => 'sugg-2',
          getData: () => ({ url: 'https://example.com/page1' }),
        },
      ];

      const result = groupSuggestionsByUrlPath(suggestions, 'https://example.com', log);

      expect(result).to.have.property('/page1');
      expect(result['/page1']).to.have.lengthOf(1);
    });

    it('should skip suggestions with malformed URL that throws', () => {
      const suggestions = [
        {
          getId: () => 'sugg-1',
          getData: () => ({ url: 'http://[invalid' }), // Malformed URL that will throw
        },
        {
          getId: () => 'sugg-2',
          getData: () => ({ url: 'https://example.com/page1' }),
        },
      ];

      const result = groupSuggestionsByUrlPath(suggestions, 'invalid-base', log);

      // Should skip sugg-1 due to URL parsing error
      expect(Object.keys(result)).to.have.lengthOf(0); // Both fail due to invalid base
    });
  });

  describe('filterEligibleSuggestions', () => {
    const mapper = {
      canDeploy: (suggestion) => {
        const data = suggestion.getData();
        if (data.shouldDeploy) {
          return { eligible: true };
        }
        return { eligible: false, reason: 'Not eligible' };
      },
    };

    it('should filter eligible and ineligible suggestions', () => {
      const suggestions = [
        {
          getId: () => 'sugg-1',
          getData: () => ({ shouldDeploy: true }),
        },
        {
          getId: () => 'sugg-2',
          getData: () => ({ shouldDeploy: false }),
        },
      ];

      const result = filterEligibleSuggestions(suggestions, mapper);

      expect(result.eligible).to.have.lengthOf(1);
      expect(result.ineligible).to.have.lengthOf(1);
      expect(result.eligible[0].getId()).to.equal('sugg-1');
      expect(result.ineligible[0].suggestion.getId()).to.equal('sugg-2');
      expect(result.ineligible[0].reason).to.equal('Not eligible');
    });

    it('should handle all eligible suggestions', () => {
      const suggestions = [
        {
          getId: () => 'sugg-1',
          getData: () => ({ shouldDeploy: true }),
        },
        {
          getId: () => 'sugg-2',
          getData: () => ({ shouldDeploy: true }),
        },
      ];

      const result = filterEligibleSuggestions(suggestions, mapper);

      expect(result.eligible).to.have.lengthOf(2);
      expect(result.ineligible).to.have.lengthOf(0);
    });

    it('should handle all ineligible suggestions', () => {
      const suggestions = [
        {
          getId: () => 'sugg-1',
          getData: () => ({ shouldDeploy: false }),
        },
      ];

      const result = filterEligibleSuggestions(suggestions, mapper);

      expect(result.eligible).to.have.lengthOf(0);
      expect(result.ineligible).to.have.lengthOf(1);
    });

    it('should use default reason when eligibility.reason is empty', () => {
      const mapperWithoutReason = {
        canDeploy: () => ({ eligible: false }), // No reason provided
      };

      const suggestions = [
        {
          getId: () => 'sugg-1',
          getData: () => ({}),
        },
      ];

      const result = filterEligibleSuggestions(suggestions, mapperWithoutReason);

      expect(result.ineligible).to.have.lengthOf(1);
      expect(result.ineligible[0].reason).to.equal('Suggestion cannot be deployed');
    });
  });
});
