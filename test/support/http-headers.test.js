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

import { expect } from 'chai';
import { X_PROMISE_TOKEN_HEADER } from '../../src/utils/constants.js';
import {
  getHeader,
  getHeaderCaseInsensitive,
} from '../../src/support/http-headers.js';

describe('http-headers', () => {
  describe('getHeaderCaseInsensitive', () => {
    it('returns value for exact and alternate header casing', () => {
      // Protects against: gateway/proxy varying header name casing
      // Would fail if: lookup is case-sensitive only
      const headers = { 'X-Promise-Token': 'token-value' };
      expect(getHeaderCaseInsensitive(headers, X_PROMISE_TOKEN_HEADER)).to.equal('token-value');
      expect(getHeaderCaseInsensitive(headers, 'x-promise-token')).to.equal('token-value');
    });

    it('returns undefined when headers object is missing or empty', () => {
      expect(getHeaderCaseInsensitive(undefined, X_PROMISE_TOKEN_HEADER)).to.equal(undefined);
      expect(getHeaderCaseInsensitive({}, X_PROMISE_TOKEN_HEADER)).to.equal(undefined);
    });
  });

  describe('getHeader', () => {
    it('reads from context.pathInfo.headers with case-insensitive name', () => {
      const context = { pathInfo: { headers: { 'X-Promise-Token': 'abc' } } };
      expect(getHeader(context, X_PROMISE_TOKEN_HEADER)).to.equal('abc');
    });

    it('returns null for missing, empty, whitespace-only, or non-string values', () => {
      expect(getHeader({ pathInfo: { headers: {} } }, X_PROMISE_TOKEN_HEADER)).to.equal(null);
      expect(getHeader({
        pathInfo: { headers: { 'x-promise-token': '' } },
      }, X_PROMISE_TOKEN_HEADER)).to.equal(null);
      expect(getHeader({
        pathInfo: { headers: { 'x-promise-token': '   ' } },
      }, X_PROMISE_TOKEN_HEADER)).to.equal(null);
      expect(getHeader({
        pathInfo: { headers: { 'x-promise-token': 12345 } },
      }, X_PROMISE_TOKEN_HEADER)).to.equal(null);
    });

    it('trims surrounding whitespace from header values', () => {
      expect(getHeader({
        pathInfo: { headers: { 'x-promise-token': '  token-value  ' } },
      }, X_PROMISE_TOKEN_HEADER)).to.equal('token-value');
    });
  });
});
