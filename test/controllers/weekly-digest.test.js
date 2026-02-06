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

import AccessControlUtil from '../../src/support/access-control-util.js';
import WeeklyDigestController from '../../src/controllers/weekly-digest.js';

use(chaiAsPromised);
use(sinonChai);

describe('Weekly Digest Controller', () => {
  const sandbox = sinon.createSandbox();

  const orgId = '123e4567-e89b-12d3-a456-426614174000';
  const org2Id = '223e4567-e89b-12d3-a456-426614174001';

  const mockLog = {
    info: sandbox.stub(),
    error: sandbox.stub(),
    debug: sandbox.stub(),
    warn: sandbox.stub(),
  };

  const mockEnv = {
    DIGEST_JOBS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/123456789/spacecat-digest-jobs',
  };

  const mockSqs = {
    sendMessage: sandbox.stub().resolves(),
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

  let mockDataAccess;
  let mockAccessControlUtil;

  beforeEach(() => {
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
      },
    };
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
        env: {}, // No queue URL
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
});
