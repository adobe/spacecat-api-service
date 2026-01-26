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

use(chaiAsPromised);
use(sinonChai);

describe('Weekly Digest Controller', () => {
  const sandbox = sinon.createSandbox();
  let WeeklyDigestController;

  const orgId = '123e4567-e89b-12d3-a456-426614174000';

  const mockLog = {
    info: sandbox.stub(),
    error: sandbox.stub(),
    debug: sandbox.stub(),
    warn: sandbox.stub(),
  };

  const mockEnv = {
    LLMO_HLX_API_KEY: 'test-hlx-key',
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

  const mockSiteWithoutLlmo = {
    getId: () => 'site-2',
    getBaseURL: () => 'https://other.com',
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

  beforeEach(async () => {
    sandbox.restore();

    mockDataAccess = {
      Site: {
        all: sandbox.stub().resolves([mockSiteWithLlmo, mockSiteWithoutLlmo]),
      },
      Organization: {
        findById: sandbox.stub().resolves(mockOrganization),
      },
      TrialUser: {
        allByOrganizationId: sandbox.stub().resolves([mockTrialUser]),
      },
    };

    mockCalculateOverviewMetrics = sandbox.stub().resolves({
      hasData: true,
      visibilityScore: 85,
      visibilityDelta: 5,
      mentionsCount: 100,
      mentionsDelta: 10,
      citationsCount: 50,
      citationsDelta: -5,
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

  describe('processWeeklyDigests', () => {
    let controller;

    beforeEach(() => {
      controller = WeeklyDigestController({ dataAccess: mockDataAccess });
    });

    it('should process weekly digests successfully', async () => {
      const context = {
        log: mockLog,
        env: mockEnv,
      };

      const result = await controller.processWeeklyDigests(context);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.message).to.equal('Weekly digest processing complete');
      expect(body.summary).to.have.property('sitesProcessed');
      expect(body.summary).to.have.property('totalEmailsSent');
    });

    it('should filter out sites without LLMO config', async () => {
      const context = {
        log: mockLog,
        env: mockEnv,
      };

      await controller.processWeeklyDigests(context);

      // Only the site with LLMO config should be processed
      expect(mockCalculateOverviewMetrics).to.have.been.calledOnce;
    });

    it('should skip sites with no data', async () => {
      mockCalculateOverviewMetrics.resolves({ hasData: false });

      const context = {
        log: mockLog,
        env: mockEnv,
      };

      const result = await controller.processWeeklyDigests(context);
      const body = await result.json();

      expect(body.summary.sitesSkipped).to.be.at.least(1);
      expect(mockSendWeeklyDigestEmail).to.not.have.been.called;
    });

    it('should filter out opted-out users', async () => {
      mockDataAccess.TrialUser.allByOrganizationId.resolves([
        mockTrialUser,
        mockOptedOutUser,
      ]);

      const context = {
        log: mockLog,
        env: mockEnv,
      };

      await controller.processWeeklyDigests(context);

      // Should only send to non-opted-out user
      expect(mockSendWeeklyDigestEmail).to.have.been.calledOnce;
    });

    it('should filter out blocked users', async () => {
      mockDataAccess.TrialUser.allByOrganizationId.resolves([
        mockTrialUser,
        mockBlockedUser,
      ]);

      const context = {
        log: mockLog,
        env: mockEnv,
      };

      await controller.processWeeklyDigests(context);

      expect(mockSendWeeklyDigestEmail).to.have.been.calledOnce;
    });

    it('should skip organization when not found', async () => {
      mockDataAccess.Organization.findById.resolves(null);

      const context = {
        log: mockLog,
        env: mockEnv,
      };

      const result = await controller.processWeeklyDigests(context);
      const body = await result.json();

      expect(body.summary.sitesSkipped).to.be.at.least(1);
      expect(mockLog.warn).to.have.been.called;
    });

    it('should skip when no eligible users', async () => {
      mockDataAccess.TrialUser.allByOrganizationId.resolves([mockOptedOutUser]);

      const context = {
        log: mockLog,
        env: mockEnv,
      };

      const result = await controller.processWeeklyDigests(context);
      const body = await result.json();

      expect(body.summary.sitesSkipped).to.be.at.least(1);
    });

    it('should handle email send failures gracefully', async () => {
      mockSendWeeklyDigestEmail.resolves({ success: false, error: 'Email failed' });

      const context = {
        log: mockLog,
        env: mockEnv,
      };

      const result = await controller.processWeeklyDigests(context);
      const body = await result.json();

      expect(body.summary.totalEmailsFailed).to.be.at.least(1);
    });

    it('should handle email send exceptions gracefully', async () => {
      mockSendWeeklyDigestEmail.rejects(new Error('Network error'));

      const context = {
        log: mockLog,
        env: mockEnv,
      };

      const result = await controller.processWeeklyDigests(context);
      const body = await result.json();

      expect(body.summary.totalEmailsFailed).to.be.at.least(1);
      expect(mockLog.error).to.have.been.called;
    });

    it('should handle metrics calculation errors', async () => {
      mockCalculateOverviewMetrics.rejects(new Error('Calculation failed'));

      const context = {
        log: mockLog,
        env: mockEnv,
      };

      const result = await controller.processWeeklyDigests(context);

      expect(result.status).to.equal(200);
      expect(mockLog.error).to.have.been.called;
    });

    it('should handle organization lookup errors', async () => {
      mockDataAccess.Organization.findById.rejects(new Error('DB error'));

      const context = {
        log: mockLog,
        env: mockEnv,
      };

      const result = await controller.processWeeklyDigests(context);
      const body = await result.json();

      expect(body.summary.sitesFailed).to.be.at.least(1);
    });

    it('should return 500 on fatal error', async () => {
      mockDataAccess.Site.all.rejects(new Error('Fatal error'));

      const context = {
        log: mockLog,
        env: mockEnv,
      };

      const result = await controller.processWeeklyDigests(context);

      expect(result.status).to.equal(500);
    });

    it('should use brand name from config when available', async () => {
      const context = {
        log: mockLog,
        env: mockEnv,
      };

      await controller.processWeeklyDigests(context);

      const emailCall = mockSendWeeklyDigestEmail.getCall(0);
      expect(emailCall.args[0].brandName).to.equal('Test Brand');
    });

    it('should fall back to domain when brand name not configured', async () => {
      const siteNoBrandName = {
        ...mockSiteWithLlmo,
        getConfig: () => ({
          llmo: {
            dataFolder: 'test-folder',
          },
        }),
      };
      mockDataAccess.Site.all.resolves([siteNoBrandName]);

      const context = {
        log: mockLog,
        env: mockEnv,
      };

      await controller.processWeeklyDigests(context);

      const emailCall = mockSendWeeklyDigestEmail.getCall(0);
      expect(emailCall.args[0].brandName).to.equal('example.com');
    });

    it('should send correct URLs in email', async () => {
      const context = {
        log: mockLog,
        env: mockEnv,
      };

      await controller.processWeeklyDigests(context);

      const emailCall = mockSendWeeklyDigestEmail.getCall(0);
      expect(emailCall.args[0].overviewUrl).to.include('https://llmo.now');
      expect(emailCall.args[0].settingsUrl).to.include('https://llmo.now');
    });

    it('should use user display name in email', async () => {
      const context = {
        log: mockLog,
        env: mockEnv,
      };

      await controller.processWeeklyDigests(context);

      const emailCall = mockSendWeeklyDigestEmail.getCall(0);
      expect(emailCall.args[0].customerName).to.equal('John Doe');
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
      };

      await controller.processWeeklyDigests(context);

      const emailCall = mockSendWeeklyDigestEmail.getCall(0);
      expect(emailCall.args[0].customerName).to.equal('user@example.com');
    });

    it('should use first name only when last name is missing', async () => {
      const userFirstNameOnly = {
        ...mockTrialUser,
        getFirstName: () => 'John',
        getLastName: () => '-',
      };
      mockDataAccess.TrialUser.allByOrganizationId.resolves([userFirstNameOnly]);

      const context = {
        log: mockLog,
        env: mockEnv,
      };

      await controller.processWeeklyDigests(context);

      const emailCall = mockSendWeeklyDigestEmail.getCall(0);
      expect(emailCall.args[0].customerName).to.equal('John');
    });

    it('should handle invalid base URL gracefully', async () => {
      const siteInvalidUrl = {
        ...mockSiteWithLlmo,
        getBaseURL: () => 'not-a-valid-url',
      };
      mockDataAccess.Site.all.resolves([siteInvalidUrl]);

      const context = {
        log: mockLog,
        env: mockEnv,
      };

      const result = await controller.processWeeklyDigests(context);

      expect(result.status).to.equal(200);
    });

    it('should handle empty sites list', async () => {
      mockDataAccess.Site.all.resolves([]);

      const context = {
        log: mockLog,
        env: mockEnv,
      };

      const result = await controller.processWeeklyDigests(context);
      const body = await result.json();

      expect(body.summary.sitesProcessed).to.equal(0);
    });

    it('should handle user with null metadata for opt-out check', async () => {
      const userNullMetadata = {
        ...mockTrialUser,
        getMetadata: () => null,
      };
      mockDataAccess.TrialUser.allByOrganizationId.resolves([userNullMetadata]);

      const context = {
        log: mockLog,
        env: mockEnv,
      };

      // User with null metadata should not be opted out (default is opted-in)
      const result = await controller.processWeeklyDigests(context);
      const body = await result.json();

      expect(body.summary.totalEmailsSent).to.be.at.least(1);
    });

    it('should handle site with getLlmoConfig method', async () => {
      const siteWithMethod = {
        ...mockSiteWithLlmo,
        getConfig: () => ({
          getLlmoConfig: () => ({
            dataFolder: 'test-folder',
            brandName: 'Method Brand',
          }),
        }),
      };
      mockDataAccess.Site.all.resolves([siteWithMethod]);

      const context = {
        log: mockLog,
        env: mockEnv,
      };

      const result = await controller.processWeeklyDigests(context);

      expect(result.status).to.equal(200);
    });

    it('should process multiple organizations', async () => {
      const org2Id = '223e4567-e89b-12d3-a456-426614174001';
      const site2 = {
        ...mockSiteWithLlmo,
        getId: () => 'site-3',
        getOrganizationId: () => org2Id,
      };
      mockDataAccess.Site.all.resolves([mockSiteWithLlmo, site2]);

      const context = {
        log: mockLog,
        env: mockEnv,
      };

      await controller.processWeeklyDigests(context);

      expect(mockDataAccess.Organization.findById).to.have.been.calledTwice;
    });
  });
});
