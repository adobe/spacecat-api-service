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

/* eslint-env mocha */

import { expect } from 'chai';
import { extractKeyValuePairs } from '../../src/support/utils.js';

describe('Utils', () => {
  describe('extractKeyValuePairs', () => {
    it('should extract key:value pairs correctly', () => {
      const args = ['baseurl:https://example.com', 'from:2024-01-01', 'to:2024-02-01'];
      const result = extractKeyValuePairs(args);

      expect(result).to.deep.equal({
        baseurl: 'https://example.com',
        from: '2024-01-01',
        to: '2024-02-01',
      });
    });

    it('should handle URLs with multiple colons correctly', () => {
      const args = ['baseurl:https://example.com:8080/path', 'from:2024-01-01'];
      const result = extractKeyValuePairs(args);

      expect(result).to.deep.equal({
        baseurl: 'https://example.com:8080/path',
        from: '2024-01-01',
      });
    });

    it('should convert keys to lowercase', () => {
      const args = ['BaseURL:https://example.com', 'FROM:2024-01-01'];
      const result = extractKeyValuePairs(args);

      expect(result).to.deep.equal({
        baseurl: 'https://example.com',
        from: '2024-01-01',
      });
    });

    it('should ignore arguments without colons', () => {
      const args = ['baseurl:https://example.com', 'nocolon', 'from:2024-01-01'];
      const result = extractKeyValuePairs(args);

      expect(result).to.deep.equal({
        baseurl: 'https://example.com',
        from: '2024-01-01',
      });
    });

    it('should handle empty array', () => {
      const args = [];
      const result = extractKeyValuePairs(args);

      expect(result).to.deep.equal({});
    });

    it('should handle non-string arguments', () => {
      const args = ['baseurl:https://example.com', null, undefined, 123];
      const result = extractKeyValuePairs(args);

      expect(result).to.deep.equal({
        baseurl: 'https://example.com',
      });
    });

    it('should handle empty values', () => {
      const args = ['baseurl:', 'from:'];
      const result = extractKeyValuePairs(args);

      expect(result).to.deep.equal({
        baseurl: '',
        from: '',
      });
    });

    it('should handle multiple colons in value (like URLs)', () => {
      const args = ['pageurl:https://example.com/page:with:colons'];
      const result = extractKeyValuePairs(args);

      expect(result).to.deep.equal({
        pageurl: 'https://example.com/page:with:colons',
      });
    });

    it('should trim whitespace after colons', () => {
      const args = ['baseurl: https://example.com', 'from: 2024-01-01', 'to: 2024-02-01'];
      const result = extractKeyValuePairs(args);

      expect(result).to.deep.equal({
        baseurl: 'https://example.com',
        from: '2024-01-01',
        to: '2024-02-01',
      });
    });

    it('should trim whitespace in keys and values', () => {
      const args = [' BaseURL : https://example.com ', ' FROM : 2024-01-01 '];
      const result = extractKeyValuePairs(args);

      expect(result).to.deep.equal({
        baseurl: 'https://example.com',
        from: '2024-01-01',
      });
    });

    it('should handle mixed whitespace scenarios', () => {
      const args = ['baseurl:https://example.com', 'from: 2024-01-01', ' to :2024-02-01'];
      const result = extractKeyValuePairs(args);

      expect(result).to.deep.equal({
        baseurl: 'https://example.com',
        from: '2024-01-01',
        to: '2024-02-01',
      });
    });
  });
});
