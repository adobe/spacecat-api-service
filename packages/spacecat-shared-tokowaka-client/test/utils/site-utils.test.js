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
import { getEffectiveBaseURL } from '../../src/utils/site-utils.js';

describe('Site Utils', () => {
  describe('getEffectiveBaseURL', () => {
    it('should return site baseURL when no override', () => {
      const site = {
        getBaseURL: () => 'https://example.com',
        getConfig: () => ({
          getFetchConfig: () => ({}),
        }),
      };

      const result = getEffectiveBaseURL(site);
      expect(result).to.equal('https://example.com');
    });

    it('should return override baseURL when valid', () => {
      const site = {
        getBaseURL: () => 'https://example.com',
        getConfig: () => ({
          getFetchConfig: () => ({
            overrideBaseURL: 'https://override.com',
          }),
        }),
      };

      const result = getEffectiveBaseURL(site);
      expect(result).to.equal('https://override.com');
    });

    it('should return site baseURL when override is invalid', () => {
      const site = {
        getBaseURL: () => 'https://example.com',
        getConfig: () => ({
          getFetchConfig: () => ({
            overrideBaseURL: 'not-a-valid-url',
          }),
        }),
      };

      const result = getEffectiveBaseURL(site);
      expect(result).to.equal('https://example.com');
    });

    it('should handle missing getFetchConfig', () => {
      const site = {
        getBaseURL: () => 'https://example.com',
        getConfig: () => ({}),
      };

      const result = getEffectiveBaseURL(site);
      expect(result).to.equal('https://example.com');
    });

    it('should handle missing config', () => {
      const site = {
        getBaseURL: () => 'https://example.com',
        getConfig: () => null,
      };

      const result = getEffectiveBaseURL(site);
      expect(result).to.equal('https://example.com');
    });
  });
});
