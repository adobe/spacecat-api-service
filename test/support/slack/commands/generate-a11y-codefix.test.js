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

import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import esmock from 'esmock';

use(sinonChai);

// Mock AWS SDK clients
const mockS3Send = sinon.stub();
const mockSQSSend = sinon.stub();

const mockS3Client = sinon.stub().returns({
  send: mockS3Send,
});

const mockSQSClient = sinon.stub().returns({
  send: mockSQSSend,
});

const mockHeadObjectCommand = sinon.stub().returns({});
const mockSendMessageCommand = sinon.stub().returns({});

let GenerateA11yCodefixCommand;

before(async () => {
  GenerateA11yCodefixCommand = await esmock('../../../../src/support/slack/commands/generate-a11y-codefix.js', {
    '@aws-sdk/client-s3': {
      S3Client: mockS3Client,
      HeadObjectCommand: mockHeadObjectCommand,
    },
    '@aws-sdk/client-sqs': {
      SQSClient: mockSQSClient,
      SendMessageCommand: mockSendMessageCommand,
    },
  });
});

describe('GenerateA11yCodefixCommand', () => {
  let context;
  let slackContext;
  let dataAccessStub;
  let logStub;

  const createMockSite = (overrides = {}) => ({
    getId: () => 'site-123',
    getBaseURL: () => 'https://example.com',
    getDeliveryType: () => 'aem_edge',
    getCode: () => ({
      owner: 'test-owner',
      repo: 'test-repo',
      url: 'https://github.com/test-owner/test-repo',
      ref: 'main',
      ...overrides.code,
    }),
    ...overrides,
  });

  const createMockOpportunity = (overrides = {}) => ({
    getId: () => 'opp-456',
    getType: () => 'accessibility',
    ...overrides,
  });

  const createMockSuggestion = (id = 'sugg-789', issues = [], url = 'https://example.com/page1', aggregationKey = 'agg-key-123') => ({
    getId: () => id,
    getData: () => ({
      issues: issues.map((issue) => ({
        type: issue.type || issue.issueName || 'test-issue',
        description: issue.description || issue.issueDescription || 'Test description',
        htmlWithIssues: issue.htmlWithIssues || [{
          update_from: issue.faulty_line || '<div></div>',
          target_selector: issue.target_selector || 'div',
        }],
      })),
      url,
      aggregationKey,
    }),
  });

  beforeEach(() => {
    // Reset all stubs
    mockS3Client.resetHistory();
    mockSQSClient.resetHistory();
    mockS3Send.reset();
    mockSQSSend.reset();
    mockHeadObjectCommand.reset();
    mockSendMessageCommand.reset();

    dataAccessStub = {
      Site: {
        findById: sinon.stub(),
      },
      Opportunity: {
        findById: sinon.stub(),
      },
      Suggestion: {
        findById: sinon.stub(),
      },
    };

    logStub = {
      info: sinon.stub(),
      error: sinon.stub(),
      warn: sinon.stub(),
    };

    context = {
      dataAccess: dataAccessStub,
      log: logStub,
      env: {
        AWS_REGION: 'us-east-1',
        AWS_ACCESS_KEY_ID: 'test-key',
        AWS_SECRET_ACCESS_KEY: 'test-secret',
        SQS_SPACECAT_TO_MYSTIQUE_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/123456789/mystique-queue',
        S3_MYSTIQUE_BUCKET_NAME: 'spacecat-prod-mystique-assets',
      },
    };

    slackContext = {
      say: sinon.spy(),
    };
  });

  describe('Initialization and BaseCommand Integration', () => {
    it('initializes correctly with base command properties', () => {
      const command = GenerateA11yCodefixCommand(context);
      expect(command.id).to.equal('generate-a11y-codefix');
      expect(command.name).to.equal('Generate A11y Codefix');
      expect(command.description).to.include('Generates accessibility code fixes');
    });

    it('has correct command phrases', () => {
      const command = GenerateA11yCodefixCommand(context);
      expect(command.phrases).to.include('generate a11y codefix');
    });
  });

  describe('Handle Execution Method - Input Validation', () => {
    it('returns usage when no arguments provided', async () => {
      const command = GenerateA11yCodefixCommand(context);
      await command.handleExecution([], slackContext);
      expect(slackContext.say).to.have.been.calledWith(sinon.match(/Usage:/));
    });

    it('returns error when site-id is missing (positional)', async () => {
      const command = GenerateA11yCodefixCommand(context);
      await command.handleExecution(['', 'opp-456', 'sugg-789', '--archive', 'test.tar.gz'], slackContext);
      expect(slackContext.say).to.have.been.calledWith(sinon.match(/Missing required parameters/));
    });

    it('returns error when site-id is missing (named)', async () => {
      const command = GenerateA11yCodefixCommand(context);
      await command.handleExecution(['--opportunity-id', 'opp-456', '--suggestion-id', 'sugg-789', '--archive', 'test.tar.gz'], slackContext);
      expect(slackContext.say).to.have.been.calledWith(sinon.match(/Missing required parameters/));
    });

    it('returns error when opportunity-id is missing', async () => {
      const command = GenerateA11yCodefixCommand(context);
      await command.handleExecution(['site-123', '', 'sugg-789', '--archive', 'test.tar.gz'], slackContext);
      expect(slackContext.say).to.have.been.calledWith(sinon.match(/Missing required parameters/));
    });

    it('returns error when suggestion-ids are missing', async () => {
      const command = GenerateA11yCodefixCommand(context);
      await command.handleExecution(['site-123', 'opp-456', '--archive', 'test.tar.gz'], slackContext);
      expect(slackContext.say).to.have.been.calledWith(sinon.match(/Missing required parameters/));
    });

    it('returns detailed error when --archive flag is missing', async () => {
      const command = GenerateA11yCodefixCommand(context);
      await command.handleExecution(['site-123', 'opp-456', 'sugg-789'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(sinon.match({
        text: ':warning: Archive name required',
        blocks: sinon.match.array,
      }));
    });

    it('shows actual IDs in archive error message', async () => {
      const command = GenerateA11yCodefixCommand(context);
      await command.handleExecution(['my-site-id', 'my-opp-id', 'my-sugg-1', 'my-sugg-2'], slackContext);

      const callArg = slackContext.say.firstCall.args[0];
      expect(callArg).to.have.property('blocks');
      expect(callArg.blocks[0].text.text).to.include('Archive name is required');
      // Should show the actual IDs provided by the user
      expect(callArg.blocks[0].text.text).to.include('my-site-id');
      expect(callArg.blocks[0].text.text).to.include('my-opp-id');
      expect(callArg.blocks[0].text.text).to.include('my-sugg-1 my-sugg-2');
    });

    it('parses positional arguments with --archive flag correctly', async () => {
      dataAccessStub.Site.findById.resolves(createMockSite());
      dataAccessStub.Opportunity.findById.resolves(createMockOpportunity());
      dataAccessStub.Suggestion.findById.resolves(createMockSuggestion());

      mockS3Send.resolves({});
      mockSQSSend.resolves({ MessageId: 'msg-123' });

      const command = GenerateA11yCodefixCommand(context);
      await command.handleExecution(['site-123', 'opp-456', 'sugg-789', '--archive', 'test-archive.tar.gz'], slackContext);

      expect(slackContext.say.firstCall.args[0]).to.include('Processing fix request');
    });

    it('parses named arguments (--site-id, --opportunity-id, --suggestion-id) correctly', async () => {
      dataAccessStub.Site.findById.resolves(createMockSite());
      dataAccessStub.Opportunity.findById.resolves(createMockOpportunity());
      dataAccessStub.Suggestion.findById.resolves(createMockSuggestion());

      mockS3Send.resolves({});
      mockSQSSend.resolves({ MessageId: 'msg-123' });

      const command = GenerateA11yCodefixCommand(context);
      await command.handleExecution([
        '--site-id', 'site-123',
        '--opportunity-id', 'opp-456',
        '--suggestion-id', 'sugg-789',
        '--archive', 'test-archive.tar.gz',
      ], slackContext);

      expect(slackContext.say.firstCall.args[0]).to.include('Processing fix request');
      expect(dataAccessStub.Site.findById).to.have.been.calledWith('site-123');
      expect(dataAccessStub.Opportunity.findById).to.have.been.calledWith('opp-456');
      expect(dataAccessStub.Suggestion.findById).to.have.been.calledWith('sugg-789');
    });

    it('parses multiple suggestion IDs after single --suggestion-id flag', async () => {
      dataAccessStub.Site.findById.resolves(createMockSite());
      dataAccessStub.Opportunity.findById.resolves(createMockOpportunity());
      dataAccessStub.Suggestion.findById
        .onFirstCall().resolves(createMockSuggestion('sugg-1'))
        .onSecondCall().resolves(createMockSuggestion('sugg-2'))
        .onThirdCall()
        .resolves(createMockSuggestion('sugg-3'));

      mockS3Send.resolves({});
      mockSQSSend.resolves({ MessageId: 'msg-123' });

      const command = GenerateA11yCodefixCommand(context);
      await command.handleExecution([
        '--site-id', 'site-123',
        '--opportunity-id', 'opp-456',
        '--suggestion-id', 'sugg-1', 'sugg-2', 'sugg-3',
        '--archive', 'test.tar.gz',
      ], slackContext);

      expect(dataAccessStub.Suggestion.findById).to.have.been.calledThrice;
      expect(dataAccessStub.Suggestion.findById).to.have.been.calledWith('sugg-1');
      expect(dataAccessStub.Suggestion.findById).to.have.been.calledWith('sugg-2');
      expect(dataAccessStub.Suggestion.findById).to.have.been.calledWith('sugg-3');
    });

    it('stops collecting suggestion IDs when hitting next flag', async () => {
      dataAccessStub.Site.findById.resolves(createMockSite());
      dataAccessStub.Opportunity.findById.resolves(createMockOpportunity());
      dataAccessStub.Suggestion.findById
        .onFirstCall().resolves(createMockSuggestion('sugg-1'))
        .onSecondCall().resolves(createMockSuggestion('sugg-2'));

      mockS3Send.resolves({});
      mockSQSSend.resolves({ MessageId: 'msg-123' });

      const command = GenerateA11yCodefixCommand(context);
      await command.handleExecution([
        '--site-id', 'site-123',
        '--opportunity-id', 'opp-456',
        '--suggestion-id', 'sugg-1', 'sugg-2',
        '--archive', 'test.tar.gz',
      ], slackContext);

      // Should only call findById for sugg-1 and sugg-2, not for 'test.tar.gz'
      expect(dataAccessStub.Suggestion.findById).to.have.been.calledTwice;
      expect(dataAccessStub.Suggestion.findById).to.have.been.calledWith('sugg-1');
      expect(dataAccessStub.Suggestion.findById).to.have.been.calledWith('sugg-2');
    });

    it('returns error when --suggestion-id flag is at the end with no values', async () => {
      const command = GenerateA11yCodefixCommand(context);
      await command.handleExecution([
        '--site-id', 'site-123',
        '--opportunity-id', 'opp-456',
        '--archive', 'test.tar.gz',
        '--suggestion-id',
      ], slackContext);

      expect(slackContext.say).to.have.been.calledWith(sinon.match(/:warning: Missing required parameters/));
    });
  });

  describe('Handle Execution Method - Database Validation', () => {
    it('returns error when site is not found', async () => {
      dataAccessStub.Site.findById.resolves(null);

      const command = GenerateA11yCodefixCommand(context);
      await command.handleExecution(['site-123', 'opp-456', 'sugg-789', '--archive', 'test.tar.gz'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(sinon.match(/:x: No site found/));
    });

    it('returns error when opportunity is not found', async () => {
      dataAccessStub.Site.findById.resolves(createMockSite());
      dataAccessStub.Opportunity.findById.resolves(null);

      const command = GenerateA11yCodefixCommand(context);
      await command.handleExecution(['site-123', 'opp-456', 'sugg-789', '--archive', 'test.tar.gz'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(':warning: Opportunity not found: opp-456');
    });

    it('returns error when no valid suggestions found', async () => {
      dataAccessStub.Site.findById.resolves(createMockSite());
      dataAccessStub.Opportunity.findById.resolves(createMockOpportunity());
      dataAccessStub.Suggestion.findById.resolves(null);

      const command = GenerateA11yCodefixCommand(context);
      await command.handleExecution(['site-123', 'opp-456', 'sugg-789', '--archive', 'test.tar.gz'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(':warning: No valid suggestions found.');
    });

    it('filters out invalid suggestions and continues with valid ones', async () => {
      dataAccessStub.Site.findById.resolves(createMockSite());
      dataAccessStub.Opportunity.findById.resolves(createMockOpportunity());
      dataAccessStub.Suggestion.findById
        .onFirstCall().resolves(createMockSuggestion('sugg-1'))
        .onSecondCall().resolves(null)
        .onThirdCall()
        .resolves(createMockSuggestion('sugg-3'));

      // Mock S3 and SQS
      mockS3Send.resolves({});
      mockSQSSend.resolves({ MessageId: 'msg-123' });

      const command = GenerateA11yCodefixCommand(context);
      await command.handleExecution(['site-123', 'opp-456', 'sugg-1', 'sugg-invalid', 'sugg-3', '--archive', 'test.tar.gz'], slackContext);

      expect(mockSQSSend).to.have.been.called;
    });
  });

  describe('Handle Execution Method - Site Configuration Validation', () => {
    it('returns error when site has no code configuration', async () => {
      const siteWithoutCode = createMockSite({
        getCode: () => null,
      });

      dataAccessStub.Site.findById.resolves(siteWithoutCode);
      dataAccessStub.Opportunity.findById.resolves(createMockOpportunity());
      dataAccessStub.Suggestion.findById.resolves(createMockSuggestion());

      const command = GenerateA11yCodefixCommand(context);
      await command.handleExecution(['site-123', 'opp-456', 'sugg-789', '--archive', 'test.tar.gz'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(sinon.match(/does not have proper code configuration/));
    });

    it('returns error when site code is missing owner', async () => {
      const siteWithIncompleteCode = createMockSite({
        code: {
          owner: null, repo: 'test-repo', url: 'https://github.com', ref: 'main',
        },
      });

      dataAccessStub.Site.findById.resolves(siteWithIncompleteCode);
      dataAccessStub.Opportunity.findById.resolves(createMockOpportunity());
      dataAccessStub.Suggestion.findById.resolves(createMockSuggestion());

      const command = GenerateA11yCodefixCommand(context);
      await command.handleExecution(['site-123', 'opp-456', 'sugg-789', '--archive', 'test.tar.gz'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(sinon.match(/does not have proper code configuration/));
    });

    it('returns error when site code is missing repo', async () => {
      const siteWithIncompleteCode = createMockSite({
        code: {
          owner: 'test-owner', repo: null, url: 'https://github.com', ref: 'main',
        },
      });

      dataAccessStub.Site.findById.resolves(siteWithIncompleteCode);
      dataAccessStub.Opportunity.findById.resolves(createMockOpportunity());
      dataAccessStub.Suggestion.findById.resolves(createMockSuggestion());

      const command = GenerateA11yCodefixCommand(context);
      await command.handleExecution(['site-123', 'opp-456', 'sugg-789', '--archive', 'test.tar.gz'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(sinon.match(/does not have proper code configuration/));
    });
  });

  describe('Handle Execution Method - S3 Archive Validation', () => {
    it('returns error when archive does not exist in S3', async () => {
      dataAccessStub.Site.findById.resolves(createMockSite());
      dataAccessStub.Opportunity.findById.resolves(createMockOpportunity());
      dataAccessStub.Suggestion.findById.resolves(createMockSuggestion());

      // Mock S3 HeadObject to return 404
      const notFoundError = new Error('NotFound');
      notFoundError.name = 'NotFound';
      mockS3Send.rejects(notFoundError);

      const command = GenerateA11yCodefixCommand(context);
      await command.handleExecution(['site-123', 'opp-456', 'sugg-789', '--archive', 'missing.tar.gz'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(':warning: Archive `missing.tar.gz` not found');
      expect(mockSQSSend).to.not.have.been.called;
    });

    it('returns error when S3 returns 404 via $metadata', async () => {
      dataAccessStub.Site.findById.resolves(createMockSite());
      dataAccessStub.Opportunity.findById.resolves(createMockOpportunity());
      dataAccessStub.Suggestion.findById.resolves(createMockSuggestion());

      // Mock S3 HeadObject to return 404 via $metadata
      const notFoundError = new Error('NotFound');
      notFoundError.$metadata = { httpStatusCode: 404 };
      mockS3Send.rejects(notFoundError);

      const command = GenerateA11yCodefixCommand(context);
      await command.handleExecution(['site-123', 'opp-456', 'sugg-789', '--archive', 'missing.tar.gz'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(':warning: Archive `missing.tar.gz` not found');
    });

    it('throws error when S3 HeadObject fails with permission error', async () => {
      dataAccessStub.Site.findById.resolves(createMockSite());
      dataAccessStub.Opportunity.findById.resolves(createMockOpportunity());
      dataAccessStub.Suggestion.findById.resolves(createMockSuggestion());

      // Mock S3 HeadObject to fail with permissions error
      mockS3Send.rejects(new Error('Access Denied'));

      const command = GenerateA11yCodefixCommand(context);
      await command.handleExecution(['site-123', 'opp-456', 'sugg-789', '--archive', 'test.tar.gz'], slackContext);

      expect(logStub.error).to.have.been.called;
      expect(slackContext.say).to.have.been.calledWith(sinon.match(/Oops! Something went wrong/));
    });

    it('verifies correct S3 bucket and key are checked', async () => {
      dataAccessStub.Site.findById.resolves(createMockSite());
      dataAccessStub.Opportunity.findById.resolves(createMockOpportunity());
      dataAccessStub.Suggestion.findById.resolves(createMockSuggestion());

      mockS3Send.resolves({});
      mockSQSSend.resolves({ MessageId: 'msg-123' });

      const command = GenerateA11yCodefixCommand(context);
      await command.handleExecution(['site-123', 'opp-456', 'sugg-789', '--archive', 'my-archive.tar.gz'], slackContext);

      expect(mockHeadObjectCommand).to.have.been.calledWith({
        Bucket: 'spacecat-prod-mystique-assets',
        Key: 'tmp/codefix/source/my-archive.tar.gz',
      });
    });
  });

  describe('Handle Execution Method - Successful Execution', () => {
    it('sends correct SQS message payload', async () => {
      const mockSite = createMockSite();
      const mockOpportunity = createMockOpportunity();
      const mockSuggestion = createMockSuggestion('sugg-789', [
        {
          type: 'missing-alt',
          description: 'Images must have alt text',
          htmlWithIssues: [{
            update_from: '<img src="logo.png">',
            target_selector: 'img.logo',
          }],
        },
      ], 'https://example.com/page1', 'agg-key-123');

      dataAccessStub.Site.findById.resolves(mockSite);
      dataAccessStub.Opportunity.findById.resolves(mockOpportunity);
      dataAccessStub.Suggestion.findById.resolves(mockSuggestion);

      mockS3Send.resolves({});
      mockSQSSend.resolves({ MessageId: 'msg-123' });

      const command = GenerateA11yCodefixCommand(context);
      await command.handleExecution(['site-123', 'opp-456', 'sugg-789', '--archive', 'test-archive.tar.gz'], slackContext);

      expect(mockSendMessageCommand).to.have.been.called;
      const messageCall = mockSendMessageCommand.firstCall.args[0];

      expect(messageCall.QueueUrl).to.equal('https://sqs.us-east-1.amazonaws.com/123456789/mystique-queue');

      const messageBody = JSON.parse(messageCall.MessageBody);
      expect(messageBody.type).to.equal('guidance:accessibility-remediation');
      expect(messageBody.siteId).to.equal('site-123');
      expect(messageBody.auditId).to.equal('opp-456');
      expect(messageBody).to.have.property('time');
      expect(messageBody).to.not.have.property('deliveryType'); // Not in Python format
      expect(messageBody).to.not.have.property('aggregationKey'); // Should be in data
      expect(messageBody.data.url).to.equal('https://example.com/page1');
      expect(messageBody.data.opportunityId).to.equal('opp-456');
      expect(messageBody.data.aggregationKey).to.equal('agg-key-123'); // In data, not top level
      expect(messageBody.data.issuesList).to.be.an('array');
      expect(messageBody.data.issuesList).to.have.length(1);
      expect(messageBody.data.issuesList[0]).to.deep.equal({
        issue_name: 'missing-alt',
        issue_description: 'Images must have alt text',
        faulty_line: '<img src="logo.png">',
        target_selector: 'img.logo',
        suggestion_id: 'sugg-789',
      });
      expect(messageBody.data.codeBucket).to.equal('spacecat-prod-mystique-assets');
      expect(messageBody.data.codePath).to.equal('tmp/codefix/source/test-archive.tar.gz');
    });

    it('sends correct SQS message attributes', async () => {
      dataAccessStub.Site.findById.resolves(createMockSite());
      dataAccessStub.Opportunity.findById.resolves(createMockOpportunity());
      dataAccessStub.Suggestion.findById.resolves(createMockSuggestion());

      mockS3Send.resolves({});
      mockSQSSend.resolves({ MessageId: 'msg-123' });

      const command = GenerateA11yCodefixCommand(context);
      await command.handleExecution(['site-123', 'opp-456', 'sugg-789', '--archive', 'test.tar.gz'], slackContext);

      const messageCall = mockSendMessageCommand.firstCall.args[0];
      expect(messageCall.MessageAttributes).to.deep.equal({
        type: {
          DataType: 'String',
          StringValue: 'guidance:accessibility-remediation',
        },
        siteId: {
          DataType: 'String',
          StringValue: 'site-123',
        },
      });
    });

    it('handles multiple suggestion IDs correctly', async () => {
      dataAccessStub.Site.findById.resolves(createMockSite());
      dataAccessStub.Opportunity.findById.resolves(createMockOpportunity());
      dataAccessStub.Suggestion.findById
        .onFirstCall().resolves(createMockSuggestion('sugg-1', [{ type: 'issue-1', description: 'Issue 1' }], 'https://example.com/page1', 'agg-key-1'))
        .onSecondCall().resolves(createMockSuggestion('sugg-2', [{ type: 'issue-2', description: 'Issue 2' }], 'https://example.com/page2', 'agg-key-2'))
        .onThirdCall()
        .resolves(createMockSuggestion('sugg-3', [{ type: 'issue-3', description: 'Issue 3' }], 'https://example.com/page3', 'agg-key-3'));

      mockS3Send.resolves({});
      mockSQSSend.resolves({ MessageId: 'msg-123' });

      const command = GenerateA11yCodefixCommand(context);
      await command.handleExecution(['site-123', 'opp-456', 'sugg-1', 'sugg-2', 'sugg-3', '--archive', 'test.tar.gz'], slackContext);

      const messageCall = mockSendMessageCommand.firstCall.args[0];
      const messageBody = JSON.parse(messageCall.MessageBody);

      // Should use URL from first suggestion
      expect(messageBody.data.url).to.equal('https://example.com/page1');
      // Should aggregate all issues in snake_case format
      expect(messageBody.data.issuesList).to.have.length(3);
      expect(messageBody.data.issuesList[0]).to.include({
        issue_name: 'issue-1',
        issue_description: 'Issue 1',
        suggestion_id: 'sugg-1',
      });
      expect(messageBody.data.issuesList[1]).to.include({
        issue_name: 'issue-2',
        issue_description: 'Issue 2',
        suggestion_id: 'sugg-2',
      });
      expect(messageBody.data.issuesList[2]).to.include({
        issue_name: 'issue-3',
        issue_description: 'Issue 3',
        suggestion_id: 'sugg-3',
      });
    });

    it('handles suggestions with undefined issues field', async () => {
      const suggestionWithoutIssues = {
        getId: () => 'sugg-no-issues',
        getData: () => ({
          url: 'https://example.com/page-no-issues',
          aggregationKey: 'agg-key-no-issues',
        }), // No issues field
      };

      dataAccessStub.Site.findById.resolves(createMockSite());
      dataAccessStub.Opportunity.findById.resolves(createMockOpportunity());
      dataAccessStub.Suggestion.findById.resolves(suggestionWithoutIssues);

      mockS3Send.resolves({});
      mockSQSSend.resolves({ MessageId: 'msg-123' });

      const command = GenerateA11yCodefixCommand(context);
      await command.handleExecution(['site-123', 'opp-456', 'sugg-no-issues', '--archive', 'test.tar.gz'], slackContext);

      const messageCall = mockSendMessageCommand.firstCall.args[0];
      const messageBody = JSON.parse(messageCall.MessageBody);

      expect(messageBody.data.issuesList).to.deep.equal([]); // Should be empty array, not undefined
    });

    it('handles issues without htmlWithIssues (fallback case)', async () => {
      const mockSite = createMockSite();
      const mockOpportunity = createMockOpportunity();
      const mockSuggestion = {
        getId: () => 'sugg-fallback',
        getData: () => ({
          url: 'https://example.com/fallback',
          opportunityId: 'opp-456',
          aggregationKey: 'agg-fallback',
          issues: [
            {
              type: 'wcag-issue',
              description: 'WCAG violation',
              // No htmlWithIssues array
            },
          ],
        }),
      };

      dataAccessStub.Site.findById.resolves(mockSite);
      dataAccessStub.Opportunity.findById.resolves(mockOpportunity);
      dataAccessStub.Suggestion.findById.resolves(mockSuggestion);

      mockS3Send.resolves({});
      mockSQSSend.resolves({ MessageId: 'msg-fallback' });

      const command = GenerateA11yCodefixCommand(context);
      await command.handleExecution(['site-123', 'opp-456', 'sugg-fallback', '--archive', 'test.tar.gz'], slackContext);

      const messageCall = mockSendMessageCommand.firstCall.args[0];
      const messageBody = JSON.parse(messageCall.MessageBody);

      // Should use fallback to create one entry without HTML details
      expect(messageBody.data.issuesList).to.have.length(1);
      expect(messageBody.data.issuesList[0]).to.deep.equal({
        issue_name: 'wcag-issue',
        issue_description: 'WCAG violation',
        faulty_line: '',
        target_selector: '',
        suggestion_id: 'sugg-fallback',
      });
    });

    it('handles issues without type field in fallback case', async () => {
      const mockSite = createMockSite();
      const mockOpportunity = createMockOpportunity();
      const mockSuggestion = {
        getId: () => 'sugg-no-type',
        getData: () => ({
          url: 'https://example.com/page',
          opportunityId: 'opp-456',
          aggregationKey: 'agg-key',
          issues: [
            {
              // No type field
              description: 'Some description',
              // No htmlWithIssues - triggers fallback path
            },
          ],
        }),
      };

      dataAccessStub.Site.findById.resolves(mockSite);
      dataAccessStub.Opportunity.findById.resolves(mockOpportunity);
      dataAccessStub.Suggestion.findById.resolves(mockSuggestion);

      mockS3Send.resolves({});
      mockSQSSend.resolves({ MessageId: 'msg-123' });

      const command = GenerateA11yCodefixCommand(context);
      await command.handleExecution(['site-123', 'opp-456', 'sugg-no-type', '--archive', 'test.tar.gz'], slackContext);

      const messageCall = mockSendMessageCommand.firstCall.args[0];
      const messageBody = JSON.parse(messageCall.MessageBody);

      // Should use 'unknown' for missing type in fallback path
      expect(messageBody.data.issuesList).to.have.length(1);
      expect(messageBody.data.issuesList[0].issue_name).to.equal('unknown');
      expect(messageBody.data.issuesList[0].issue_description).to.equal('Some description');
    });

    it('handles issues without type or description in fallback case', async () => {
      const mockSite = createMockSite();
      const mockOpportunity = createMockOpportunity();
      const mockSuggestion = {
        getId: () => 'sugg-no-fields',
        getData: () => ({
          url: 'https://example.com/page',
          opportunityId: 'opp-456',
          aggregationKey: 'agg-key',
          issues: [
            {
              // No type or description fields
              // No htmlWithIssues - triggers fallback path
            },
          ],
        }),
      };

      dataAccessStub.Site.findById.resolves(mockSite);
      dataAccessStub.Opportunity.findById.resolves(mockOpportunity);
      dataAccessStub.Suggestion.findById.resolves(mockSuggestion);

      mockS3Send.resolves({});
      mockSQSSend.resolves({ MessageId: 'msg-123' });

      const command = GenerateA11yCodefixCommand(context);
      await command.handleExecution(['site-123', 'opp-456', 'sugg-no-fields', '--archive', 'test.tar.gz'], slackContext);

      const messageCall = mockSendMessageCommand.firstCall.args[0];
      const messageBody = JSON.parse(messageCall.MessageBody);

      // Should use 'unknown' for both type and in the generated description
      expect(messageBody.data.issuesList).to.have.length(1);
      expect(messageBody.data.issuesList[0].issue_name).to.equal('unknown');
      expect(messageBody.data.issuesList[0].issue_description).to.equal('Accessibility issue: unknown');
    });

    it('uses site base URL when suggestion has no URL', async () => {
      const mockSite = createMockSite();
      const mockOpportunity = createMockOpportunity();
      const mockSuggestion = {
        getId: () => 'sugg-no-url',
        getData: () => ({
          // No url field
          opportunityId: 'opp-456',
          aggregationKey: 'agg-key',
          issues: [],
        }),
      };

      dataAccessStub.Site.findById.resolves(mockSite);
      dataAccessStub.Opportunity.findById.resolves(mockOpportunity);
      dataAccessStub.Suggestion.findById.resolves(mockSuggestion);

      mockS3Send.resolves({});
      mockSQSSend.resolves({ MessageId: 'msg-123' });

      const command = GenerateA11yCodefixCommand(context);
      await command.handleExecution(['site-123', 'opp-456', 'sugg-no-url', '--archive', 'test.tar.gz'], slackContext);

      const messageCall = mockSendMessageCommand.firstCall.args[0];
      const messageBody = JSON.parse(messageCall.MessageBody);

      // Should use site.getBaseURL() as fallback
      expect(messageBody.data.url).to.equal('https://example.com');
    });

    it('uses default aggregation key when suggestion has none', async () => {
      const mockSite = createMockSite();
      const mockOpportunity = createMockOpportunity();
      const mockSuggestion = {
        getId: () => 'sugg-no-agg',
        getData: () => ({
          url: 'https://example.com/page',
          opportunityId: 'opp-456',
          // No aggregationKey
          issues: [],
        }),
      };

      dataAccessStub.Site.findById.resolves(mockSite);
      dataAccessStub.Opportunity.findById.resolves(mockOpportunity);
      dataAccessStub.Suggestion.findById.resolves(mockSuggestion);

      mockS3Send.resolves({});
      mockSQSSend.resolves({ MessageId: 'msg-123' });

      const command = GenerateA11yCodefixCommand(context);
      await command.handleExecution(['site-123', 'opp-456', 'sugg-no-agg', '--archive', 'test.tar.gz'], slackContext);

      const messageCall = mockSendMessageCommand.firstCall.args[0];
      const messageBody = JSON.parse(messageCall.MessageBody);

      // Should generate default aggregationKey starting with 'slack-'
      expect(messageBody.data.aggregationKey).to.match(/^slack-\d+$/);
    });

    it('handles issues with missing type and description fields', async () => {
      const mockSite = createMockSite();
      const mockOpportunity = createMockOpportunity();
      const mockSuggestion = {
        getId: () => 'sugg-missing-fields',
        getData: () => ({
          url: 'https://example.com/page',
          opportunityId: 'opp-456',
          aggregationKey: 'agg-key',
          issues: [
            {
              // Missing type and description
              htmlWithIssues: [
                {
                  // All fields missing
                },
              ],
            },
          ],
        }),
      };

      dataAccessStub.Site.findById.resolves(mockSite);
      dataAccessStub.Opportunity.findById.resolves(mockOpportunity);
      dataAccessStub.Suggestion.findById.resolves(mockSuggestion);

      mockS3Send.resolves({});
      mockSQSSend.resolves({ MessageId: 'msg-123' });

      const command = GenerateA11yCodefixCommand(context);
      await command.handleExecution(['site-123', 'opp-456', 'sugg-missing-fields', '--archive', 'test.tar.gz'], slackContext);

      const messageCall = mockSendMessageCommand.firstCall.args[0];
      const messageBody = JSON.parse(messageCall.MessageBody);

      // Should use 'unknown' for missing type and generate description
      expect(messageBody.data.issuesList).to.have.length(1);
      expect(messageBody.data.issuesList[0].issue_name).to.equal('unknown');
      expect(messageBody.data.issuesList[0].issue_description).to.equal('Accessibility issue: unknown');
      expect(messageBody.data.issuesList[0].faulty_line).to.equal('');
      expect(messageBody.data.issuesList[0].target_selector).to.equal('');
    });

    it('handles HTML issues with snake_case fields', async () => {
      const mockSite = createMockSite();
      const mockOpportunity = createMockOpportunity();
      const mockSuggestion = {
        getId: () => 'sugg-snake-case',
        getData: () => ({
          url: 'https://example.com/page',
          opportunityId: 'opp-456',
          aggregationKey: 'agg-key',
          issues: [
            {
              type: 'test-issue',
              description: 'Test description',
              htmlWithIssues: [
                {
                  update_from: '<div>old</div>', // snake_case
                  target_selector: '.test-selector', // snake_case
                },
              ],
            },
          ],
        }),
      };

      dataAccessStub.Site.findById.resolves(mockSite);
      dataAccessStub.Opportunity.findById.resolves(mockOpportunity);
      dataAccessStub.Suggestion.findById.resolves(mockSuggestion);

      mockS3Send.resolves({});
      mockSQSSend.resolves({ MessageId: 'msg-123' });

      const command = GenerateA11yCodefixCommand(context);
      await command.handleExecution(['site-123', 'opp-456', 'sugg-snake-case', '--archive', 'test.tar.gz'], slackContext);

      const messageCall = mockSendMessageCommand.firstCall.args[0];
      const messageBody = JSON.parse(messageCall.MessageBody);

      // Should correctly use snake_case fields
      expect(messageBody.data.issuesList[0].faulty_line).to.equal('<div>old</div>');
      expect(messageBody.data.issuesList[0].target_selector).to.equal('.test-selector');
    });

    it('sends success message with correct details', async () => {
      const mockSite = createMockSite();
      dataAccessStub.Site.findById.resolves(mockSite);
      dataAccessStub.Opportunity.findById.resolves(createMockOpportunity());
      dataAccessStub.Suggestion.findById.resolves(createMockSuggestion());

      mockS3Send.resolves({});
      mockSQSSend.resolves({ MessageId: 'sqs-msg-456' });

      const command = GenerateA11yCodefixCommand(context);
      await command.handleExecution(['site-123', 'opp-456', 'sugg-789', '--archive', 'test.tar.gz'], slackContext);

      const successCall = slackContext.say.lastCall.args[0];
      expect(successCall).to.have.property('text', ':white_check_mark: Fix request sent successfully!');
      expect(successCall).to.have.property('blocks');
      expect(successCall.blocks[0].text.text).to.include('https://example.com');
      expect(successCall.blocks[0].text.text).to.include('accessibility');
      expect(successCall.blocks[0].text.text).to.include('sqs-msg-456');
    });

    it('uses S3 bucket from environment', async () => {
      dataAccessStub.Site.findById.resolves(createMockSite());
      dataAccessStub.Opportunity.findById.resolves(createMockOpportunity());
      dataAccessStub.Suggestion.findById.resolves(createMockSuggestion());

      mockS3Send.resolves({});
      mockSQSSend.resolves({ MessageId: 'msg-123' });

      const command = GenerateA11yCodefixCommand(context);
      await command.handleExecution(['site-123', 'opp-456', 'sugg-789', '--archive', 'test.tar.gz'], slackContext);

      const messageCall = mockSendMessageCommand.firstCall.args[0];
      const messageBody = JSON.parse(messageCall.MessageBody);

      expect(messageBody.data.codeBucket).to.equal('spacecat-prod-mystique-assets');
    });
  });

  describe('Handle Execution Method - Error Handling', () => {
    it('handles error when SQS_SPACECAT_TO_MYSTIQUE_QUEUE_URL is not configured', async () => {
      context.env.SQS_SPACECAT_TO_MYSTIQUE_QUEUE_URL = undefined;

      dataAccessStub.Site.findById.resolves(createMockSite());
      dataAccessStub.Opportunity.findById.resolves(createMockOpportunity());
      dataAccessStub.Suggestion.findById.resolves(createMockSuggestion());

      const command = GenerateA11yCodefixCommand(context);
      await command.handleExecution(['site-123', 'opp-456', 'sugg-789', '--archive', 'test.tar.gz'], slackContext);

      expect(logStub.error).to.have.been.called;
      expect(slackContext.say).to.have.been.calledWith(sinon.match(/Oops! Something went wrong/));
    });

    it('handles error when S3_MYSTIQUE_BUCKET_NAME is not configured', async () => {
      context.env.S3_MYSTIQUE_BUCKET_NAME = undefined;

      dataAccessStub.Site.findById.resolves(createMockSite());
      dataAccessStub.Opportunity.findById.resolves(createMockOpportunity());
      dataAccessStub.Suggestion.findById.resolves(createMockSuggestion());

      const command = GenerateA11yCodefixCommand(context);
      await command.handleExecution(['site-123', 'opp-456', 'sugg-789', '--archive', 'test.tar.gz'], slackContext);

      expect(logStub.error).to.have.been.called;
      expect(slackContext.say).to.have.been.calledWith(sinon.match(/Oops! Something went wrong/));
    });

    it('handles SQS send failure gracefully', async () => {
      dataAccessStub.Site.findById.resolves(createMockSite());
      dataAccessStub.Opportunity.findById.resolves(createMockOpportunity());
      dataAccessStub.Suggestion.findById.resolves(createMockSuggestion());

      mockS3Send.resolves({});
      mockSQSSend.rejects(new Error('SQS Error'));

      const command = GenerateA11yCodefixCommand(context);
      await command.handleExecution(['site-123', 'opp-456', 'sugg-789', '--archive', 'test.tar.gz'], slackContext);

      expect(logStub.error).to.have.been.calledWith('Error sending Mystique fix request:', sinon.match.instanceOf(Error));
      expect(slackContext.say).to.have.been.calledWith(sinon.match(/Oops! Something went wrong/));
    });

    it('handles database errors gracefully', async () => {
      dataAccessStub.Site.findById.rejects(new Error('Database connection failed'));

      const command = GenerateA11yCodefixCommand(context);
      await command.handleExecution(['site-123', 'opp-456', 'sugg-789', '--archive', 'test.tar.gz'], slackContext);

      expect(logStub.error).to.have.been.called;
      expect(slackContext.say).to.have.been.calledWith(sinon.match(/Oops! Something went wrong/));
    });
  });

  describe('AWS Configuration', () => {
    it('initializes AWS clients with provided credentials', async () => {
      dataAccessStub.Site.findById.resolves(createMockSite());
      dataAccessStub.Opportunity.findById.resolves(createMockOpportunity());
      dataAccessStub.Suggestion.findById.resolves(createMockSuggestion());

      mockS3Send.resolves({});
      mockSQSSend.resolves({ MessageId: 'msg-123' });

      const command = GenerateA11yCodefixCommand(context);
      await command.handleExecution(['site-123', 'opp-456', 'sugg-789', '--archive', 'test.tar.gz'], slackContext);

      expect(mockS3Client).to.have.been.calledWith(sinon.match({
        region: 'us-east-1',
        credentials: sinon.match({
          accessKeyId: 'test-key',
          secretAccessKey: 'test-secret',
        }),
      }));
    });

    it('initializes AWS clients with session token when provided', async () => {
      context.env.AWS_SESSION_TOKEN = 'test-session-token';

      dataAccessStub.Site.findById.resolves(createMockSite());
      dataAccessStub.Opportunity.findById.resolves(createMockOpportunity());
      dataAccessStub.Suggestion.findById.resolves(createMockSuggestion());

      mockS3Send.resolves({});
      mockSQSSend.resolves({ MessageId: 'msg-123' });

      const command = GenerateA11yCodefixCommand(context);
      await command.handleExecution(['site-123', 'opp-456', 'sugg-789', '--archive', 'test.tar.gz'], slackContext);

      expect(mockS3Client).to.have.been.calledWith(sinon.match({
        credentials: sinon.match({
          sessionToken: 'test-session-token',
        }),
      }));
    });

    it('uses default region when not configured', async () => {
      context.env.AWS_REGION = undefined;

      dataAccessStub.Site.findById.resolves(createMockSite());
      dataAccessStub.Opportunity.findById.resolves(createMockOpportunity());
      dataAccessStub.Suggestion.findById.resolves(createMockSuggestion());

      mockS3Send.resolves({});
      mockSQSSend.resolves({ MessageId: 'msg-123' });

      const command = GenerateA11yCodefixCommand(context);
      await command.handleExecution(['site-123', 'opp-456', 'sugg-789', '--archive', 'test.tar.gz'], slackContext);

      expect(mockS3Client).to.have.been.calledWith(sinon.match({
        region: 'us-east-1',
      }));
    });
  });
});
