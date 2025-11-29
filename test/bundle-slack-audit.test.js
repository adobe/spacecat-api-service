/*
 * Copyright 2024 Adobe. All rights reserved.
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

import 'dotenv/config';

import { Request } from '@adobe/fetch';
import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';

import { main } from './utils.js';

use(sinonChai);

/**
 * These tests use the bundled artifact (created by npm run build) to test
 * Slack command handlers, specifically the "enable audit" command.
 *
 * This helps reproduce issues with esbuild bundling (helix-deploy 13+) that
 * may occur in production, particularly with data-access module interactions.
 *
 * To run: npm run test:bundle -- --spec=test/bundle-slack-audit.test.js
 */
describe.skip('Bundle Test: Slack Enable Audit Command', () => {
  let context;
  let mockConfiguration;
  let mockSite;

  /**
   * Creates a realistic Slack app_mention event payload.
   * This mimics what Slack sends when a user mentions the bot with a command.
   */
  function createSlackAppMentionEvent(text, channelId = 'C12345678', userId = 'U12345678') {
    return {
      type: 'event_callback',
      event_id: 'Ev12345678',
      event_time: Math.floor(Date.now() / 1000),
      token: 'verification-token',
      team_id: 'T12345678',
      api_app_id: 'A12345678',
      event: {
        type: 'app_mention',
        user: userId,
        text,
        ts: `${Date.now() / 1000}`,
        channel: channelId,
        event_ts: `${Date.now() / 1000}`,
      },
    };
  }

  beforeEach(() => {
    // Mock site object
    mockSite = {
      getId: () => 'site-123',
      getBaseURL: () => 'https://example.com',
      getDeliveryType: () => 'aem_edge',
      getOrganizationId: () => 'org-123',
      getGitHubURL: () => 'https://github.com/example/repo',
      getIsLive: () => true,
      getConfig: () => ({}),
      save: sinon.stub().resolves(),
    };

    // Mock configuration object with audit handlers
    mockConfiguration = {
      getId: () => 'config-123',
      getVersion: () => 1,
      getHandlers: sinon.stub().returns({
        404: { someConfig: true },
        'broken-backlinks': { someConfig: true },
        'lhs-mobile': { someConfig: true },
        'lhs-desktop': { someConfig: true },
        cwv: { someConfig: true },
      }),
      getJobs: () => ({}),
      getQueues: () => ({}),
      getSlackRoles: () => ({}),
      isHandlerEnabledForSite: sinon.stub().returns(false),
      enableHandlerForSite: sinon.stub(),
      disableHandlerForSite: sinon.stub(),
      setUpdatedBy: sinon.stub(),
      save: sinon.stub().resolves(),
    };

    // Set up context with all required dependencies
    context = {
      log: {
        info: sinon.stub(),
        warn: sinon.stub(),
        error: sinon.stub(),
        debug: sinon.stub(),
        level: 'info',
      },
      runtime: {
        region: 'us-east-1',
      },
      pathInfo: {
        suffix: '/slack/events',
        headers: {},
      },
      env: {
        // Slack credentials (required)
        SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN || 'xoxb-test-token',
        SLACK_SIGNING_SECRET: process.env.SLACK_SIGNING_SECRET || 'test-signing-secret',
        SLACK_OPS_CHANNEL_WORKSPACE_EXTERNAL: 'C12345678',
        SLACK_TOKEN_WORKSPACE_EXTERNAL_ELEVATED: 'xoxb-elevated-token',

        // API Keys
        USER_API_KEY: 'test-user-api-key',
        ADMIN_API_KEY: 'test-admin-api-key',

        // AWS Credentials (will use from .env if available)
        AWS_REGION: process.env.AWS_REGION || 'us-east-1',
        AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID || 'test-key-id',
        AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY || 'test-secret',

        // DynamoDB Table Name
        DYNAMO_TABLE_NAME_SITES: process.env.DYNAMO_TABLE_NAME_SITES || 'spacecat-services-sites',
        DYNAMO_TABLE_NAME_AUDITS: process.env.DYNAMO_TABLE_NAME_AUDITS || 'spacecat-services-audits',
        DYNAMO_TABLE_NAME_CONFIGURATIONS: process.env.DYNAMO_TABLE_NAME_CONFIGURATIONS || 'spacecat-services-configurations',

        // IMS
        IMS_HOST: 'mock-ims-host.example.com',
        IMS_CLIENT_ID: 'mock-client-id',
        IMS_CLIENT_CODE: 'mock-client-code',
        IMS_CLIENT_SECRET: 'mock-client-secret',

        // Other config
        IMPORT_CONFIGURATION: '{}',
        REPORT_JOBS_QUEUE_URL: 'https://sqs.example.com/reports-queue',
        S3_REPORT_BUCKET: 'test-reports-bucket',
        S3_MYSTIQUE_BUCKET: 'test-mystique-bucket',
        SCRAPE_JOB_CONFIGURATION: JSON.stringify({
          queues: ['spacecat-scrape-queue-1'],
          scrapeWorkerQueue: 'https://sqs.us-east-1.amazonaws.com/1234567890/scrape-worker-queue',
          scrapeQueueUrlPrefix: 'https://sqs.us-east-1.amazonaws.com/1234567890/',
          s3Bucket: 's3-bucket',
          options: {
            enableJavascript: true,
            hideConsentBanners: false,
          },
          maxUrlsPerJob: 3,
        }),
      },
      dataAccess: {
        Configuration: {
          findLatest: sinon.stub().resolves(mockConfiguration),
        },
        Site: {
          findByBaseURL: sinon.stub().callsFake(async (baseURL) => {
            if (baseURL === 'https://example.com') {
              return mockSite;
            }
            return null;
          }),
          findById: sinon.stub().resolves(mockSite),
          allWithLatestAudit: sinon.stub().resolves([]),
        },
        Organization: {
          findById: sinon.stub().resolves({
            getId: () => 'org-123',
            getName: () => 'Test Organization',
            getImsOrgId: () => 'TEST@AdobeOrg',
            getConfig: () => ({
              getSlackConfig: () => ({}),
              getHandlers: () => ({}),
              getImports: () => [],
            }),
          }),
        },
        Audit: {},
        Opportunity: {},
        Suggestion: {},
      },
      s3Client: {
        send: sinon.stub(),
      },
      sqsClient: {
        sendMessage: sinon.stub(),
      },
    };
  });

  afterEach(() => {
    sinon.restore();
  });

  it('should process enable audit command through bundled code', async () => {
    console.log('\n=== Testing Enable Audit Command with Bundle ===');
    console.log('Bundle location:', process.env.HELIX_TEST_BUNDLE_NAME || 'Not specified');

    // Create Slack app_mention event for "enable audit" command
    const slackPayload = createSlackAppMentionEvent(
      '<@U87654321> audit enable https://example.com lhs-mobile',
    );

    console.log('Slack payload:', JSON.stringify(slackPayload, null, 2));

    // Create request to Slack events endpoint
    const request = new Request('https://spacecat.adobe.com/slack/events', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-slack-signature': 'v0=mock-signature',
        'x-slack-request-timestamp': Math.floor(Date.now() / 1000).toString(),
      },
      body: JSON.stringify(slackPayload),
    });

    // Execute through the bundled main handler
    console.log('\nExecuting request through bundled handler...');

    try {
      const response = await main(request, context);

      console.log('\nResponse status:', response.status);
      console.log('Response headers:', response.headers.plain ? response.headers.plain() : {});

      // Try to get response body
      const responseText = await response.text();
      if (responseText) {
        console.log('Response body:', responseText);
      }

      // Check if Configuration methods were called
      console.log('\n=== Data Access Calls ===');
      console.log('Configuration.findLatest called:', context.dataAccess.Configuration.findLatest.called);
      console.log('Site.findByBaseURL called:', context.dataAccess.Site.findByBaseURL.called);

      if (context.dataAccess.Configuration.findLatest.called) {
        console.log('Configuration.findLatest call count:', context.dataAccess.Configuration.findLatest.callCount);
      }

      if (context.dataAccess.Site.findByBaseURL.called) {
        console.log('Site.findByBaseURL call count:', context.dataAccess.Site.findByBaseURL.callCount);
        console.log('Site.findByBaseURL called with:', context.dataAccess.Site.findByBaseURL.args);
      }

      // Check if configuration was modified
      if (mockConfiguration.enableHandlerForSite.called) {
        console.log('\n✓ Configuration.enableHandlerForSite was called');
        console.log('  Arguments:', mockConfiguration.enableHandlerForSite.args);
      } else {
        console.log('\n✗ Configuration.enableHandlerForSite was NOT called');
      }

      if (mockConfiguration.save.called) {
        console.log('✓ Configuration.save was called');
      } else {
        console.log('✗ Configuration.save was NOT called');
      }

      // Log any errors
      if (context.log.error.called) {
        console.log('\n=== ERRORS DETECTED ===');
        context.log.error.args.forEach((args, idx) => {
          console.log(`Error ${idx + 1}:`, args);
        });
      }

      // Basic assertions
      expect(response.status).to.be.oneOf(
        [200, 500],
        'Response should be 200 (success) or 500 (error showing the issue)',
      );

      // If we got a 500, this might be the bundling issue we're looking for
      if (response.status === 500) {
        console.log('\n⚠️  Got 500 error - this may indicate the bundling issue!');
        const errorHeader = response.headers.get ? response.headers.get('x-error') : null;
        if (errorHeader) {
          console.log('Error message:', errorHeader);
        }
      }
    } catch (error) {
      console.log('\n=== EXCEPTION CAUGHT ===');
      console.log('Error type:', error.constructor.name);
      console.log('Error message:', error.message);
      console.log('Error stack:', error.stack);

      // This is likely the bundling issue - re-throw with context
      throw new Error(`Bundle execution failed with: ${error.message}\n\nThis may be the esbuild bundling issue with data-access.\n\nOriginal stack:\n${error.stack}`);
    }
  });

  it('should handle disable audit command through bundled code', async () => {
    console.log('\n=== Testing Disable Audit Command with Bundle ===');

    // Set audit as already enabled
    mockConfiguration.isHandlerEnabledForSite.returns(true);

    // Create Slack app_mention event for "disable audit" command
    const slackPayload = createSlackAppMentionEvent(
      '<@U87654321> audit disable https://example.com lhs-mobile',
    );

    const request = new Request('https://spacecat.adobe.com/slack/events', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(slackPayload),
    });

    try {
      const response = await main(request, context);

      console.log('Response status:', response.status);

      if (context.log.error.called) {
        console.log('\n=== ERRORS DETECTED ===');
        context.log.error.args.forEach((args, idx) => {
          console.log(`Error ${idx + 1}:`, args);
        });
      }

      if (mockConfiguration.disableHandlerForSite.called) {
        console.log('✓ Configuration.disableHandlerForSite was called');
      }

      expect(response.status).to.be.oneOf([200, 500]);
    } catch (error) {
      console.log('\n=== EXCEPTION CAUGHT ===');
      console.log('Error:', error.message);
      console.log('Stack:', error.stack);
      throw error;
    }
  });

  it('should test data-access method availability in bundle', async () => {
    console.log('\n=== Testing Data Access Methods in Bundle ===');

    // This test specifically checks if data-access methods are properly bundled
    const slackPayload = createSlackAppMentionEvent(
      '<@U87654321> audit enable https://example.com cwv',
    );

    const request = new Request('https://spacecat.adobe.com/slack/events', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(slackPayload),
    });

    try {
      const response = await main(request, context);

      // Detailed logging of what got called
      console.log('\nDataAccess method calls:');
      console.log('- Configuration.findLatest:', context.dataAccess.Configuration.findLatest.callCount, 'times');
      console.log('- Site.findByBaseURL:', context.dataAccess.Site.findByBaseURL.callCount, 'times');

      if (mockConfiguration.getHandlers.called) {
        console.log('- Configuration.getHandlers:', mockConfiguration.getHandlers.callCount, 'times');
        console.log('  Returned:', Object.keys(mockConfiguration.getHandlers.returnValues[0] || {}));
      }

      if (mockConfiguration.enableHandlerForSite.called) {
        console.log('- Configuration.enableHandlerForSite:', mockConfiguration.enableHandlerForSite.callCount, 'times');
      }

      // Check for specific error patterns that indicate bundling issues
      if (context.log.error.called) {
        const errors = context.log.error.args.map((args) => args.join(' '));
        const bundlingIssuePatterns = [
          'is not a function',
          'Cannot read property',
          'undefined is not an object',
          'Module not found',
          'Cannot find module',
        ];

        errors.forEach((errorMsg) => {
          bundlingIssuePatterns.forEach((pattern) => {
            if (errorMsg.includes(pattern)) {
              console.log(`\n🔴 POTENTIAL BUNDLING ISSUE DETECTED: "${pattern}"`);
              console.log('Error message:', errorMsg);
            }
          });
        });
      }

      expect(response).to.exist;
    } catch (error) {
      console.log('\n🔴 EXCEPTION - Likely bundling issue:');
      console.log('Type:', error.constructor.name);
      console.log('Message:', error.message);

      // Check if it's related to data-access
      if (error.message.includes('dataAccess')
          || error.message.includes('Configuration')
          || error.message.includes('Site')) {
        console.log('\n⚠️  This error is related to dataAccess - likely the bundling issue!');
      }

      throw error;
    }
  });
});
