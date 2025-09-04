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
import nock from 'nock';

use(chaiAsPromised);
use(sinonChai);

describe('onboard-llmo-modal', () => {
  let sandbox;
  let onboardSite;
  let mockedModule;

  before(async () => {
    // Mock the ES modules that can't be stubbed directly
    mockedModule = await esmock('../../../../src/support/slack/actions/onboard-llmo-modal.js', {
      '@adobe/spacecat-shared-data-access/src/models/site/config.js': {
        Config: {
          toDynamoItem: sinon.stub().returns({}),
        },
      },
      '@adobe/spacecat-helix-content-sdk': {
        createFrom: sinon.stub().resolves({
          getDocument: sinon.stub().returns({
            exists: sinon.stub().resolves(false),
            createFolder: sinon.stub().resolves(),
            copy: sinon.stub().resolves(),
          }),
        }),
      },
      '@octokit/rest': {
        Octokit: sinon.stub().returns({
          repos: {
            getContent: sinon.stub().resolves({
              data: { content: Buffer.from('test content').toString('base64') },
            }),
            createOrUpdateFileContents: sinon.stub().resolves(),
          },
        }),
      },
      '../../../../src/utils/slack/base.js': {
        postErrorMessage: sinon.stub(),
      },
    });

    onboardSite = mockedModule.onboardSite;
  });

  beforeEach(() => {
    // Block all network requests during tests
    nock.disableNetConnect();
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    // Clean up after each test
    nock.cleanAll();
    nock.enableNetConnect();
    sandbox.restore();
  });

  describe('onboardSite', () => {
    it('should successfully onboard a new site with all expected messages and function calls', async function () {
      this.timeout(10000); // Increase timeout to 10 seconds
      // Mock data
      const input = {
        baseURL: 'https://example.com',
        brandName: 'Test Brand',
        imsOrgId: 'ABC123@AdobeOrg',
        deliveryType: 'aem_edge',
      };

      const mockSite = {
        getId: sandbox.stub().returns('site123'),
        getOrganizationId: sandbox.stub().returns('org123'),
        getConfig: sandbox.stub().returns({
          updateLlmoBrand: sandbox.stub(),
          updateLlmoDataFolder: sandbox.stub(),
          enableImport: sandbox.stub(),
        }),
        setConfig: sandbox.stub(),
        save: sandbox.stub().resolves(),
      };

      const mockConfiguration = {
        findLatest: sandbox.stub().resolves({
          save: sandbox.stub().resolves(),
          enableHandlerForSite: sandbox.stub(),
          isHandlerEnabledForSite: sandbox.stub().returns(false),
          getQueues: sandbox.stub().returns({ audits: 'audit-queue' }),
        }),
      };

      const mockOrganization = {
        findByImsOrgId: sandbox.stub().resolves({
          getId: sandbox.stub().returns('org123'),
        }),
      };

      const mockEntitlement = {
        create: sandbox.stub().returns({
          save: sandbox.stub().resolves(),
          getId: sandbox.stub().returns('entitlement123'),
        }),
        findById: sandbox.stub().resolves({
          getProductCode: sandbox.stub().returns('OTHER'),
        }),
      };

      const mockSiteEnrollment = {
        allBySiteId: sandbox.stub().resolves([]),
        create: sandbox.stub().returns({
          save: sandbox.stub().resolves(),
        }),
      };

      const mockSiteModel = {
        findByBaseURL: sandbox.stub().resolves(null), // New site
        findById: sandbox.stub().resolves(mockSite),
        create: sandbox.stub().returns({
          save: sandbox.stub().resolves(),
          getId: sandbox.stub().returns('site123'),
        }),
        allByOrganizationId: sandbox.stub().resolves([]),
      };

      const mockImsClient = {
        getImsOrganizationDetails: sandbox.stub().resolves({
          orgName: 'Test Organization',
        }),
      };

      const mockSqs = {
        sendMessage: sandbox.stub(),
      };

      const lambdaCtx = {
        log: {
          info: sandbox.stub(),
          warn: sandbox.stub(),
          error: sandbox.stub(),
        },
        dataAccess: {
          Site: mockSiteModel,
          Configuration: mockConfiguration,
          Organization: mockOrganization,
          Entitlement: mockEntitlement,
          SiteEnrollment: mockSiteEnrollment,
        },
        imsClient: mockImsClient,
        sqs: mockSqs,
      };

      const sayStub = sandbox.stub();
      const slackCtx = {
        say: sayStub,
      };

      // Mock fetch for admin.hlx.page calls
      global.fetch = sandbox.stub().resolves({
        ok: true,
        status: 200,
        statusText: 'OK',
      });

      // Execute the function
      await onboardSite(input, lambdaCtx, slackCtx);

      // Verify the expected say() messages
      expect(sayStub).to.have.been.calledWith(':gear: Test Brand onboarding started...');
      expect(sayStub).to.have.been.calledWith(sinon.match(':white_check_mark: *LLMO onboarding completed successfully!*'));
      expect(sayStub).to.have.been.calledWith(sinon.match(':link: *Site:* https://example.com'));
      expect(sayStub).to.have.been.calledWith(sinon.match(':identification_card: *Site ID:* site123'));
      expect(sayStub).to.have.been.calledWith(sinon.match(':file_folder: *Data Folder:* example-com'));
      expect(sayStub).to.have.been.calledWith(sinon.match(':label: *Brand:* Test Brand'));
      expect(sayStub).to.have.been.calledWith(sinon.match(':identification_card: *IMS Org ID:* ABC123@AdobeOrg'));

      // Verify key function calls
      expect(mockSiteModel.findByBaseURL).to.have.been.calledWith('https://example.com');
      expect(mockSiteModel.create).to.have.been.calledWith({
        baseURL: 'https://example.com',
        deliveryType: 'aem_edge',
        organizationId: 'org123',
      });
      expect(mockSite.save).to.have.been.called;
      expect(mockConfiguration.findLatest).to.have.been.calledTwice;
      expect(mockSqs.sendMessage).to.have.been.calledWith('audit-queue', {
        type: 'llmo-customer-analysis',
        siteId: 'site123',
        auditContext: {
          auditType: 'llmo-customer-analysis',
        },
      });

      // Verify site config updates
      const siteConfig = mockSite.getConfig();
      expect(siteConfig.updateLlmoBrand).to.have.been.calledWith('Test Brand');
      expect(siteConfig.updateLlmoDataFolder).to.have.been.calledWith('example-com');
      expect(siteConfig.enableImport).to.have.been.calledWith('traffic-analysis');
      expect(siteConfig.enableImport).to.have.been.calledWith('llmo-prompts-ahrefs', { limit: 25 });

      // Verify handler enabling
      const config = await mockConfiguration.findLatest();
      expect(config.enableHandlerForSite).to.have.been.calledWith('llmo-referral-traffic', mockSite);
      expect(config.enableHandlerForSite).to.have.been.calledWith('geo-brand-presence', mockSite);
      expect(config.enableHandlerForSite).to.have.been.calledWith('cdn-analysis', mockSite);
      expect(config.enableHandlerForSite).to.have.been.calledWith('cdn-logs-report', mockSite);
      expect(config.enableHandlerForSite).to.have.been.calledWith('llmo-customer-analysis', mockSite);
    });
  });
});
