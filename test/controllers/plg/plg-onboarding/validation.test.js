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

import { expect, use } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import { isSafeDomain } from '../../../../src/controllers/plg/plg-onboarding.js';
import {
  TEST_DOMAIN,
  TEST_IMS_ORG_ID,
  TEST_ORG_ID,
  TEST_PROJECT_ID,
  createSharedMocks,
  createMockSite as createMockSiteShared,
  createMockOnboarding as createMockOnboardingShared,
  createMockDataAccess,
  mockAuthInfo as mockAuthInfoShared,
  buildContext as buildContextShared,
} from './shared-fixtures.js';
import { createPlgEsmock } from './plg-esmock-factory.js';

use(sinonChai);

describe('PlgOnboardingController', function describePlgOnboarding() {
  // esmock + extensive sinon stubs make individual tests slower than the 2000ms default.
  this.timeout(10000);

  let sandbox;
  let stubs;
  let PlgOnboardingController;

  // Stub locals used directly in tests
  let composeBaseURLStub;
  let createOrFindOrganizationStub;

  // Mock objects
  let mockSiteConfig;
  let mockLog;
  let mockEnv;
  let mockSite;
  let mockOrganization;
  let mockProject;
  let mockDataAccess;
  let mockOnboarding;

  function createMockSite(overrides = {}) {
    return createMockSiteShared(sandbox, overrides, mockSiteConfig);
  }

  function createMockOnboarding(overrides = {}) {
    return createMockOnboardingShared(sandbox, overrides);
  }

  function mockAuthInfo(imsOrgId = TEST_IMS_ORG_ID) {
    return mockAuthInfoShared(sandbox, imsOrgId);
  }

  function buildContext(data = {}, options = {}) {
    return buildContextShared(sandbox, mockDataAccess, mockLog, mockEnv, data, options);
  }

  before(async () => {
    sandbox = sinon.createSandbox();
    stubs = { ...createSharedMocks(sandbox), sandbox };
    PlgOnboardingController = await createPlgEsmock(stubs);
  });

  after(() => sandbox.restore());

  beforeEach(() => {
    sandbox.reset();

    ({
      composeBaseURLStub,
      createOrFindOrganizationStub,
      mockLog,
      mockEnv,
      mockSiteConfig,
      mockOrganization,
      mockProject,
    } = stubs);

    // Re-apply stub defaults (sandbox.reset() clears both history and behavior)
    composeBaseURLStub.returns('https://example.com');
    stubs.resolveWwwUrlStub.resolves('example.com');
    stubs.rumRetrieveDomainkeyStub.resolves('test-domainkey');
    stubs.rumApiClientCreateFromStub.returns({ retrieveDomainkey: stubs.rumRetrieveDomainkeyStub });
    stubs.updateRumConfigStub.resolves(true);
    stubs.detectBotBlockerStub.resolves({ crawlable: true });
    stubs.detectLocaleStub.resolves({ language: 'en', region: 'US' });
    stubs.resolveCanonicalUrlStub.resolves('https://example.com');
    createOrFindOrganizationStub.resolves(mockOrganization);
    stubs.enableAuditsStub.resolves();
    stubs.enableImportsStub.resolves();
    stubs.triggerAuditsStub.resolves();
    stubs.autoResolveAuthorUrlStub.resolves(null);
    stubs.updateCodeConfigStub.resolves();
    stubs.findDeliveryTypeStub.resolves('aem_edge');
    stubs.deriveProjectNameStub.returns('example.com');
    stubs.queueDeliveryConfigWriterStub.resolves({ ok: true });
    stubs.loadProfileConfigStub.returns({
      audits: {
        'alt-text': {}, cwv: {}, 'broken-backlinks': {}, 'scrape-top-pages': {},
      },
      imports: {
        'organic-traffic': {}, 'top-pages': {}, 'all-traffic': {},
      },
    });
    stubs.triggerBrandProfileAgentStub.resolves('exec-123');
    stubs.ldCreateFromStub.returns({
      getFeatureFlag: stubs.ldGetFeatureFlagStub,
      updateVariationValue: stubs.ldUpdateVariationValueStub,
    });
    stubs.ldGetFeatureFlagStub.resolves({ variations: [{ value: {} }] });
    stubs.ldUpdateVariationValueStub.resolves({});
    stubs.tierClientCreateForSiteStub.resolves({
      createEntitlement: stubs.tierClientCreateEntitlementStub,
      checkValidEntitlement: sandbox.stub().resolves({
        entitlement: { getId: () => 'ent-1', getOrganizationId: () => TEST_ORG_ID },
        siteEnrollment: { getId: () => 'enroll-1' },
      }),
    });
    stubs.tierClientCreateForOrgStub.returns({
      createEntitlement: stubs.tierClientCreateEntitlementStub,
      checkValidEntitlement: sandbox.stub().resolves({
        entitlement: {
          getId: () => 'ent-1',
          getOrganizationId: () => TEST_ORG_ID,
          getTier: () => 'PLG',
        },
      }),
    });
    stubs.tierClientCreateEntitlementStub.resolves({
      entitlement: { getId: () => 'ent-1', getOrganizationId: () => TEST_ORG_ID, getTier: () => 'PLG' },
      siteEnrollment: { getId: () => 'enroll-1' },
    });
    stubs.configToDynamoItemStub.returns({ config: 'dynamo' });
    // Re-apply mock object stub defaults (sandbox.reset() clears these too)
    mockOrganization.getId.returns(TEST_ORG_ID);
    mockOrganization.getImsOrgId.returns(TEST_IMS_ORG_ID);
    mockOrganization.getName.returns('Test Org');
    mockProject.getId.returns(TEST_PROJECT_ID);
    mockProject.getProjectName.returns('example.com');
    mockSiteConfig.getFetchConfig.returns({});
    mockSiteConfig.getImports.returns([]);

    mockSite = createMockSite();
    mockOnboarding = createMockOnboarding();
    mockDataAccess = createMockDataAccess(sandbox, {
      mockSite, mockOrganization, mockProject, mockOnboarding,
    });
  });

  describe('onboard - input validation', () => {
    let controller;
    beforeEach(() => {
      controller = PlgOnboardingController({ log: mockLog });
    });

    it('returns 400 when request body is missing', async () => {
      const res = await controller.onboard({
        data: null,
        attributes: { authInfo: mockAuthInfo() },
      });
      expect(res.status).to.equal(400);
      expect(res.value).to.equal('Request body is required');
    });

    it('returns 400 when domain is missing', async () => {
      const context = buildContext({});
      const res = await controller.onboard(context);
      expect(res.status).to.equal(400);
      expect(res.value).to.equal('domain is required');
    });

    it('returns 400 when authInfo is missing', async () => {
      const context = buildContext(
        { domain: TEST_DOMAIN },
        { authInfo: null },
      );
      const res = await controller.onboard(context);
      expect(res.status).to.equal(400);
      expect(res.value).to.equal('Authentication information is required');
    });

    it('returns 400 when profile has no tenants', async () => {
      const context = buildContext(
        { domain: TEST_DOMAIN },
        { authInfo: { getProfile: sandbox.stub().returns({}) } },
      );
      const res = await controller.onboard(context);
      expect(res.status).to.equal(400);
      expect(res.value).to.equal('User profile or organization ID not found in authentication token');
    });

    it('returns 400 when profile is null', async () => {
      const context = buildContext(
        { domain: TEST_DOMAIN },
        { authInfo: { getProfile: sandbox.stub().returns(null) } },
      );
      const res = await controller.onboard(context);
      expect(res.status).to.equal(400);
      expect(res.value).to.equal('User profile or organization ID not found in authentication token');
    });

    it('returns 403 when requested imsOrgId does not match token tenants', async () => {
      const context = buildContext(
        { domain: TEST_DOMAIN, imsOrgId: 'XXXXXXXXXXXXXXXXXXXXXXXX@AdobeOrg' },
      );
      const res = await controller.onboard(context);
      expect(res.status).to.equal(403);
      expect(res.value).to.equal('Requested imsOrgId does not match any tenant in authentication token');
    });

    it('uses requested imsOrgId when it matches a token tenant', async () => {
      const secondOrgId = 'BBBBBBBBBBBBBBBBBBBBBBBB@AdobeOrg';
      const context = buildContext(
        { domain: TEST_DOMAIN, imsOrgId: secondOrgId },
        {
          authInfo: {
            getProfile: sandbox.stub().returns({
              tenants: [
                { id: 'ABC123' },
                { id: 'BBBBBBBBBBBBBBBBBBBBBBBB' },
              ],
            }),
          },
        },
      );
      const res = await controller.onboard(context);
      expect(res.status).to.equal(200);
      // Verify the org was resolved with the requested imsOrgId
      expect(createOrFindOrganizationStub).to.have.been.calledWith(secondOrgId, sinon.match.any);
    });
  });

  describe('onboard - SSRF protection', () => {
    let controller;
    beforeEach(() => {
      controller = PlgOnboardingController({ log: mockLog });
    });

    const invalidDomains = [
      '../../etc/passwd',
      'domain.com:8080',
      '-invalid.com',
      `${'a'.repeat(254)}.com`,
      'domain..com',
      'nba.com?q=1',
      'nba.com#section',
      'nba.com/kings?q=1',
      'nba.com/kings#section',
      'nba.com/..',
      'nba.com/../etc/passwd',
      'nba.com//kings',
      'nba.com/',
      'nba.com/.hidden',
      'nba.com/v1..0',
      'nba.com/v1.0.',
    ];

    invalidDomains.forEach((invalidDomain) => {
      it(`returns 400 for invalid domain: ${invalidDomain}`, async () => {
        const context = buildContext({ domain: invalidDomain });

        const res = await controller.onboard(context);

        expect(res.status).to.equal(400);
        expect(res.value).to.include('Invalid domain');
      });
    });

    // These are valid hostnames syntactically but point to unsafe addresses
    const unsafeDomains = [
      'myhost.local',
      'service.internal',
      'foo.private.adobe.io',
      'myhost.local/path',
      'service.internal/api',
      'foo.localhost',
      'foo.localhost/api',
    ];

    unsafeDomains.forEach((unsafeDomain) => {
      it(`returns 400 for unsafe domain: ${unsafeDomain}`, async () => {
        const context = buildContext({ domain: unsafeDomain });

        const res = await controller.onboard(context);

        expect(res.status).to.equal(400);
        expect(res.value).to.equal('Invalid domain');
      });
    });

    // These fail domain validation before reaching SSRF check
    const invalidAsDomains = [
      'localhost',
      '127.0.0.1',
      '10.0.0.1',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '0.0.0.0',
      '[::1]',
    ];

    invalidAsDomains.forEach((domain) => {
      it(`returns 400 for invalid/unsafe domain: ${domain}`, async () => {
        const context = buildContext({ domain });

        const res = await controller.onboard(context);

        expect(res.status).to.equal(400);
        expect(res.value).to.include('Invalid domain');
      });
    });

    // Hex/octal/decimal IPv4 literals — WHATWG URL canonicalizes these to private
    // IPs (e.g. 0xa9.254.169.254 → 169.254.169.254 AWS IMDS), bypassing raw-string
    // denylists. Closed at the shared validator (alphabetic TLD requirement) and
    // additionally at isSafeDomain (canonicalize-before-denylist + net.isIP check).
    const hexIpAttacks = [
      ['hex IMDS', '0xa9.254.169.254'],
      ['hex loopback', '0x7f.0.0.1'],
      ['hex RFC1918', '0xa.0.0.1'],
      ['hex all-labels', '0xa9.0xfe.0xa9.0xfe'],
      ['octal IPv4', '0177.0.0.1'],
    ];

    hexIpAttacks.forEach(([label, domain]) => {
      it(`returns 400 for ${label} attack: ${domain}`, async () => {
        const context = buildContext({ domain });
        const res = await controller.onboard(context);
        expect(res.status).to.equal(400);
        expect(res.value).to.include('Invalid domain');
        // Lock that the request never reached the fetch path
        expect(composeBaseURLStub).to.not.have.been.called;
        expect(mockDataAccess.PlgOnboarding.create).to.not.have.been.called;
      });
    });
  });

  describe('onboard - subpath domain support', () => {
    let controller;
    beforeEach(() => {
      controller = PlgOnboardingController({ log: mockLog });
    });

    const validSubpathDomains = [
      'nba.com/kings',
      'nba.com/us/kings',
      'www.example.com/blog',
      'nba.com/v1.0',
      'nba.com/kings.html',
    ];

    validSubpathDomains.forEach((domain) => {
      it(`accepts subpath domain: ${domain}`, async () => {
        const context = buildContext({ domain });
        const res = await controller.onboard(context);
        expect(res.status).to.equal(200);

        // Lock in that the full subpath flows through end-to-end (no silent path-stripping)
        expect(composeBaseURLStub).to.have.been.calledWith(domain);
        expect(mockDataAccess.PlgOnboarding.create).to.have.been.calledWith(
          sinon.match({ domain }),
        );
      });
    });

    // Locks the prepareDomain canonicalization: mixed-case input must be lowercased
    // BEFORE reaching composeBaseURL and PlgOnboarding.create, otherwise the model's
    // schema validator (lowercase-only) would reject the write at the DB layer.
    const mixedCaseCanonicalCases = [
      { input: 'NBA.COM', expected: 'nba.com', desc: 'uppercase host' },
      { input: 'NBA.COM/Kings', expected: 'nba.com/kings', desc: 'uppercase host + path' },
      { input: 'nba.com/Kings', expected: 'nba.com/kings', desc: 'lowercase host, mixed-case path' },
      { input: 'Https://NBA.COM/Kings', expected: 'nba.com/kings', desc: 'mixed-case scheme + host + path' },
    ];

    mixedCaseCanonicalCases.forEach(({ input, expected, desc }) => {
      it(`canonicalizes mixed case: ${desc} (${input} → ${expected})`, async () => {
        const context = buildContext({ domain: input });
        const res = await controller.onboard(context);
        expect(res.status).to.equal(200);
        expect(composeBaseURLStub).to.have.been.calledWith(expected);
        expect(mockDataAccess.PlgOnboarding.create).to.have.been.calledWith(
          sinon.match({ domain: expected }),
        );
      });
    });

    it('accepts scheme-prefixed subpath input (strips https://)', async () => {
      const context = buildContext({ domain: 'https://nba.com/kings' });
      const res = await controller.onboard(context);
      expect(res.status).to.equal(200);
      expect(composeBaseURLStub).to.have.been.calledWith('nba.com/kings');
      expect(mockDataAccess.PlgOnboarding.create).to.have.been.calledWith(
        sinon.match({ domain: 'nba.com/kings' }),
      );
    });

    // Pins stripScheme behavior via the controller boundary (the helper itself is not exported).
    const stripSchemeCases = [
      { input: 'http://nba.com/kings', expected: 'nba.com/kings', desc: 'lowercase http://' },
      { input: 'HTTP://nba.com/kings', expected: 'nba.com/kings', desc: 'uppercase HTTP://' },
      { input: 'HtTpS://nba.com', expected: 'nba.com', desc: 'mixed-case scheme' },
      { input: 'nba.com', expected: 'nba.com', desc: 'schemeless passthrough' },
    ];

    stripSchemeCases.forEach(({ input, expected, desc }) => {
      it(`stripScheme: ${desc} -> ${expected}`, async () => {
        const context = buildContext({ domain: input });
        const res = await controller.onboard(context);
        expect(res.status).to.equal(200);
        expect(composeBaseURLStub).to.have.been.calledWith(expected);
      });
    });

    // Non-http schemes and protocol-relative inputs are NOT stripped; isValidDomain rejects them.
    const stripSchemeRejectCases = [
      { input: 'ftp://nba.com', desc: 'non-http scheme not stripped' },
      { input: '//nba.com', desc: 'protocol-relative not stripped' },
    ];

    stripSchemeRejectCases.forEach(({ input, desc }) => {
      it(`stripScheme: ${desc} -> 400`, async () => {
        const context = buildContext({ domain: input });
        const res = await controller.onboard(context);
        expect(res.status).to.equal(400);
      });
    });
  });

  describe('isSafeDomain (direct unit tests for defense-in-depth)', () => {
    it('returns false when new URL throws on a malformed rawHostname', () => {
      // `[` makes WHATWG URL parser throw (unbalanced bracket).
      expect(isSafeDomain('[')).to.be.false;
    });

    it('returns false when canonicalized hostname is an IPv4 literal', () => {
      // Hex IPv4 canonicalizes to a private IP via new URL.
      expect(isSafeDomain('0xa9.254.169.254')).to.be.false; // → 169.254.169.254 (AWS IMDS)
      expect(isSafeDomain('0x7f.0.0.1')).to.be.false; // → 127.0.0.1
      expect(isSafeDomain('0xa.0.0.1')).to.be.false; // → 10.0.0.1
    });

    it('returns false when canonicalized hostname is bare IPv4', () => {
      expect(isSafeDomain('127.0.0.1')).to.be.false;
      expect(isSafeDomain('10.0.0.1')).to.be.false;
      expect(isSafeDomain('169.254.169.254')).to.be.false;
    });

    it('returns false when canonicalized hostname is a bracketed IPv6 literal', () => {
      // new URL serializes IPv6 with brackets; the bracket-strip in isSafeDomain
      // is what lets net.isIP recognize it. Without the strip, every private/
      // link-local/IPv4-mapped IPv6 form would slip past the backstop.
      expect(isSafeDomain('[fd00::1]')).to.be.false; // RFC 4193 ULA
      expect(isSafeDomain('[fe80::1]')).to.be.false; // RFC 4291 link-local
      expect(isSafeDomain('[::1]')).to.be.false; // loopback
      expect(isSafeDomain('[::ffff:169.254.169.254]')).to.be.false; // IPv4-mapped IMDS
      expect(isSafeDomain('[::ffff:7f00:1]')).to.be.false; // IPv4-mapped loopback
    });

    it('returns false for denylist string matches (non-IP)', () => {
      expect(isSafeDomain('foo.localhost')).to.be.false;
      expect(isSafeDomain('myhost.local')).to.be.false;
      expect(isSafeDomain('service.internal')).to.be.false;
      expect(isSafeDomain('foo.private.adobe.io')).to.be.false;
      expect(isSafeDomain('localhost')).to.be.false;
    });

    it('returns true for legitimate public hostnames', () => {
      expect(isSafeDomain('nba.com')).to.be.true;
      expect(isSafeDomain('nba.com/kings')).to.be.true;
      expect(isSafeDomain('1.2.3.4.example.com')).to.be.true;
    });

    it('extracts hostname from path-qualified domains before checking', () => {
      // The path is stripped before canonicalization so an internal target in the
      // hostname segment cannot be hidden behind a path.
      expect(isSafeDomain('127.0.0.1/some/path')).to.be.false;
      expect(isSafeDomain('myhost.local/api')).to.be.false;
    });
  });
});
