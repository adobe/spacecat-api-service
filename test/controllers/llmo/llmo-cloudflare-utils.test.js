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
  deployWorkerBaseURL,
  hostInSiteDomain,
  hostSharesSiteRegistrableDomain,
  isCloudflareTargetHostAllowed,
  routePatternHost,
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

  describe('deployWorkerBaseURL', () => {
    it('reuses the site base URL for the production host', () => {
      expect(deployWorkerBaseURL('https://www.example.com', 'www.example.com')).to.equal('https://www.example.com');
    });

    it('uses https://{targetHost}/ for staging subdomains', () => {
      expect(deployWorkerBaseURL('https://www.example.com', 'staging.example.com')).to.equal('https://staging.example.com/');
    });
  });

  describe('hostSharesSiteRegistrableDomain', () => {
    it('accepts sibling subdomains on the same registrable domain', () => {
      expect(hostSharesSiteRegistrableDomain('tokowaka.aem-screens.net', 'https://frescopa.aem-screens.net')).to.equal(true);
    });

    it('rejects unrelated domains', () => {
      expect(hostSharesSiteRegistrableDomain('evil.com', 'https://frescopa.aem-screens.net')).to.equal(false);
    });
  });

  describe('isCloudflareTargetHostAllowed', () => {
    it('accepts production subdomains', () => {
      expect(isCloudflareTargetHostAllowed('cdn.example.com', 'https://www.example.com')).to.equal(true);
    });

    it('accepts registrable-domain siblings for stage-style hosts', () => {
      expect(isCloudflareTargetHostAllowed('tokowaka.aem-screens.net', 'https://frescopa.aem-screens.net')).to.equal(true);
    });
  });
});
