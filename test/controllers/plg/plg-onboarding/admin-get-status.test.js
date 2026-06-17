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
import {
  TEST_IMS_ORG_ID,
  TEST_ORG_ID,
  TEST_PROJECT_ID,
  createSharedMocks,
  createMockSite as createMockSiteShared,
  createMockOnboarding as createMockOnboardingShared,
  createMockDataAccess,
  mockAuthInfo as mockAuthInfoShared,
} from './shared-fixtures.js';
import { createPlgEsmock } from './admin-esmock-factory.js';

use(sinonChai);

describe('PlgOnboardingController - getStatus', function () {
  this.timeout(10000);

  let sandbox;
  let stubs;
  let PlgOnboardingController; // non-admin
  let AdminPlgController; // full admin
  let ReadOnlyAdminPlgController; // read-only admin
  let mockSiteConfig;
  let mockOrganization;
  let mockProject;
  let mockLog;
  let mockSite;
  let mockOnboarding;
  let mockDataAccess;

  function createMockSite(overrides = {}) {
    return createMockSiteShared(sandbox, overrides, mockSiteConfig);
  }
  function createMockOnboarding(overrides = {}) {
    return createMockOnboardingShared(sandbox, overrides);
  }
  function mockAuthInfo(imsOrgId = TEST_IMS_ORG_ID) {
    return mockAuthInfoShared(sandbox, imsOrgId);
  }

  before(async () => {
    sandbox = sinon.createSandbox();
    stubs = { ...createSharedMocks(sandbox), sandbox };
    ({
      mockSiteConfig, mockOrganization, mockProject, mockLog,
    } = stubs);

    [PlgOnboardingController, AdminPlgController, ReadOnlyAdminPlgController] = await Promise.all([
      createPlgEsmock(stubs, { hasAdminAccess: false }),
      createPlgEsmock(stubs, { hasAdminAccess: true }),
      createPlgEsmock(stubs, { hasAdminAccess: false, hasAdminReadAccess: true }),
    ]);
  });

  after(() => sandbox.restore());

  beforeEach(() => {
    sandbox.reset();
    // Re-apply stub defaults after reset
    stubs.composeBaseURLStub.returns('https://example.com');
    stubs.resolveWwwUrlStub.resolves('example.com');
    stubs.loadProfileConfigStub.returns({});
    stubs.ldCreateFromStub.returns({
      getFeatureFlag: stubs.ldGetFeatureFlagStub,
      updateVariationValue: stubs.ldUpdateVariationValueStub,
    });
    stubs.ldGetFeatureFlagStub.resolves({ variations: [{ value: {} }] });
    stubs.rumRetrieveDomainkeyStub.resolves('test-domainkey');
    stubs.detectBotBlockerStub.resolves({ crawlable: true });
    stubs.findDeliveryTypeStub.resolves('aem_edge');
    stubs.deriveProjectNameStub.returns('example.com');
    stubs.queueDeliveryConfigWriterStub.resolves({ ok: true });
    stubs.triggerBrandProfileAgentStub.resolves('exec-123');
    stubs.createOrFindOrganizationStub.resolves(mockOrganization);
    // Re-apply mockOrganization stub defaults (reset clears these too)
    mockOrganization.getId.returns(TEST_ORG_ID);
    mockOrganization.getImsOrgId.returns(TEST_IMS_ORG_ID);
    mockOrganization.getName.returns('Test Org');
    // Re-apply mockProject stub defaults
    mockProject.getId.returns(TEST_PROJECT_ID);
    mockProject.getProjectName.returns('example.com');
    stubs.tierClientCreateEntitlementStub.resolves({
      entitlement: { getId: () => 'ent-1', getOrganizationId: () => 'org-uuid-1', getTier: () => 'PLG' },
      siteEnrollment: { getId: () => 'enroll-1' },
    });
    stubs.tierClientCreateForSiteStub.resolves({
      createEntitlement: stubs.tierClientCreateEntitlementStub,
      checkValidEntitlement: sandbox.stub().resolves({
        entitlement: { getId: () => 'ent-1', getOrganizationId: () => 'org-uuid-1' },
        siteEnrollment: { getId: () => 'enroll-1' },
      }),
    });
    stubs.tierClientCreateForOrgStub.returns({
      createEntitlement: stubs.tierClientCreateEntitlementStub,
      checkValidEntitlement: sandbox.stub().resolves({
        entitlement: {
          getId: () => 'ent-1',
          getOrganizationId: () => 'org-uuid-1',
          getTier: () => 'PLG',
        },
      }),
    });

    mockSite = createMockSite();
    mockOnboarding = createMockOnboarding();
    mockDataAccess = createMockDataAccess(sandbox, {
      mockSite, mockOrganization, mockProject, mockOnboarding,
    });
  });

  // ─── getStatus ───────────────────────────────────────────────────────────────

  describe('getStatus', () => {
    it('returns 400 for invalid imsOrgId', async () => {
      const res = await PlgOnboardingController({ log: mockLog }).getStatus({
        dataAccess: mockDataAccess,
        params: { imsOrgId: 'not-valid' },
        attributes: { authInfo: mockAuthInfo() },
      });
      expect(res.status).to.equal(400);
      expect(res.value).to.equal('Valid imsOrgId is required');
    });

    it('returns 400 for empty imsOrgId', async () => {
      const res = await PlgOnboardingController({ log: mockLog }).getStatus({
        dataAccess: mockDataAccess,
        params: { imsOrgId: '' },
        attributes: { authInfo: mockAuthInfo() },
      });
      expect(res.status).to.equal(400);
    });

    it('returns 403 when caller org does not match requested org', async () => {
      const res = await PlgOnboardingController({ log: mockLog }).getStatus({
        dataAccess: mockDataAccess,
        params: { imsOrgId: 'OTHER999@AdobeOrg' },
        attributes: { authInfo: mockAuthInfo() },
      });
      expect(res.status).to.equal(403);
    });

    it('allows access when requested org matches a non-first tenant', async () => {
      const secondOrgId = 'BBBBBBBBBBBBBBBBBBBBBBBB@AdobeOrg';
      mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([createMockOnboarding()]);

      const res = await PlgOnboardingController({ log: mockLog }).getStatus({
        dataAccess: mockDataAccess,
        params: { imsOrgId: secondOrgId },
        attributes: {
          authInfo: {
            getProfile: sandbox.stub().returns({
              tenants: [{ id: 'ABC123' }, { id: 'BBBBBBBBBBBBBBBBBBBBBBBB' }],
            }),
          },
        },
      });
      expect(res.status).to.equal(200);
    });

    it('returns 400 when authInfo is missing', async () => {
      const res = await PlgOnboardingController({ log: mockLog }).getStatus({
        dataAccess: mockDataAccess,
        params: { imsOrgId: TEST_IMS_ORG_ID },
        attributes: {},
      });
      expect(res.status).to.equal(400);
      expect(res.value).to.equal('Authentication information is required');
    });

    it('returns 400 when profile has no tenants', async () => {
      const res = await PlgOnboardingController({ log: mockLog }).getStatus({
        dataAccess: mockDataAccess,
        params: { imsOrgId: TEST_IMS_ORG_ID },
        attributes: { authInfo: { getProfile: sandbox.stub().returns({}) } },
      });
      expect(res.status).to.equal(400);
      expect(res.value).to.equal('User profile or organization ID not found in authentication token');
    });

    it('returns 404 when no records found', async () => {
      mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([]);

      const res = await PlgOnboardingController({ log: mockLog }).getStatus({
        dataAccess: mockDataAccess,
        params: { imsOrgId: TEST_IMS_ORG_ID },
        attributes: { authInfo: mockAuthInfo() },
      });
      expect(res.status).to.equal(404);
      expect(res.value).to.include('No onboarding records found');
    });

    it('returns onboarding records for valid imsOrgId', async () => {
      const record1 = createMockOnboarding({ id: 'rec-1', domain: 'example1.com', status: 'ONBOARDED' });
      const record2 = createMockOnboarding({ id: 'rec-2', domain: 'example2.com', status: 'IN_PROGRESS' });
      mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([record1, record2]);

      const res = await PlgOnboardingController({ log: mockLog }).getStatus({
        dataAccess: mockDataAccess,
        params: { imsOrgId: TEST_IMS_ORG_ID },
        attributes: { authInfo: mockAuthInfo() },
      });
      expect(res.status).to.equal(200);
      expect(res.value).to.be.an('array').with.length(2);
      expect(res.value[0].domain).to.equal('example1.com');
      expect(res.value[1].domain).to.equal('example2.com');
    });
  });

  // ─── getStatus - admin bypass ─────────────────────────────────────────────

  describe('getStatus - admin bypass', () => {
    it('allows admin to access any org without tenant match', async () => {
      const record = createMockOnboarding({ status: 'ONBOARDED' });
      mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([record]);

      const res = await AdminPlgController({ log: mockLog }).getStatus({
        dataAccess: mockDataAccess,
        params: { imsOrgId: 'COMPLETELY_DIFFERENT@AdobeOrg' },
        attributes: {
          authInfo: {
            getProfile: sandbox.stub().returns({ tenants: [{ id: 'ADMIN_TENANT' }] }),
          },
        },
      });
      expect(res.status).to.equal(200);
      expect(res.value).to.be.an('array').with.length(1);
    });

    it('allows admin even when authInfo has no profile tenants', async () => {
      const record = createMockOnboarding({ status: 'ONBOARDED' });
      mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([record]);

      const res = await AdminPlgController({ log: mockLog }).getStatus({
        dataAccess: mockDataAccess,
        params: { imsOrgId: TEST_IMS_ORG_ID },
        attributes: { authInfo: { getProfile: sandbox.stub().returns(null) } },
      });
      expect(res.status).to.equal(200);
    });

    it('still returns 400 for missing authInfo even as admin path', async () => {
      const res = await AdminPlgController({ log: mockLog }).getStatus({
        dataAccess: mockDataAccess,
        params: { imsOrgId: TEST_IMS_ORG_ID },
        attributes: {},
      });
      expect(res.status).to.equal(400);
      expect(res.value).to.equal('Authentication information is required');
    });

    describe('read-only admin denial', () => {
      it('falls through to tenant check; denies read-only admin on a non-matching org', async () => {
        const res = await ReadOnlyAdminPlgController({ log: mockLog }).getStatus({
          dataAccess: mockDataAccess,
          params: { imsOrgId: 'COMPLETELY_DIFFERENT@AdobeOrg' },
          attributes: {
            authInfo: {
              getProfile: sandbox.stub().returns({ tenants: [{ id: 'READONLY_TENANT' }] }),
            },
          },
        });
        expect(res.status).to.equal(403);
        expect(mockDataAccess.PlgOnboarding.allByImsOrgId).to.not.have.been.called;
      });

      it('does not bypass when read-only admin has no tenants in profile', async () => {
        const res = await ReadOnlyAdminPlgController({ log: mockLog }).getStatus({
          dataAccess: mockDataAccess,
          params: { imsOrgId: TEST_IMS_ORG_ID },
          attributes: { authInfo: { getProfile: sandbox.stub().returns({}) } },
        });
        expect(res.status).to.equal(400);
        expect(res.value).to.equal('User profile or organization ID not found in authentication token');
      });
    });

    describe('getAllOnboardings', () => {
      beforeEach(() => {
        mockDataAccess.PlgOnboarding.all.reset();
        mockDataAccess.PlgOnboarding.all.resolves([]);
      });

      it('returns 403 when caller is not admin', async () => {
        const res = await PlgOnboardingController({ log: mockLog }).getAllOnboardings({
          dataAccess: mockDataAccess,
          log: mockLog,
        });
        expect(res.status).to.equal(403);
        expect(res.value).to.equal('Only admins can list all PLG onboarding records');
        expect(mockDataAccess.PlgOnboarding.all).to.not.have.been.called;
      });

      it('returns 200 with all records when admin', async () => {
        const record = createMockOnboarding({ id: 'all-rec-1', domain: 'plg-all.example.com', status: 'ONBOARDED' });
        mockDataAccess.PlgOnboarding.all.resolves([record]);

        const res = await AdminPlgController({ log: mockLog }).getAllOnboardings({
          dataAccess: mockDataAccess,
          log: mockLog,
        });
        expect(res.status).to.equal(200);
        expect(res.value).to.be.an('array').with.length(1);
        expect(res.value[0].id).to.equal('all-rec-1');
        expect(res.value[0].domain).to.equal('plg-all.example.com');
        expect(mockDataAccess.PlgOnboarding.all)
          .to.have.been.calledOnceWith({}, { fetchAllPages: true });
      });

      it('returns 200 and passes limit when admin sends limit', async () => {
        mockDataAccess.PlgOnboarding.all.resolves([]);

        const res = await AdminPlgController({ log: mockLog }).getAllOnboardings({
          dataAccess: mockDataAccess,
          log: mockLog,
          data: { limit: '50' },
        });
        expect(res.status).to.equal(200);
        expect(mockDataAccess.PlgOnboarding.all).to.have.been.calledOnceWith({}, { limit: 50 });
      });

      it('returns 200 with one-item array when limit is 1 (data access returns single instance)', async () => {
        const record = createMockOnboarding({ id: 'limit-1-rec', domain: 'one.example.com', status: 'ONBOARDED' });
        mockDataAccess.PlgOnboarding.all.resolves(record);

        const res = await AdminPlgController({ log: mockLog }).getAllOnboardings({
          dataAccess: mockDataAccess,
          log: mockLog,
          data: { limit: '1' },
        });
        expect(res.status).to.equal(200);
        expect(res.value).to.be.an('array').with.length(1);
        expect(res.value[0].id).to.equal('limit-1-rec');
        expect(mockDataAccess.PlgOnboarding.all).to.have.been.calledOnceWith({}, { limit: 1 });
      });

      it('returns 200 with empty array when limit is 1 and data access returns null', async () => {
        mockDataAccess.PlgOnboarding.all.resolves(null);

        const res = await AdminPlgController({ log: mockLog }).getAllOnboardings({
          dataAccess: mockDataAccess, log: mockLog, data: { limit: '1' },
        });
        expect(res.status).to.equal(200);
        expect(res.value).to.be.an('array').that.is.empty;
      });

      it('returns 200 with empty array when limit is 1 and data access returns undefined', async () => {
        mockDataAccess.PlgOnboarding.all.resolves(undefined);

        const res = await AdminPlgController({ log: mockLog }).getAllOnboardings({
          dataAccess: mockDataAccess, log: mockLog, data: { limit: '1' },
        });
        expect(res.status).to.equal(200);
        expect(res.value).to.be.an('array').that.is.empty;
      });

      it('returns 500 when data access returns a non-model value', async () => {
        mockDataAccess.PlgOnboarding.all.resolves(0);

        const res = await AdminPlgController({ log: mockLog }).getAllOnboardings({
          dataAccess: mockDataAccess, log: mockLog, data: { limit: '1' },
        });
        expect(res.status).to.equal(500);
        expect(res.value).to.equal('Failed to list PLG onboarding records');
        expect(mockLog.error).to.have.been.calledWithMatch(sinon.match(/^Unexpected PLG onboarding list result shape/));
      });

      it('returns 500 when DTO serialization throws an Error', async () => {
        const record = createMockOnboarding({ id: 'bad-ser' });
        record.getId.throws(new Error('broken model'));
        mockDataAccess.PlgOnboarding.all.resolves([record]);

        const res = await AdminPlgController({ log: mockLog }).getAllOnboardings({
          dataAccess: mockDataAccess, log: mockLog,
        });
        expect(res.status).to.equal(500);
        expect(res.value).to.equal('Failed to serialize PLG onboarding records');
        expect(mockLog.error).to.have.been.calledWithMatch(sinon.match(/^Failed to serialize PLG onboarding records: broken model/));
      });

      it('returns 500 when DTO serialization throws a non-Error', async () => {
        const record = createMockOnboarding();
        record.getId.callsFake(() => {
          // eslint-disable-next-line no-throw-literal -- non-Error catch branch in controller
          throw 'not an Error object';
        });
        mockDataAccess.PlgOnboarding.all.resolves([record]);

        const res = await AdminPlgController({ log: mockLog }).getAllOnboardings({
          dataAccess: mockDataAccess, log: mockLog,
        });
        expect(res.status).to.equal(500);
        expect(res.value).to.equal('Failed to serialize PLG onboarding records');
        expect(mockLog.error).to.have.been.calledWithMatch(sinon.match(/^Failed to serialize PLG onboarding records: not an Error object/));
      });

      it('returns 400 when limit is not a positive integer', async () => {
        const res = await AdminPlgController({ log: mockLog }).getAllOnboardings({
          dataAccess: mockDataAccess, log: mockLog, data: { limit: '0' },
        });
        expect(res.status).to.equal(400);
        expect(res.value).to.equal('limit must be a positive integer');
        expect(mockDataAccess.PlgOnboarding.all).to.not.have.been.called;
      });

      it('returns 400 when limit is a decimal string (not an integer token)', async () => {
        const res = await AdminPlgController({ log: mockLog }).getAllOnboardings({
          dataAccess: mockDataAccess, log: mockLog, data: { limit: '1.5' },
        });
        expect(res.status).to.equal(400);
        expect(res.value).to.equal('limit must be a positive integer');
      });

      it('returns 400 when limit has trailing non-digits', async () => {
        const res = await AdminPlgController({ log: mockLog }).getAllOnboardings({
          dataAccess: mockDataAccess, log: mockLog, data: { limit: '50abc' },
        });
        expect(res.status).to.equal(400);
        expect(res.value).to.equal('limit must be a positive integer');
      });

      it('returns 400 when limit is negative', async () => {
        const res = await AdminPlgController({ log: mockLog }).getAllOnboardings({
          dataAccess: mockDataAccess, log: mockLog, data: { limit: '-1' },
        });
        expect(res.status).to.equal(400);
        expect(res.value).to.equal('limit must be a positive integer');
      });

      it('returns 500 when data access fails', async () => {
        mockDataAccess.PlgOnboarding.all.rejects(new Error('db unavailable'));

        const res = await AdminPlgController({ log: mockLog }).getAllOnboardings({
          dataAccess: mockDataAccess, log: mockLog,
        });
        expect(res.status).to.equal(500);
        expect(res.value).to.equal('Failed to list PLG onboarding records');
        expect(mockLog.error).to.have.been.calledWithMatch(sinon.match(/^Failed to list PLG onboardings: db unavailable/));
      });

      it('returns 500 when data access rejects with a non-Error', async () => {
        /* eslint-disable-next-line prefer-promise-reject-errors -- non-Error catch in controller */
        mockDataAccess.PlgOnboarding.all.returns(Promise.reject('connection reset'));

        const res = await AdminPlgController({ log: mockLog }).getAllOnboardings({
          dataAccess: mockDataAccess, log: mockLog,
        });
        expect(res.status).to.equal(500);
        expect(res.value).to.equal('Failed to list PLG onboarding records');
        expect(mockLog.error).to.have.been.calledWithMatch(sinon.match(/^Failed to list PLG onboardings: connection reset/));
      });

      it('resolves updatedBy to email via getImsAdminProfile when updatedBy is set', async () => {
        const record = createMockOnboarding({ updatedBy: 'user-ims-id@AdobeID' });
        mockDataAccess.PlgOnboarding.all.resolves([record]);
        const mockImsClient = { getImsAdminProfile: sandbox.stub().resolves({ email: 'user@example.com' }) };

        const res = await AdminPlgController({ log: mockLog }).getAllOnboardings({
          dataAccess: mockDataAccess, imsClient: mockImsClient, log: mockLog,
        });
        expect(res.status).to.equal(200);
        expect(res.value[0].updatedBy).to.equal('user@example.com');
        expect(mockImsClient.getImsAdminProfile).to.have.been.calledOnceWith('user-ims-id@AdobeID');
      });

      it('falls back to IMS ID when getImsAdminProfile returns no email', async () => {
        const record = createMockOnboarding({ updatedBy: 'user-ims-id@AdobeID' });
        mockDataAccess.PlgOnboarding.all.resolves([record]);
        const mockImsClient = { getImsAdminProfile: sandbox.stub().resolves({}) };

        const res = await AdminPlgController({ log: mockLog }).getAllOnboardings({
          dataAccess: mockDataAccess, imsClient: mockImsClient, log: mockLog,
        });
        expect(res.status).to.equal(200);
        expect(res.value[0].updatedBy).to.equal('user-ims-id@AdobeID');
      });

      it('falls back to IMS ID when getImsAdminProfile fails', async () => {
        const record = createMockOnboarding({ updatedBy: 'bad-ims-id@AdobeID' });
        mockDataAccess.PlgOnboarding.all.resolves([record]);
        const mockImsClient = { getImsAdminProfile: sandbox.stub().rejects(new Error('IMS unavailable')) };

        const res = await AdminPlgController({ log: mockLog }).getAllOnboardings({
          dataAccess: mockDataAccess, imsClient: mockImsClient, log: mockLog,
        });
        expect(res.status).to.equal(200);
        expect(res.value[0].updatedBy).to.equal('bad-ims-id@AdobeID');
        expect(mockLog.warn).to.have.been.calledWithMatch(sinon.match(/Failed to resolve email for IMS ID bad-ims-id@AdobeID/));
      });

      it('resolves reviewedBy IMS IDs to emails in reviews array', async () => {
        const record = createMockOnboarding({ reviews: [{ reviewedBy: 'reviewer-ims-id@AdobeID', decision: 'BYPASSED', reason: 'test' }] });
        mockDataAccess.PlgOnboarding.all.resolves([record]);
        const mockImsClient = { getImsAdminProfile: sandbox.stub().resolves({ email: 'reviewer@example.com' }) };

        const res = await AdminPlgController({ log: mockLog }).getAllOnboardings({
          dataAccess: mockDataAccess, imsClient: mockImsClient, log: mockLog,
        });
        expect(res.status).to.equal(200);
        expect(res.value[0].reviews[0].reviewedBy).to.equal('reviewer@example.com');
        expect(mockImsClient.getImsAdminProfile).to.have.been.calledOnceWith('reviewer-ims-id@AdobeID');
      });

      it('keeps reviewedBy as-is when not resolvable (e.g. "admin")', async () => {
        const record = createMockOnboarding({ reviews: [{ reviewedBy: 'admin', decision: 'UPHELD', reason: 'test' }] });
        mockDataAccess.PlgOnboarding.all.resolves([record]);
        const mockImsClient = { getImsAdminProfile: sandbox.stub() };

        const res = await AdminPlgController({ log: mockLog }).getAllOnboardings({
          dataAccess: mockDataAccess, imsClient: mockImsClient, log: mockLog,
        });
        expect(res.status).to.equal(200);
        expect(res.value[0].reviews[0].reviewedBy).to.equal('admin');
        expect(mockImsClient.getImsAdminProfile).to.not.have.been.called;
      });

      it('sets updatedBy to null when updatedBy is null (system-triggered onboarding)', async () => {
        const record = createMockOnboarding({ updatedBy: null });
        mockDataAccess.PlgOnboarding.all.resolves([record]);
        const mockImsClient = { getImsAdminProfile: sandbox.stub() };

        const res = await AdminPlgController({ log: mockLog }).getAllOnboardings({
          dataAccess: mockDataAccess, imsClient: mockImsClient, log: mockLog,
        });
        expect(res.status).to.equal(200);
        expect(res.value[0].updatedBy).to.be.null;
        expect(mockImsClient.getImsAdminProfile).to.not.have.been.called;
      });

      it('resolves createdBy to email via getImsAdminProfile when createdBy is set', async () => {
        const record = createMockOnboarding({ createdBy: 'creator-ims-id@AdobeID' });
        mockDataAccess.PlgOnboarding.all.resolves([record]);
        const mockImsClient = { getImsAdminProfile: sandbox.stub().resolves({ email: 'creator@example.com' }) };

        const res = await AdminPlgController({ log: mockLog }).getAllOnboardings({
          dataAccess: mockDataAccess, imsClient: mockImsClient, log: mockLog,
        });
        expect(res.status).to.equal(200);
        expect(res.value[0].createdBy).to.equal('creator@example.com');
        expect(mockImsClient.getImsAdminProfile).to.have.been.calledOnceWith('creator-ims-id@AdobeID');
      });

      it('falls back to IMS ID for createdBy when getImsAdminProfile returns no email', async () => {
        const record = createMockOnboarding({ createdBy: 'creator-ims-id@AdobeID' });
        mockDataAccess.PlgOnboarding.all.resolves([record]);
        const mockImsClient = { getImsAdminProfile: sandbox.stub().resolves({}) };

        const res = await AdminPlgController({ log: mockLog }).getAllOnboardings({
          dataAccess: mockDataAccess, imsClient: mockImsClient, log: mockLog,
        });
        expect(res.status).to.equal(200);
        expect(res.value[0].createdBy).to.equal('creator-ims-id@AdobeID');
      });

      it('skips IMS resolution for createdBy when value is "system"', async () => {
        const record = createMockOnboarding({ createdBy: 'system' });
        mockDataAccess.PlgOnboarding.all.resolves([record]);
        const mockImsClient = { getImsAdminProfile: sandbox.stub() };

        const res = await AdminPlgController({ log: mockLog }).getAllOnboardings({
          dataAccess: mockDataAccess, imsClient: mockImsClient, log: mockLog,
        });
        expect(res.status).to.equal(200);
        expect(res.value[0].createdBy).to.equal('system');
        expect(mockImsClient.getImsAdminProfile).to.not.have.been.called;
      });

      it('sets createdBy to null when createdBy is null', async () => {
        const record = createMockOnboarding({ createdBy: null });
        mockDataAccess.PlgOnboarding.all.resolves([record]);
        const mockImsClient = { getImsAdminProfile: sandbox.stub() };

        const res = await AdminPlgController({ log: mockLog }).getAllOnboardings({
          dataAccess: mockDataAccess, imsClient: mockImsClient, log: mockLog,
        });
        expect(res.status).to.equal(200);
        expect(res.value[0].createdBy).to.be.null;
      });

      it('deduplicates IMS IDs across createdBy and updatedBy', async () => {
        const sharedImsId = 'shared-ims-id@AdobeID';
        const record = createMockOnboarding({ createdBy: sharedImsId, updatedBy: sharedImsId });
        mockDataAccess.PlgOnboarding.all.resolves([record]);
        const mockImsClient = { getImsAdminProfile: sandbox.stub().resolves({ email: 'shared@example.com' }) };

        const res = await AdminPlgController({ log: mockLog }).getAllOnboardings({
          dataAccess: mockDataAccess, imsClient: mockImsClient, log: mockLog,
        });
        expect(res.status).to.equal(200);
        expect(res.value[0].createdBy).to.equal('shared@example.com');
        expect(res.value[0].updatedBy).to.equal('shared@example.com');
        expect(mockImsClient.getImsAdminProfile).to.have.been.calledOnce;
      });
    });
  });
});
