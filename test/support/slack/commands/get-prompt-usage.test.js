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
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import esmock from 'esmock';

import { S3Client } from '@aws-sdk/client-s3';
import { llmoConfig } from '@adobe/spacecat-shared-utils';

use(sinonChai);

describe('GetPromptUsageCommand', () => {
  let context;
  let slackContext;
  let dataAccessStub;
  let sendFileStub;
  let imsOrgID;
  let s3Client;
  let readConfigStub;
  let GetPromptUsageCommand;

  beforeEach(async () => {
    imsOrgID = 'test@AdobeOrg';
    s3Client = sinon.createStubInstance(S3Client);

    dataAccessStub = {
      Organization: {
        findByImsOrgId: sinon.stub(),
        getId: sinon.stub(),
        getName: sinon.stub(),
      },
      Entitlement: {
        allByOrganizationId: sinon.stub(),
        getTier: sinon.stub(),
        getProductCode: sinon.stub(),
      },
      Site: {
        allByOrganizationId: sinon.stub(),
        getId: sinon.stub(),
      },
    };
    context = {
      dataAccess: dataAccessStub,
      log: console,
      env: {
        token: 'test-token',
      },
      s3: {
        s3Client,
        s3Bucket: 'test-bucket',
      },
    };
    slackContext = {
      say: sinon.spy(),
      files: [],
      client: {
        files: [],
        chat: {
          postMessage: sinon.stub().resolves(),
        },
      },
      channelId: 'test-channel',
      threadTs: 'test-thread',
    };
    slackContext.botToken = 'test-token';

    readConfigStub = sinon.stub();

    sendFileStub = sinon.stub().resolves();
    GetPromptUsageCommand = await esmock(
      '../../../../src/support/slack/commands/get-prompt-usage.js',
      {
        '../../../../src/utils/slack/base.js': { sendFile: sendFileStub },
        '@adobe/spacecat-shared-utils': {
          llmoConfig: { readConfig: readConfigStub },
        },
      },
    );
  });

  afterEach(() => {
    sinon.restore();
    esmock.purge(GetPromptUsageCommand);
  });

  describe('Initialization and BaseCommand Integration', () => {
    it('initializes correctly with base command properties', () => {
      const command = GetPromptUsageCommand(context);
      expect(command.id).to.equal('get-prompt-usage');
      expect(command.name).to.equal('Get Prompt Usage');
      expect(command.description).to.equal(
        'Retrieves the total number of prompts for a given IMS org ID (or multiple IMS org IDs)',
      );
      expect(command.phrases).to.deep.equal(['get-prompt-usage']);
      expect(command.usage()).to.equal('Usage: _get-prompt-usage {imsOrgID}_');
    });
  });

  describe('Retrieving prompt usage for a single IMS org ID', () => {
    it('retrieves prompt usage for a single IMS org ID', async () => {
      const mockOrganization = {
        getId: sinon.stub().returns('test-org-id'),
        getName: sinon.stub().returns('Test Org'),
      };

      const mockSite1 = { getId: sinon.stub().returns('test-site-id1') };
      const mockSite2 = { getId: sinon.stub().returns('test-site-id2') };

      const mockEntitlement = {
        getId: () => 'ent',
        getOrganizationId: () => 'test-org-id',
        getProductCode: () => 'LLMO',
        getTier: () => 'FREE_TRIAL',
        getStatus: () => 'ACTIVE',
        getQuotas: () => ({}),
        getCreatedAt: () => '2023-01-01T00:00:00Z',
        getUpdatedAt: () => '2023-01-01T00:00:00Z',
        getUpdatedBy: () => 'user@example.com',
      };

      const categoryIdSite1 = '123e4567-e89b-12d3-a456-426614174000';
      const topicIdSite1 = '456e7890-e89b-12d3-a456-426614174001';
      const categoryIdSite2 = '123e4567-e89b-12d3-a456-426614174002';
      const topicIdSite2 = '456e7890-e89b-12d3-a456-426614174003';

      const expectedConfigSite1 = {
        ...llmoConfig.defaultConfig(),
        categories: {
          [categoryIdSite1]: {
            name: 'test-category',
            region: ['us'],
          },
        },
        topics: {
          [topicIdSite1]: {
            name: 'test-topic',
            category: categoryIdSite1,
            prompts: [
              {
                prompt: 'What is the main topic?',
                regions: ['us'],
                origin: 'human',
                source: 'config',
              },
              {
                prompt: 'What is the test topic?',
                regions: ['in'],
                origin: 'human',
                source: 'config',
              },
            ],
          },
        },
      };

      const expectedConfigSite2 = {
        ...llmoConfig.defaultConfig(),
        categories: {
          [categoryIdSite2]: {
            name: 'test-category',
            region: ['us'],
          },
        },
        topics: {
          [topicIdSite2]: {
            name: 'test-topic',
            category: categoryIdSite2,
            prompts: [
              {
                prompt: 'What is the main topic?',
                regions: ['ro'],
                origin: 'human',
                source: 'config',
              },
            ],
          },
        },
      };

      readConfigStub.withArgs(mockSite1.getId(), s3Client).resolves({
        config: expectedConfigSite1,
        exists: true,
        version: 'v123',
      });

      readConfigStub.withArgs(mockSite2.getId(), s3Client).resolves({
        config: expectedConfigSite2,
        exists: true,
        version: 'v123',
      });

      const expectedMessage = '*Prompt usage for* `test@AdobeOrg`:\n'
        + '• *IMS Org Name:* Test Org\n'
        + '• *Tier:* FREE_TRIAL\n'
        + '• *Total number of prompts:* 3';

      dataAccessStub.Organization.findByImsOrgId.resolves(mockOrganization);
      dataAccessStub.Entitlement.allByOrganizationId.resolves([mockEntitlement]);
      dataAccessStub.Site.allByOrganizationId.resolves([mockSite1, mockSite2]);

      const args = [imsOrgID];
      const command = GetPromptUsageCommand(context);

      await command.handleExecution(args, slackContext);

      expect(slackContext.say.called).to.be.true;
      expect(slackContext.say.firstCall.args[0]).to.equal(expectedMessage);
      expect(
        dataAccessStub.Organization.findByImsOrgId,
      ).to.have.been.calledWith('test@AdobeOrg');
      expect(
        dataAccessStub.Entitlement.allByOrganizationId,
      ).to.have.been.calledWith('test-org-id');
    });

    it('returns an error when IMS org ID does not exist', async () => {
      const nonExistingImsOrgID = 'non-existing-org@AdobeOrg';

      const expectedMessage = ':nuclear-warning: Oops! Something went wrong: Could not find a Spacecat Organization for the provided IMS org ID';

      dataAccessStub.Organization.findByImsOrgId.resolves(null);

      const args = [nonExistingImsOrgID];
      const command = GetPromptUsageCommand(context);

      await command.handleExecution(args, slackContext);

      expect(slackContext.say.called).to.be.true;
      expect(slackContext.say.firstCall.args[0]).to.equal(expectedMessage);
      expect(
        dataAccessStub.Organization.findByImsOrgId,
      ).to.have.been.calledWith(nonExistingImsOrgID);
    });

    it('returns an error when LLMO entitlement does not exist', async () => {
      const mockOrganization = {
        getId: sinon.stub().returns('test-org-id'),
        getName: sinon.stub().returns('Test Org'),
      };

      const mockEntitlement = {
        getId: () => 'ent',
        getOrganizationId: () => 'test-org-id',
        getProductCode: () => 'ASO',
        getTier: () => 'PAID',
        getStatus: () => 'ACTIVE',
        getQuotas: () => ({}),
        getCreatedAt: () => '2023-01-01T00:00:00Z',
        getUpdatedAt: () => '2023-01-01T00:00:00Z',
        getUpdatedBy: () => 'user@example.com',
      };

      const expectedMessage = ':nuclear-warning: Oops! Something went wrong: No entitlement with product code LLMO found for the provided IMS org ID';

      dataAccessStub.Organization.findByImsOrgId.resolves(mockOrganization);
      dataAccessStub.Entitlement.allByOrganizationId.resolves([mockEntitlement]);

      const args = [imsOrgID];
      const command = GetPromptUsageCommand(context);

      await command.handleExecution(args, slackContext);

      expect(slackContext.say.called).to.be.true;
      expect(slackContext.say.firstCall.args[0]).to.equal(expectedMessage);
      expect(
        dataAccessStub.Organization.findByImsOrgId,
      ).to.have.been.calledWith(imsOrgID);
      expect(
        dataAccessStub.Entitlement.allByOrganizationId,
      ).to.have.been.calledWith('test-org-id');
    });

    it('rejects when no IMS orgs are provided', async () => {
      const args = [];
      const command = GetPromptUsageCommand(context);
      const expectedMessage = `Please provide one or more IMS org IDs.\n${command.usage()}`;

      await command.handleExecution(args, slackContext);

      expect(slackContext.say.called).to.be.true;
      expect(slackContext.say.firstCall.args[0]).to.equal(expectedMessage);
    });
  });

  describe('GetPromptUsageCommand (multi-org)', () => {
    it('uploads a CSV when multiple orgs are provided and one fails', async () => {
      const mockOrganization1 = {
        getId: sinon.stub().returns('test-org-id1'),
        getName: sinon.stub().returns('Test Org 1'),
      };
      const mockOrganization2 = {
        getId: sinon.stub().returns('test-org-id2'),
        getName: sinon.stub().returns('Test Org 2'),
      };
      const mockOrganization3 = {
        getId: sinon.stub().returns('test-org-id3'),
        getName: sinon.stub().returns('Test Org 3'),
      };

      const mockEntitlement1 = {
        getId: () => 'ent1',
        getOrganizationId: () => 'test-org-id1',
        getProductCode: () => 'LLMO',
        getTier: () => 'FREE_TRIAL',
        getStatus: () => 'ACTIVE',
        getQuotas: () => ({}),
        getCreatedAt: () => '2023-01-01T00:00:00Z',
        getUpdatedAt: () => '2023-01-01T00:00:00Z',
        getUpdatedBy: () => 'user1@example.com',
      };

      const mockEntitlement2 = {
        getId: () => 'ent2',
        getOrganizationId: () => 'test-org-id2',
        getProductCode: () => 'ASO',
        getTier: () => 'PAID',
        getStatus: () => 'ACTIVE',
        getQuotas: () => ({}),
        getCreatedAt: () => '2023-01-01T00:00:00Z',
        getUpdatedAt: () => '2023-01-01T00:00:00Z',
        getUpdatedBy: () => 'user2@example.com',
      };

      const mockEntitlement3 = {
        getId: () => 'ent3',
        getOrganizationId: () => 'test-org-id3',
        getProductCode: () => 'LLMO',
        getTier: () => 'PAID',
        getStatus: () => 'ACTIVE',
        getQuotas: () => ({}),
        getCreatedAt: () => '2023-01-01T00:00:00Z',
        getUpdatedAt: () => '2023-01-01T00:00:00Z',
        getUpdatedBy: () => 'user1@example.com',
      };

      const mockSite1 = { getId: sinon.stub().returns('test-site-id1') };
      const mockSite2 = { getId: sinon.stub().returns('test-site-id2') };
      const mockSite3 = { getId: sinon.stub().returns('test-site-id3') };

      const categoryIdSite1 = '123e4567-e89b-12d3-a456-426614174000';
      const topicIdSite1 = '456e7890-e89b-12d3-a456-426614174001';
      const categoryIdSite3 = '123e4567-e89b-12d3-a456-426614174002';
      const topicIdSite3 = '456e7890-e89b-12d3-a456-426614174003';

      const expectedConfigSite1 = {
        ...llmoConfig.defaultConfig(),
        categories: {
          [categoryIdSite1]: {
            name: 'test-category',
            region: ['us'],
          },
        },
        topics: {
          [topicIdSite1]: {
            name: 'test-topic',
            category: categoryIdSite1,
            prompts: [
              {
                prompt: 'What is the main topic?',
                regions: ['us'],
                origin: 'human',
                source: 'config',
              },
              {
                prompt: 'What is the test topic?',
                regions: ['in'],
                origin: 'human',
                source: 'config',
              },
            ],
          },
        },
      };

      const expectedConfigSite3 = {
        ...llmoConfig.defaultConfig(),
        categories: {
          [categoryIdSite3]: {
            name: 'test-category',
            region: ['us'],
          },
        },
        topics: {
          [topicIdSite3]: {
            name: 'test-topic',
            category: categoryIdSite3,
            prompts: [
              {
                prompt: 'What is the main topic?',
                regions: ['ro'],
                origin: 'human',
                source: 'config',
              },
            ],
          },
        },
      };

      dataAccessStub.Organization.findByImsOrgId
        .withArgs('test-org-1@AdobeOrg')
        .resolves(mockOrganization1);
      dataAccessStub.Entitlement.allByOrganizationId
        .withArgs('test-org-id1')
        .resolves([mockEntitlement1]);

      dataAccessStub.Organization.findByImsOrgId
        .withArgs('test-org-2@AdobeOrg')
        .resolves(mockOrganization2);
      dataAccessStub.Entitlement.allByOrganizationId
        .withArgs('test-org-id2')
        .resolves([mockEntitlement2]);

      dataAccessStub.Organization.findByImsOrgId
        .withArgs('test-org-3@AdobeOrg')
        .resolves(mockOrganization3);
      dataAccessStub.Entitlement.allByOrganizationId
        .withArgs('test-org-id3')
        .resolves([mockEntitlement3]);

      dataAccessStub.Site.allByOrganizationId
        .withArgs('test-org-id1')
        .resolves([mockSite1]);
      dataAccessStub.Site.allByOrganizationId
        .withArgs('test-org-id2')
        .resolves([mockSite2]);
      dataAccessStub.Site.allByOrganizationId
        .withArgs('test-org-id3')
        .resolves([mockSite3]);

      readConfigStub.withArgs(mockSite1.getId(), s3Client).resolves({
        config: expectedConfigSite1,
        exists: true,
        version: 'v123',
      });

      readConfigStub.withArgs(mockSite3.getId(), s3Client).resolves({
        config: expectedConfigSite3,
        exists: true,
        version: 'v123',
      });

      const args = [
        'test-org-1@AdobeOrg',
        'test-org-2@AdobeOrg',
        'test-org-3@AdobeOrg',
      ];
      const command = GetPromptUsageCommand(context);
      await command.handleExecution(args, slackContext);

      expect(sendFileStub.calledOnce).to.be.true;
      const [
        providedSlackContext,
        csvBuffer,
        filename,
        title,
        initialComment,
        channelId,
      ] = sendFileStub.firstCall.args;

      expect(providedSlackContext).to.equal(slackContext);
      expect(title).to.equal('Prompt usage report');
      expect(initialComment).to.equal('Here you can find the prompt usage report.');
      expect(channelId).to.equal('test-channel');
      expect(filename).to.match(/^prompt-usage-\d+\.csv$/);

      const csvString = Buffer.isBuffer(csvBuffer) ? csvBuffer.toString('utf8') : String(csvBuffer);
      const lines = csvString.trim().split(/\r?\n/);

      expect(lines[0]).to.equal('IMS Org Name,IMS Org ID,Tier,Total number of prompts,Error');

      expect(lines[1]).to.equal('Test Org 1,test-org-1@AdobeOrg,FREE_TRIAL,2,');

      expect(lines[2]).to.equal(
        ',test-org-2@AdobeOrg,,,No entitlement with product code LLMO found for the provided IMS org ID',
      );

      expect(lines[3]).to.equal('Test Org 3,test-org-3@AdobeOrg,PAID,1,');

      expect(
        dataAccessStub.Organization.findByImsOrgId,
      ).to.have.been.calledWith('test-org-1@AdobeOrg');
      expect(
        dataAccessStub.Organization.findByImsOrgId,
      ).to.have.been.calledWith('test-org-2@AdobeOrg');
      expect(
        dataAccessStub.Organization.findByImsOrgId,
      ).to.have.been.calledWith('test-org-3@AdobeOrg');
    });
  });
});
