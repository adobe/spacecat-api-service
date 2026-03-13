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

describe('Bot Blocker Controller', () => {
  const sandbox = sinon.createSandbox();
  const siteId = '123e4567-e89b-12d3-a456-426614174000';
  const baseURL = 'https://www.example.com';

  const loggerStub = {
    info: sandbox.stub(),
    error: sandbox.stub(),
    warn: sandbox.stub(),
    debug: sandbox.stub(),
  };

  const mockSite = {
    getId: () => siteId,
    getBaseURL: () => baseURL,
    getOrganizationId: () => 'org-123',
    getOrganization: sandbox.stub().resolves({
      getId: () => 'org-123',
      getImsOrgId: () => 'imsOrg123@AdobeOrg',
    }),
  };

  const mockDataAccess = {
    Site: {
      findById: sandbox.stub().resolves(mockSite),
    },
  };

  const mockAuthInfo = {
    hasOrganization: sandbox.stub().returns(true),
  };

  const mockAccessControlUtil = {
    hasAccess: sandbox.stub().resolves(true),
    hasAdminAccess: sandbox.stub().returns(false),
  };

  let BotBlockerController;
  let detectBotBlockerStub;
  let isValidUUIDStub;

  before(async () => {
    detectBotBlockerStub = sandbox.stub();
    isValidUUIDStub = sandbox.stub().returns(true); // Always return true for valid UUID tests

    BotBlockerController = await esmock('../../src/controllers/bot-blocker.js', {
      '@adobe/spacecat-shared-utils': {
        isNonEmptyObject: (obj) => obj !== null && typeof obj === 'object' && Object.keys(obj).length > 0,
        isValidUUID: isValidUUIDStub,
        detectBotBlocker: detectBotBlockerStub,
      },
      '../../src/support/access-control-util.js': {
        default: {
          fromContext: () => mockAccessControlUtil,
        },
      },
    });
  });

  let botBlockerController;

  beforeEach(() => {
    botBlockerController = BotBlockerController.default(
      { dataAccess: mockDataAccess, authInfo: mockAuthInfo },
      loggerStub,
    );

    // Reset stubs
    mockDataAccess.Site.findById = sandbox.stub().resolves(mockSite);
    mockAccessControlUtil.hasAccess = sandbox.stub().resolves(true);
    detectBotBlockerStub.reset();
    isValidUUIDStub.resetBehavior();
    isValidUUIDStub.returns(true); // Default to valid UUID
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('throws an error if context is not an object', () => {
    expect(() => BotBlockerController.default(null, loggerStub)).to.throw('Context required');
  });

  it('throws an error if dataAccess is not an object', () => {
    expect(() => BotBlockerController.default({ dataAccess: null }, loggerStub)).to.throw('Data access required');
  });

  describe('checkBotBlocker', () => {
    it('returns bad request for invalid siteId', async () => {
      isValidUUIDStub.returns(false); // Mock invalid UUID for this test

      const context = {
        params: { siteId: 'invalid-uuid' },
      };

      const response = await botBlockerController.checkBotBlocker(context);

      expect(response.status).to.equal(400);
      expect(loggerStub.error).to.have.been.calledWith('Invalid siteId: invalid-uuid');
    });

    it('returns not found when site does not exist', async () => {
      mockDataAccess.Site.findById = sandbox.stub().resolves(null);

      const context = {
        params: { siteId },
      };

      const response = await botBlockerController.checkBotBlocker(context);

      expect(response.status).to.equal(404);
      expect(loggerStub.error).to.have.been.calledWith(`Site with ID ${siteId} not found`);
    });

    it('returns forbidden when user does not have access', async () => {
      mockAccessControlUtil.hasAccess = sandbox.stub().resolves(false);

      const context = {
        params: { siteId },
      };

      const response = await botBlockerController.checkBotBlocker(context);

      expect(response.status).to.equal(403);
    });

    it('returns internal server error when site has no baseURL', async () => {
      const mockSiteNoUrl = {
        ...mockSite,
        getBaseURL: () => null,
      };
      mockDataAccess.Site.findById = sandbox.stub().resolves(mockSiteNoUrl);

      const context = {
        params: { siteId },
      };

      const response = await botBlockerController.checkBotBlocker(context);

      expect(response.status).to.equal(500);
      expect(loggerStub.error).to.have.been.calledWith(`Site ${siteId} has no baseURL`);
    });

    it('successfully checks bot blocker and returns result when not blocked', async () => {
      const botBlockerResult = {
        crawlable: true,
        type: 'none',
        confidence: 1.0,
      };
      detectBotBlockerStub.resolves(botBlockerResult);

      const context = {
        params: { siteId },
      };

      const response = await botBlockerController.checkBotBlocker(context);

      expect(response.status).to.equal(200);
      const result = await response.json();
      expect(result).to.deep.equal(botBlockerResult);
      expect(detectBotBlockerStub).to.have.been.calledWith({ baseUrl: baseURL });
      expect(loggerStub.debug).to.have.been.calledWith(`Checking bot blocker for site ${siteId} with baseURL: ${baseURL}`);
      expect(loggerStub.debug).to.have.been.calledWith(`Bot blocker check completed for site ${siteId}: crawlable=true, type=none, confidence=1`);
    });

    it('successfully checks bot blocker and returns result when blocked by Cloudflare', async () => {
      const botBlockerResult = {
        crawlable: false,
        type: 'cloudflare',
        confidence: 0.99,
      };
      detectBotBlockerStub.resolves(botBlockerResult);

      const context = {
        params: { siteId },
      };

      const response = await botBlockerController.checkBotBlocker(context);

      expect(response.status).to.equal(200);
      const result = await response.json();
      expect(result).to.deep.equal(botBlockerResult);
      expect(detectBotBlockerStub).to.have.been.calledWith({ baseUrl: baseURL });
      expect(loggerStub.debug).to.have.been.calledWith(`Bot blocker check completed for site ${siteId}: crawlable=false, type=cloudflare, confidence=0.99`);
    });

    it('returns internal server error when detectBotBlocker throws an error', async () => {
      const error = new Error('Network error');
      detectBotBlockerStub.rejects(error);

      const context = {
        params: { siteId },
      };

      const response = await botBlockerController.checkBotBlocker(context);

      expect(response.status).to.equal(500);
      expect(loggerStub.error).to.have.been.calledWith(`Failed to check bot blocker for site ${siteId}: Network error`);
    });
  });
});
