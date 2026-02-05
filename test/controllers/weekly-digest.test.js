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

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import esmock from 'esmock';

import AccessControlUtil from '../../src/support/access-control-util.js';

use(chaiAsPromised);
use(sinonChai);

describe('Weekly Digest Controller', () => {
  const sandbox = sinon.createSandbox();
  let WeeklyDigestController;

  const orgId = '123e4567-e89b-12d3-a456-426614174000';
  const org2Id = '223e4567-e89b-12d3-a456-426614174001';

  const mockLog = {
    info: sandbox.stub(),
    error: sandbox.stub(),
    debug: sandbox.stub(),
    warn: sandbox.stub(),
  };

  const mockEnv = {
    LLMO_HLX_API_KEY: 'test-hlx-key',
    DIGEST_JOBS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/123456789/spacecat-digest-jobs',
  };

  const mockSqs = {
    sendMessage: sandbox.stub().resolves(),
  };

  const mockOrganization = {
    getId: () => orgId,
    getName: () => 'Test Organization',
  };

  const mockSiteWithLlmo = {
    getId: () => 'site-1',
    getBaseURL: () => 'https://example.com',
    getOrganizationId: () => orgId,
    getConfig: () => ({
      llmo: {
        dataFolder: 'test-folder',
        brandName: 'Test Brand',
      },
    }),
  };

  const mockSiteWithLlmoOrg2 = {
    getId: () => 'site-2',
    getBaseURL: () => 'https://other.com',
    getOrganizationId: () => org2Id,
    getConfig: () => ({
      llmo: {
        dataFolder: 'other-folder',
        brandName: 'Other Brand',
      },
    }),
  };

  const mockSiteWithoutLlmo = {
    getId: () => 'site-3',
    getBaseURL: () => 'https://nollmo.com',
    getOrganizationId: () => orgId,
    getConfig: () => ({}),
  };

  const mockTrialUser = {
    getId: () => 'user-1',
    getEmailId: () => 'user@example.com',
    getFirstName: () => 'John',
    getLastName: () => 'Doe',
    getStatus: () => 'REGISTERED',
    getMetadata: () => ({}),
  };

  const mockOptedOutUser = {
    getId: () => 'user-2',
    getEmailId: () => 'optedout@example.com',
    getFirstName: () => 'Jane',
    getLastName: () => 'Smith',
    getStatus: () => 'REGISTERED',
    getMetadata: () => ({ emailPreferences: { weeklyDigest: false } }),
  };

  const mockBlockedUser = {
    getId: () => 'user-3',
    getEmailId: () => 'blocked@example.com',
    getFirstName: () => 'Blocked',
    getLastName: () => 'User',
    getStatus: () => 'BLOCKED',
    getMetadata: () => ({}),
  };

  let mockDataAccess;
  let mockCalculateOverviewMetrics;
  let mockSendWeeklyDigestEmail;
  let mockAccessControlUtil;

  beforeEach(async () => {
    sandbox.restore();
    mockLog.info.reset();
    mockLog.error.reset();
    mockLog.debug.reset();
    mockLog.warn.reset();
    // Reset and re-configure the SQS mock (sandbox.restore() removes the resolves behavior)
    mockSqs.sendMessage = sandbox.stub().resolves();

    // Stub AccessControlUtil.fromContext to return a mock instance
    mockAccessControlUtil = {
      hasAdminAccess: sandbox.stub().returns(true),
    };
    sandbox.stub(AccessControlUtil, 'fromContext')
      .returns(mockAccessControlUtil);

    mockDataAccess = {
      Site: {
        all: sandbox.stub().resolves([mockSiteWithLlmo, mockSiteWithoutLlmo]),
        findById: sandbox.stub(),
      },
      Organization: {
        findById: sandbox.stub().resolves(mockOrganization),
      },
      TrialUser: {
        allByOrganizationId: sandbox.stub().resolves([mockTrialUser]),
      },
    };

    // Setup Site.findById to return the right site
    mockDataAccess.Site.findById.withArgs('site-1').resolves(mockSiteWithLlmo);
    mockDataAccess.Site.findById.withArgs('site-2').resolves(mockSiteWithLlmoOrg2);

    mockCalculateOverviewMetrics = sandbox.stub().resolves({
      hasData: true,
      visibilityScore: 85,
      visibilityDelta: '+5%',
      mentionsCount: 100,
      mentionsDelta: '+10%',
      citationsCount: 50,
      citationsDelta: '-5%',
      dateRange: 'Jan 1 - Jan 7, 2025',
    });

    mockSendWeeklyDigestEmail = sandbox.stub().resolves({ success: true });

    WeeklyDigestController = await esmock('../../src/controllers/weekly-digest.js', {
      '../../src/support/overview-metrics-calculator.js': {
        calculateOverviewMetrics: mockCalculateOverviewMetrics,
      },
      '../../src/support/email-service.js': {
        sendWeeklyDigestEmail: mockSendWeeklyDigestEmail,
      },
    });
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('Constructor Validation', () => {
    it('should throw error when context is not provided', () => {
      expect(() => WeeklyDigestController()).to.throw('Context required');
    });

    it('should throw error when context is null', () => {
      expect(() => WeeklyDigestController(null)).to.throw('Context required');
    });

    it('should throw error when dataAccess is missing', () => {
      expect(() => WeeklyDigestController({ someOther: 'value' })).to.throw('Data access required');
    });

    it('should throw error when dataAccess is null', () => {
      expect(() => WeeklyDigestController({ dataAccess: null })).to.throw('Data access required');
    });
  });

  describe('triggerWeeklyDigests', () => {
    let controller;

    beforeEach(() => {
      controller = WeeklyDigestController({ dataAccess: mockDataAccess }, mockLog);
    });

    it('should queue messages for each organization with LLMO-enabled sites', async () => {
      const allSites = [mockSiteWithLlmo, mockSiteWithLlmoOrg2, mockSiteWithoutLlmo];
      mockDataAccess.Site.all.resolves(allSites);

      const context = {
        log: mockLog,
        env: mockEnv,
        sqs: mockSqs,
      };

      const result = await controller.triggerWeeklyDigests(context);

      expect(result.status).to.equal(202);
      const body = await result.json();
      expect(body.message).to.equal('Weekly digest jobs queued for processing');
      expect(body.stats.organizationsQueued).to.equal(2);
      expect(body.stats.llmoEnabledSites).to.equal(2);
      expect(mockSqs.sendMessage).to.have.been.calledTwice;
    });

    it('should return error when DIGEST_JOBS_QUEUE_URL not configured', async () => {
      const context = {
        log: mockLog,
        env: { LLMO_HLX_API_KEY: 'test' }, // No queue URL
        sqs: mockSqs,
      };

      const result = await controller.triggerWeeklyDigests(context);

      expect(result.status).to.equal(500);
    });

    it('should handle no LLMO-enabled sites', async () => {
      mockDataAccess.Site.all.resolves([mockSiteWithoutLlmo]);

      const context = {
        log: mockLog,
        env: mockEnv,
        sqs: mockSqs,
      };

      const result = await controller.triggerWeeklyDigests(context);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.message).to.equal('No LLMO-enabled sites found');
      expect(mockSqs.sendMessage).to.not.have.been.called;
    });

    it('should handle SQS send failures gracefully', async () => {
      mockSqs.sendMessage.rejects(new Error('SQS error'));

      const context = {
        log: mockLog,
        env: mockEnv,
        sqs: mockSqs,
      };

      const result = await controller.triggerWeeklyDigests(context);

      expect(result.status).to.equal(202);
      const body = await result.json();
      expect(body.stats.queueErrors).to.equal(1);
    });

    it('should handle fatal errors', async () => {
      mockDataAccess.Site.all.rejects(new Error('Database error'));

      const context = {
        log: mockLog,
        env: mockEnv,
        sqs: mockSqs,
      };

      const result = await controller.triggerWeeklyDigests(context);

      expect(result.status).to.equal(500);
    });

    it('should send correct message format to SQS', async () => {
      const context = {
        log: mockLog,
        env: mockEnv,
        sqs: mockSqs,
      };

      await controller.triggerWeeklyDigests(context);

      const sentMessage = mockSqs.sendMessage.getCall(0).args[1];
      expect(sentMessage.type).to.equal('weekly-digest-org');
      expect(sentMessage.organizationId).to.equal(orgId);
      expect(sentMessage.siteIds).to.deep.equal(['site-1']);
      expect(sentMessage.triggeredAt).to.be.a('string');
    });

    it('should filter sites by LLMO config correctly', async () => {
      const siteWithLlmoMethod = {
        getId: () => 'site-method',
        getBaseURL: () => 'https://method.com',
        getOrganizationId: () => orgId,
        getConfig: () => ({
          getLlmoConfig: () => ({
            dataFolder: 'method-folder',
          }),
        }),
      };
      mockDataAccess.Site.all.resolves([siteWithLlmoMethod]);

      const context = {
        log: mockLog,
        env: mockEnv,
        sqs: mockSqs,
      };

      const result = await controller.triggerWeeklyDigests(context);

      expect(result.status).to.equal(202);
      expect(mockSqs.sendMessage).to.have.been.calledOnce;
    });

    it('should return 403 when user is not admin', async () => {
      mockAccessControlUtil.hasAdminAccess.returns(false);

      const context = {
        log: mockLog,
        env: mockEnv,
        sqs: mockSqs,
      };

      const result = await controller.triggerWeeklyDigests(context);

      expect(result.status).to.equal(403);
      const body = await result.json();
      expect(body.message).to.include('Only admins');
    });
  });

  describe('processOrganizationDigest', () => {
    let controller;

    beforeEach(() => {
      controller = WeeklyDigestController({ dataAccess: mockDataAccess }, mockLog);
    });

    it('should process organization digest successfully', async () => {
      const context = {
        log: mockLog,
        env: mockEnv,
        data: {
          type: 'weekly-digest-org',
          organizationId: orgId,
          siteIds: ['site-1'],
        },
      };

      const result = await controller.processOrganizationDigest(context);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.message).to.equal('Organization digest processing complete');
      expect(body.sitesProcessed).to.equal(1);
      expect(body.totalEmailsSent).to.equal(1);
    });

    it('should reject when data is undefined', async () => {
      const context = {
        log: mockLog,
        env: mockEnv,
        // data is undefined
      };

      const result = await controller.processOrganizationDigest(context);

      expect(result.status).to.equal(400);
    });

    it('should reject invalid job type', async () => {
      const context = {
        log: mockLog,
        env: mockEnv,
        data: {
          type: 'invalid-type',
          organizationId: orgId,
          siteIds: ['site-1'],
        },
      };

      const result = await controller.processOrganizationDigest(context);

      expect(result.status).to.equal(400);
    });

    it('should reject missing organizationId', async () => {
      const context = {
        log: mockLog,
        env: mockEnv,
        data: {
          type: 'weekly-digest-org',
          siteIds: ['site-1'],
        },
      };

      const result = await controller.processOrganizationDigest(context);

      expect(result.status).to.equal(400);
    });

    it('should reject missing siteIds', async () => {
      const context = {
        log: mockLog,
        env: mockEnv,
        data: {
          type: 'weekly-digest-org',
          organizationId: orgId,
        },
      };

      const result = await controller.processOrganizationDigest(context);

      expect(result.status).to.equal(400);
    });

    it('should reject empty siteIds', async () => {
      const context = {
        log: mockLog,
        env: mockEnv,
        data: {
          type: 'weekly-digest-org',
          organizationId: orgId,
          siteIds: [],
        },
      };

      const result = await controller.processOrganizationDigest(context);

      expect(result.status).to.equal(400);
    });

    it('should return error when organization not found', async () => {
      mockDataAccess.Organization.findById.resolves(null);

      const context = {
        log: mockLog,
        env: mockEnv,
        data: {
          type: 'weekly-digest-org',
          organizationId: 'nonexistent',
          siteIds: ['site-1'],
        },
      };

      const result = await controller.processOrganizationDigest(context);

      expect(result.status).to.equal(400);
    });

    it('should skip when no eligible users', async () => {
      mockDataAccess.TrialUser.allByOrganizationId.resolves([mockOptedOutUser]);

      const context = {
        log: mockLog,
        env: mockEnv,
        data: {
          type: 'weekly-digest-org',
          organizationId: orgId,
          siteIds: ['site-1'],
        },
      };

      const result = await controller.processOrganizationDigest(context);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.message).to.equal('No eligible users for organization');
      expect(body.sitesSkipped).to.equal(1);
    });

    it('should filter out opted-out users', async () => {
      mockDataAccess.TrialUser.allByOrganizationId.resolves([mockTrialUser, mockOptedOutUser]);

      const context = {
        log: mockLog,
        env: mockEnv,
        data: {
          type: 'weekly-digest-org',
          organizationId: orgId,
          siteIds: ['site-1'],
        },
      };

      await controller.processOrganizationDigest(context);

      expect(mockSendWeeklyDigestEmail).to.have.been.calledOnce;
    });

    it('should filter out blocked users', async () => {
      mockDataAccess.TrialUser.allByOrganizationId.resolves([mockTrialUser, mockBlockedUser]);

      const context = {
        log: mockLog,
        env: mockEnv,
        data: {
          type: 'weekly-digest-org',
          organizationId: orgId,
          siteIds: ['site-1'],
        },
      };

      await controller.processOrganizationDigest(context);

      expect(mockSendWeeklyDigestEmail).to.have.been.calledOnce;
    });

    it('should skip sites not found', async () => {
      mockDataAccess.Site.findById.withArgs('nonexistent').resolves(null);

      const context = {
        log: mockLog,
        env: mockEnv,
        data: {
          type: 'weekly-digest-org',
          organizationId: orgId,
          siteIds: ['nonexistent'],
        },
      };

      const result = await controller.processOrganizationDigest(context);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.sitesSkipped).to.equal(1);
    });

    it('should skip sites with no metrics data', async () => {
      mockCalculateOverviewMetrics.resolves({ hasData: false });

      const context = {
        log: mockLog,
        env: mockEnv,
        data: {
          type: 'weekly-digest-org',
          organizationId: orgId,
          siteIds: ['site-1'],
        },
      };

      const result = await controller.processOrganizationDigest(context);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.sitesSkipped).to.equal(1);
      expect(mockSendWeeklyDigestEmail).to.not.have.been.called;
    });

    it('should handle email send failures', async () => {
      mockSendWeeklyDigestEmail.resolves({ success: false, error: 'Email failed' });

      const context = {
        log: mockLog,
        env: mockEnv,
        data: {
          type: 'weekly-digest-org',
          organizationId: orgId,
          siteIds: ['site-1'],
        },
      };

      const result = await controller.processOrganizationDigest(context);
      const body = await result.json();

      expect(body.totalEmailsFailed).to.equal(1);
    });

    it('should handle email send exceptions', async () => {
      mockSendWeeklyDigestEmail.rejects(new Error('Network error'));

      const context = {
        log: mockLog,
        env: mockEnv,
        data: {
          type: 'weekly-digest-org',
          organizationId: orgId,
          siteIds: ['site-1'],
        },
      };

      const result = await controller.processOrganizationDigest(context);
      const body = await result.json();

      expect(body.totalEmailsFailed).to.equal(1);
    });

    it('should send correct email parameters', async () => {
      const context = {
        log: mockLog,
        env: mockEnv,
        data: {
          type: 'weekly-digest-org',
          organizationId: orgId,
          siteIds: ['site-1'],
        },
      };

      await controller.processOrganizationDigest(context);

      const emailCall = mockSendWeeklyDigestEmail.getCall(0);
      expect(emailCall.args[0].brandName).to.equal('Test Brand');
      expect(emailCall.args[0].orgName).to.equal('Test Organization');
      expect(emailCall.args[0].customerName).to.equal('John Doe');
      expect(emailCall.args[0].overviewUrl).to.include('https://llmo.now');
      expect(emailCall.args[0].settingsUrl).to.include('https://llmo.now');
    });

    it('should fall back to domain when brand name not configured', async () => {
      const siteNoBrandName = {
        getId: () => 'site-1',
        getBaseURL: () => 'https://example.com',
        getOrganizationId: () => orgId,
        getConfig: () => ({
          llmo: {
            dataFolder: 'test-folder',
          },
        }),
      };
      mockDataAccess.Site.findById.withArgs('site-1').resolves(siteNoBrandName);

      const context = {
        log: mockLog,
        env: mockEnv,
        data: {
          type: 'weekly-digest-org',
          organizationId: orgId,
          siteIds: ['site-1'],
        },
      };

      await controller.processOrganizationDigest(context);

      const emailCall = mockSendWeeklyDigestEmail.getCall(0);
      expect(emailCall.args[0].brandName).to.equal('example.com');
    });

    it('should use first name only when last name is dash', async () => {
      const userFirstNameOnly = {
        ...mockTrialUser,
        getFirstName: () => 'John',
        getLastName: () => '-',
      };
      mockDataAccess.TrialUser.allByOrganizationId.resolves([userFirstNameOnly]);

      const context = {
        log: mockLog,
        env: mockEnv,
        data: {
          type: 'weekly-digest-org',
          organizationId: orgId,
          siteIds: ['site-1'],
        },
      };

      await controller.processOrganizationDigest(context);

      const emailCall = mockSendWeeklyDigestEmail.getCall(0);
      expect(emailCall.args[0].customerName).to.equal('John');
    });

    it('should fall back to email when name is missing', async () => {
      const userNoName = {
        ...mockTrialUser,
        getFirstName: () => '-',
        getLastName: () => '-',
      };
      mockDataAccess.TrialUser.allByOrganizationId.resolves([userNoName]);

      const context = {
        log: mockLog,
        env: mockEnv,
        data: {
          type: 'weekly-digest-org',
          organizationId: orgId,
          siteIds: ['site-1'],
        },
      };

      await controller.processOrganizationDigest(context);

      const emailCall = mockSendWeeklyDigestEmail.getCall(0);
      expect(emailCall.args[0].customerName).to.equal('user@example.com');
    });

    it('should handle null metadata in opt-out check', async () => {
      const userNullMetadata = {
        ...mockTrialUser,
        getMetadata: () => null,
      };
      mockDataAccess.TrialUser.allByOrganizationId.resolves([userNullMetadata]);

      const context = {
        log: mockLog,
        env: mockEnv,
        data: {
          type: 'weekly-digest-org',
          organizationId: orgId,
          siteIds: ['site-1'],
        },
      };

      const result = await controller.processOrganizationDigest(context);
      const body = await result.json();

      // User with null metadata should default to opted-in
      expect(body.totalEmailsSent).to.equal(1);
    });

    it('should handle fatal errors', async () => {
      mockDataAccess.Organization.findById.rejects(new Error('Database error'));

      const context = {
        log: mockLog,
        env: mockEnv,
        data: {
          type: 'weekly-digest-org',
          organizationId: orgId,
          siteIds: ['site-1'],
        },
      };

      const result = await controller.processOrganizationDigest(context);

      expect(result.status).to.equal(500);
    });

    it('should use getLlmoConfig method when llmo property is not present', async () => {
      const siteWithLlmoMethod = {
        getId: () => 'site-1',
        getBaseURL: () => 'https://method-site.com',
        getOrganizationId: () => orgId,
        getConfig: () => ({
          getLlmoConfig: () => ({
            dataFolder: 'method-folder',
            brandName: 'Method Brand',
          }),
        }),
      };
      mockDataAccess.Site.findById.withArgs('site-1').resolves(siteWithLlmoMethod);

      const context = {
        log: mockLog,
        env: mockEnv,
        data: {
          type: 'weekly-digest-org',
          organizationId: orgId,
          siteIds: ['site-1'],
        },
      };

      await controller.processOrganizationDigest(context);

      const emailCall = mockSendWeeklyDigestEmail.getCall(0);
      expect(emailCall.args[0].brandName).to.equal('Method Brand');
    });

    it('should fall back to baseURL when URL parsing fails', async () => {
      const siteWithInvalidUrl = {
        getId: () => 'site-1',
        getBaseURL: () => 'not-a-valid-url',
        getOrganizationId: () => orgId,
        getConfig: () => ({
          llmo: {
            dataFolder: 'test-folder',
          },
        }),
      };
      mockDataAccess.Site.findById.withArgs('site-1').resolves(siteWithInvalidUrl);

      const context = {
        log: mockLog,
        env: mockEnv,
        data: {
          type: 'weekly-digest-org',
          organizationId: orgId,
          siteIds: ['site-1'],
        },
      };

      await controller.processOrganizationDigest(context);

      const emailCall = mockSendWeeklyDigestEmail.getCall(0);
      expect(emailCall.args[0].brandName).to.equal('not-a-valid-url');
    });

    it('should count site as failed when metrics calculation throws', async () => {
      mockCalculateOverviewMetrics.rejects(new Error('Metrics calculation failed'));

      const context = {
        log: mockLog,
        env: mockEnv,
        data: {
          type: 'weekly-digest-org',
          organizationId: orgId,
          siteIds: ['site-1'],
        },
      };

      const result = await controller.processOrganizationDigest(context);
      const body = await result.json();

      expect(body.sitesFailed).to.equal(1);
      expect(body.totalEmailsSent).to.equal(0);
    });

    it('should return 403 when user is not admin', async () => {
      mockAccessControlUtil.hasAdminAccess.returns(false);

      const context = {
        log: mockLog,
        env: mockEnv,
        data: {
          type: 'weekly-digest-org',
          organizationId: orgId,
          siteIds: ['site-1'],
        },
      };

      const result = await controller.processOrganizationDigest(context);

      expect(result.status).to.equal(403);
      const body = await result.json();
      expect(body.message).to.include('Only admins');
    });
  });
});
