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
import { getCookie, getCookieValue } from '../../../../src/auth/handlers/utils/cookie.js';

describe('Cookie Utils', () => {
  describe('getCookie', () => {
    it('should return null when no cookie header is present', () => {
      const context = { pathInfo: { headers: {} } };
      expect(getCookie(context)).to.be.null;
    });

    it('should return null when cookie header is empty', () => {
      const context = { pathInfo: { headers: { cookie: '' } } };
      expect(getCookie(context)).to.be.null;
    });

    it('should return the cookie string when present', () => {
      const cookieString = 'sessionToken=abc123; otherCookie=xyz789';
      const context = { pathInfo: { headers: { cookie: cookieString } } };
      expect(getCookie(context)).to.equal(cookieString);
    });
  });

  describe('getCookieValue', () => {
    it('should return null when no cookies are present', () => {
      const context = { pathInfo: { headers: {} } };
      expect(getCookieValue(context, 'sessionToken')).to.be.null;
    });

    it('should return null when cookie is not found', () => {
      const context = { pathInfo: { headers: { cookie: 'otherCookie=xyz789' } } };
      expect(getCookieValue(context, 'sessionToken')).to.be.null;
    });

    it('should return the cookie value when found', () => {
      const context = { pathInfo: { headers: { cookie: 'sessionToken=abc123; otherCookie=xyz789' } } };
      expect(getCookieValue(context, 'sessionToken')).to.equal('abc123');
    });

    it('should handle cookies with spaces', () => {
      const context = { pathInfo: { headers: { cookie: 'sessionToken=abc123; otherCookie=xyz789' } } };
      expect(getCookieValue(context, 'sessionToken')).to.equal('abc123');
    });

    it('should handle multiple cookies with same name (returns first match)', () => {
      const context = { pathInfo: { headers: { cookie: 'sessionToken=abc123; sessionToken=xyz789' } } };
      expect(getCookieValue(context, 'sessionToken')).to.equal('abc123');
    });
  });
});
