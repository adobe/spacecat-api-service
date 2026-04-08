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

import sinon from 'sinon';

import {
  auditTargetURLsPatchGuard,
  MAX_MANUAL_AUDIT_TARGET_URLS,
  normalizeHostnameForAuditTargetMatch,
  siteHostnameFromBaseURL,
  validateAuditTargetUrlString,
  validateAuditTargetURLsConfig,
} from '../../src/support/audit-target-urls-validation.js';

describe('audit-target-urls-validation', () => {
  describe('normalizeHostnameForAuditTargetMatch', () => {
    it('lowercases and strips one leading www.', () => {
      expect(normalizeHostnameForAuditTargetMatch('WWW.Example.COM')).to.equal('example.com');
    });

    it('does not strip www2 or nested www', () => {
      expect(normalizeHostnameForAuditTargetMatch('www2.example.com')).to.equal('www2.example.com');
      expect(normalizeHostnameForAuditTargetMatch('www.www.example.com')).to.equal('www.example.com');
    });
  });

  describe('siteHostnameFromBaseURL', () => {
    it('returns hostname for valid base URL', () => {
      expect(siteHostnameFromBaseURL('https://main--foo--bar.aem.page')).to.equal('main--foo--bar.aem.page');
    });

    it('returns null for invalid or empty input', () => {
      expect(siteHostnameFromBaseURL('')).to.equal(null);
      expect(siteHostnameFromBaseURL(null)).to.equal(null);
      expect(siteHostnameFromBaseURL(undefined)).to.equal(null);
      expect(siteHostnameFromBaseURL(123)).to.equal(null);
      expect(siteHostnameFromBaseURL('not-a-url')).to.equal(null);
    });
  });

  describe('validateAuditTargetUrlString', () => {
    it('accepts HTTPS URL matching site hostname', () => {
      expect(validateAuditTargetUrlString('https://site1.com/path', 'site1.com')).to.deep.equal({ ok: true });
    });

    it('accepts apex URL when site hostname is www variant', () => {
      expect(validateAuditTargetUrlString('https://site1.com/path', 'www.site1.com')).to.deep.equal({ ok: true });
    });

    it('accepts www URL when site hostname is apex', () => {
      expect(validateAuditTargetUrlString('https://www.site1.com/path', 'site1.com')).to.deep.equal({ ok: true });
    });

    it('skips hostname check when site hostname is null', () => {
      expect(validateAuditTargetUrlString('https://any.example/foo', null).ok).to.equal(true);
    });

    it('rejects non-HTTPS', () => {
      const r = validateAuditTargetUrlString('http://site1.com/', 'site1.com');
      expect(r.ok).to.equal(false);
      expect(r.error).to.equal('URL must use HTTPS');
    });

    it('rejects hostname mismatch', () => {
      const r = validateAuditTargetUrlString('https://other.com/', 'site1.com');
      expect(r.ok).to.equal(false);
      expect(r.error).to.equal(
        'URL hostname must match the site domain (site1.com, with or without www.)',
      );
    });

    it('rejects invalid URL', () => {
      const r = validateAuditTargetUrlString(':::bad', 'site1.com');
      expect(r.ok).to.equal(false);
      expect(r.error).to.equal('Invalid URL');
    });
  });

  describe('validateAuditTargetURLsConfig', () => {
    it('returns ok for undefined', () => {
      expect(validateAuditTargetURLsConfig(undefined, 'https://site1.com')).to.deep.equal({ ok: true });
    });

    it('rejects null and non-objects', () => {
      expect(validateAuditTargetURLsConfig(null, 'https://x.com').ok).to.equal(false);
      expect(validateAuditTargetURLsConfig([], 'https://x.com').ok).to.equal(false);
    });

    it('returns ok for empty object without manual', () => {
      expect(validateAuditTargetURLsConfig({}, 'https://site1.com')).to.deep.equal({ ok: true });
    });

    it('rejects non-array manual', () => {
      const r = validateAuditTargetURLsConfig({ manual: {} }, 'https://site1.com');
      expect(r.ok).to.equal(false);
      expect(r.error).to.include('manual must be an array');
    });

    it('rejects manual list longer than MAX_MANUAL_AUDIT_TARGET_URLS', () => {
      const manual = Array.from({ length: MAX_MANUAL_AUDIT_TARGET_URLS + 1 }, (_, i) => ({
        url: `https://site1.com/u${i}`,
      }));
      const r = validateAuditTargetURLsConfig({ manual }, 'https://site1.com');
      expect(r.ok).to.equal(false);
      expect(r.error).to.equal(
        `config.auditTargetURLs.manual cannot contain more than ${MAX_MANUAL_AUDIT_TARGET_URLS} URLs`,
      );
    });

    it('normalizes trimmed manual URLs', () => {
      const r = validateAuditTargetURLsConfig(
        { manual: [{ url: '  https://site1.com/x  ' }] },
        'https://site1.com',
      );
      expect(r.ok).to.equal(true);
      expect(r.normalized).to.deep.equal({ manual: [{ url: 'https://site1.com/x' }] });
    });

    it('accepts apex manual URL when site base URL uses www hostname', () => {
      const r = validateAuditTargetURLsConfig(
        { manual: [{ url: 'https://site1.com/y' }] },
        'https://www.site1.com',
      );
      expect(r.ok).to.equal(true);
    });

    it('rejects bad entry shape', () => {
      const r = validateAuditTargetURLsConfig({ manual: [{ url: 1 }] }, 'https://site1.com');
      expect(r.ok).to.equal(false);
      expect(r.error).to.include('must be an object with a string');
    });

    it('returns index-scoped error for valid shape but failing URL rules', () => {
      const r = validateAuditTargetURLsConfig(
        { manual: [{ url: 'https://evil.com/' }] },
        'https://site1.com',
      );
      expect(r.ok).to.equal(false);
      expect(r.error).to.match(/index 0/);
    });

    it('preserves unknown keys alongside manual', () => {
      const r = validateAuditTargetURLsConfig(
        { manual: [{ url: 'https://site1.com/' }], future: true },
        'https://site1.com',
      );
      expect(r.ok).to.equal(true);
      expect(r.normalized.future).to.equal(true);
    });
  });

  describe('auditTargetURLsPatchGuard', () => {
    const badRequest = sinon.stub().callsFake((msg) => ({ status: 400, message: msg }));

    afterEach(() => badRequest.resetHistory());

    it('returns null when patch does not set auditTargetURLs', () => {
      const merged = { slack: {} };
      expect(auditTargetURLsPatchGuard(merged, 'https://site1.com', { slack: {} }, badRequest)).to.equal(null);
      expect(badRequest.called).to.equal(false);
    });

    it('returns error payload and does not mutate merged when invalid', () => {
      const merged = { auditTargetURLs: { manual: [{ url: 'https://evil.com/' }] } };
      const patch = { auditTargetURLs: merged.auditTargetURLs };
      const r = auditTargetURLsPatchGuard(merged, 'https://site1.com', patch, badRequest);
      expect(r).to.have.property('error');
      expect(r.error).to.include({ status: 400 });
      expect(r.error.message).to.be.a('string').and.to.match(/site domain/);
      expect(badRequest.callCount).to.equal(1);
      expect(merged.auditTargetURLs.manual[0].url).to.equal('https://evil.com/');
    });

    it('returns empty object when patch is valid but nothing to normalize', () => {
      const merged = { auditTargetURLs: {} };
      const r = auditTargetURLsPatchGuard(
        merged,
        'https://site1.com',
        { auditTargetURLs: {} },
        badRequest,
      );
      expect(r).to.deep.equal({});
      expect(badRequest.called).to.equal(false);
    });

    it('returns normalized auditTargetURLs for caller to apply', () => {
      const merged = { auditTargetURLs: { manual: [{ url: '  https://site1.com/x  ' }] } };
      const patch = { auditTargetURLs: merged.auditTargetURLs };
      const r = auditTargetURLsPatchGuard(merged, 'https://site1.com', patch, badRequest);
      expect(r).to.deep.equal({ normalized: { manual: [{ url: 'https://site1.com/x' }] } });
      expect(merged.auditTargetURLs.manual[0].url).to.equal('  https://site1.com/x  ');
    });
  });
});
