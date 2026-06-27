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

import {
  deriveWorkerName,
  hostInSiteDomain,
  routePatternHost,
  routePatternHostGlob,
  routeHostsOverlap,
} from '../../../src/controllers/llmo/llmo-cloudflare-utils.js';

describe('llmo-cloudflare-utils', () => {
  describe('deriveWorkerName', () => {
    it('strips leading www and maps dots to hyphens', () => {
      expect(deriveWorkerName('https://www.example.com')).to.equal('edge-optimize-router-example-com');
    });

    it('keeps subdomains other than www', () => {
      expect(deriveWorkerName('https://blog.example.co.uk')).to.equal('edge-optimize-router-blog-example-co-uk');
    });

    it('returns null when the host yields no usable slug', () => {
      expect(deriveWorkerName('https://-')).to.equal(null);
    });

    it('caps the name at 63 characters with no trailing hyphen', () => {
      const long = `https://${'a'.repeat(80)}.com`;
      const name = deriveWorkerName(long);
      expect(name.length).to.be.at.most(63);
      expect(name.endsWith('-')).to.equal(false);
    });
  });

  describe('hostInSiteDomain', () => {
    const baseURL = 'https://www.example.com';

    it('accepts the canonical host', () => {
      expect(hostInSiteDomain('example.com', baseURL)).to.equal(true);
    });

    it('accepts a subdomain (incl. www)', () => {
      expect(hostInSiteDomain('cdn.example.com', baseURL)).to.equal(true);
      expect(hostInSiteDomain('www.example.com', baseURL)).to.equal(true);
    });

    it('is case-insensitive', () => {
      expect(hostInSiteDomain('CDN.Example.com', baseURL)).to.equal(true);
    });

    it('rejects an unrelated domain and look-alike suffixes', () => {
      expect(hostInSiteDomain('evil.com', baseURL)).to.equal(false);
      expect(hostInSiteDomain('notexample.com', baseURL)).to.equal(false);
    });
  });

  describe('routePatternHost', () => {
    it('extracts the host from a plain pattern', () => {
      expect(routePatternHost('example.com/*')).to.equal('example.com');
    });

    it('strips a leading wildcard label', () => {
      expect(routePatternHost('*.example.com/path*')).to.equal('example.com');
    });

    it('strips a scheme when present', () => {
      expect(routePatternHost('https://www.example.com/*')).to.equal('www.example.com');
    });
  });

  describe('routePatternHostGlob', () => {
    it('keeps the leading wildcard label (unlike routePatternHost)', () => {
      expect(routePatternHostGlob('*.example.com/path*')).to.equal('*.example.com');
    });

    it('strips scheme and path and lowercases', () => {
      expect(routePatternHostGlob('https://WWW.Example.com/a/*')).to.equal('www.example.com');
    });
  });

  describe('routeHostsOverlap', () => {
    it('matches identical bare hosts', () => {
      expect(routeHostsOverlap('example.com/*', 'https://example.com/blog/*')).to.equal(true);
    });

    it('does not match different bare hosts', () => {
      expect(routeHostsOverlap('shop.example.com/*', 'example.com/*')).to.equal(false);
      expect(routeHostsOverlap('www.example.com/*', 'a.example.com/*')).to.equal(false);
    });

    it('matches when a wildcard route covers a bare subdomain (and vice versa)', () => {
      // Customer *.example.com/* worker vs onboarding a.example.com/* -> must overlap.
      expect(routeHostsOverlap('*.example.com/*', 'a.example.com/*')).to.equal(true);
      expect(routeHostsOverlap('a.example.com/*', '*.example.com/*')).to.equal(true);
    });

    it('a wildcard does not match its own apex (Cloudflare semantics)', () => {
      expect(routeHostsOverlap('*.example.com/*', 'example.com/*')).to.equal(false);
    });

    it('matches overlapping wildcard scopes', () => {
      expect(routeHostsOverlap('*.example.com/*', '*.a.example.com/*')).to.equal(true);
      expect(routeHostsOverlap('*.example.com/*', '*.example.com/api*')).to.equal(true);
    });

    it('does not match unrelated wildcard scopes', () => {
      expect(routeHostsOverlap('*.example.com/*', '*.other.com/*')).to.equal(false);
    });
  });
});
