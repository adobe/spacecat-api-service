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
  endpointOf, hostnameFromUrlString, isPublicHostname, siteIdentityFromUrlString,
} from '../../src/support/url-utils.js';

describe('url-utils: hostnameFromUrlString', () => {
  it('extracts the hostname from a full URL', () => {
    expect(hostnameFromUrlString('https://acme.com/path?q=1')).to.equal('acme.com');
  });

  it('tolerates a bare hostname (no scheme)', () => {
    expect(hostnameFromUrlString('acme.com')).to.equal('acme.com');
  });

  it('returns null for empty/whitespace/non-string input', () => {
    expect(hostnameFromUrlString('')).to.equal(null);
    expect(hostnameFromUrlString('   ')).to.equal(null);
    expect(hostnameFromUrlString(undefined)).to.equal(null);
    expect(hostnameFromUrlString(null)).to.equal(null);
  });

  it('returns null for an unparseable URL (new URL throws)', () => {
    expect(hostnameFromUrlString('https://[')).to.equal(null);
  });
});

describe('url-utils: siteIdentityFromUrlString', () => {
  it('keeps the host and preserves the path', () => {
    expect(siteIdentityFromUrlString('https://www.nba.com/kings/')).to.equal('www.nba.com/kings');
    expect(siteIdentityFromUrlString('nba.com/kings')).to.equal('nba.com/kings');
    expect(siteIdentityFromUrlString('quickbooks.intuit.com/au')).to.equal('quickbooks.intuit.com/au');
  });

  it('returns host-only for path-free URLs (matches hostnameFromUrlString, no trailing slash)', () => {
    expect(siteIdentityFromUrlString('https://example.com')).to.equal('example.com');
    expect(siteIdentityFromUrlString('https://example.com/')).to.equal('example.com');
    expect(siteIdentityFromUrlString('quickbooks.intuit.com')).to.equal('quickbooks.intuit.com');
  });

  it('strips a single trailing slash but preserves .html and case-sensitive path', () => {
    expect(siteIdentityFromUrlString('experian.co.uk/business/')).to.equal('experian.co.uk/business');
    expect(siteIdentityFromUrlString('oklahoma.gov/omes.html')).to.equal('oklahoma.gov/omes.html');
    expect(siteIdentityFromUrlString('HTTPS://Shop.Example.COM/UK/En')).to.equal('shop.example.com/UK/En');
  });

  it('strips scheme, userinfo, port, query and fragment', () => {
    expect(siteIdentityFromUrlString('https://user:pass@shop.example.com:8443/uk?a=1#f'))
      .to.equal('shop.example.com/uk');
  });

  it('returns null for empty/whitespace/non-string input', () => {
    expect(siteIdentityFromUrlString('')).to.equal(null);
    expect(siteIdentityFromUrlString('   ')).to.equal(null);
    expect(siteIdentityFromUrlString(undefined)).to.equal(null);
    expect(siteIdentityFromUrlString(null)).to.equal(null);
  });

  it('returns null for unparseable input and empty-host URLs', () => {
    expect(siteIdentityFromUrlString('https://[')).to.equal(null);
    expect(siteIdentityFromUrlString('file:///etc/passwd')).to.equal(null);
  });
});

describe('url-utils: isPublicHostname', () => {
  it('accepts registrable public domains', () => {
    expect(isPublicHostname('example.com')).to.equal(true);
    expect(isPublicHostname('www.acme.co.uk')).to.equal(true);
    expect(isPublicHostname('sub.brand.io')).to.equal(true);
    // trailing dot (FQDN) is tolerated
    expect(isPublicHostname('example.com.')).to.equal(true);
  });

  it('rejects localhost and *.localhost', () => {
    expect(isPublicHostname('localhost')).to.equal(false);
    expect(isPublicHostname('app.localhost')).to.equal(false);
  });

  it('rejects IPv4 literals (loopback, link-local, RFC1918, public)', () => {
    expect(isPublicHostname('127.0.0.1')).to.equal(false);
    expect(isPublicHostname('169.254.169.254')).to.equal(false);
    expect(isPublicHostname('10.0.0.5')).to.equal(false);
    expect(isPublicHostname('192.168.1.10')).to.equal(false);
    expect(isPublicHostname('8.8.8.8')).to.equal(false);
  });

  it('rejects IPv6 literals (bracketed host has a colon; bare forms fail closed)', () => {
    // A URL-form IPv6 literal canonicalizes to a bracketed hostname ('[::1]'),
    // which the colon guard rejects.
    expect(isPublicHostname('https://[::1]/')).to.equal(false);
    expect(isPublicHostname('[fe80::1]')).to.equal(false);
    // A bare, unbracketed IPv6 string is unparseable as a URL → fails closed.
    expect(isPublicHostname('::1')).to.equal(false);
    expect(isPublicHostname('fe80::1')).to.equal(false);
  });

  it('rejects single-label hosts (no dot)', () => {
    expect(isPublicHostname('metadata')).to.equal(false);
    expect(isPublicHostname('intranet')).to.equal(false);
  });

  it('rejects reserved/internal-use TLDs', () => {
    expect(isPublicHostname('db.internal')).to.equal(false);
    expect(isPublicHostname('host.local')).to.equal(false);
    expect(isPublicHostname('foo.test')).to.equal(false);
    expect(isPublicHostname('svc.corp')).to.equal(false);
    expect(isPublicHostname('host.home')).to.equal(false);
    expect(isPublicHostname('dev.lan')).to.equal(false);
    expect(isPublicHostname('foo.example')).to.equal(false);
  });

  it('returns false for empty/whitespace input', () => {
    expect(isPublicHostname('')).to.equal(false);
    expect(isPublicHostname('   ')).to.equal(false);
    expect(isPublicHostname(undefined)).to.equal(false);
  });

  it('self-defends against un-normalized IP-literal evasions (decimal/hex/octal)', () => {
    // Decimal, hex, and octal encodings of 127.0.0.1 — WHATWG URL normalization
    // (applied internally) collapses them to the dotted loopback, which the IPv4
    // guard then rejects. This holds even though the caller did NOT pre-normalize
    // via hostnameFromUrlString.
    expect(isPublicHostname('2130706433')).to.equal(false);
    expect(isPublicHostname('0x7f.0.0.1')).to.equal(false);
    expect(isPublicHostname('0177.0.0.1')).to.equal(false);
  });

  it('accepts a full URL (canonicalized internally), not just a bare host', () => {
    expect(isPublicHostname('https://acme.com/path?q=1')).to.equal(true);
    expect(isPublicHostname('http://127.0.0.1:8080/x')).to.equal(false);
  });

  it('returns false for an unparseable input (fails closed)', () => {
    expect(isPublicHostname('https://[')).to.equal(false);
  });
});

describe('url-utils: endpointOf', () => {
  it('returns the pathname of a full URL', () => {
    expect(endpointOf('https://gw.example.com/v1/workspaces/ws-1/resources?x=1'))
      .to.equal('/v1/workspaces/ws-1/resources');
  });

  it('returns undefined for an unparseable URL', () => {
    expect(endpointOf('not a url')).to.equal(undefined);
  });

  it('returns undefined for null/undefined/empty input', () => {
    expect(endpointOf(null)).to.equal(undefined);
    expect(endpointOf(undefined)).to.equal(undefined);
    expect(endpointOf('')).to.equal(undefined);
  });
});
