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
import { expect } from 'chai';
import 'dotenv/config';

import { main } from './utils.js';

/**
 * Bundle Test: Slack Command - Audit Enable
 *
 * This test replicates the EXACT production flow that occurs when the Slack command
 * "@spacecat-dev audit enable mammotome.com 404" is executed.
 *
 * Flow:
 * 1. Slack app_mention event received
 * 2. Command parsed: enable=true, baseURL="mammotome.com", auditType="404"
 * 3. Configuration.findLatest() called
 * 4. Site.findByBaseURL("mammotome.com") called
 * 5. configuration.enableHandlerForSite("404", site) called
 * 6. configuration.save() called <-- THIS FAILS IN PRODUCTION WITH ConditionalCheckFailedException
 *
 * Expected Behavior:
 * - Configuration should be loaded successfully
 * - Audit should be enabled for the site
 * - Configuration should be saved without duplicate version conflicts
 *
 * If this test fails with ConditionalCheckFailedException, it means the bundle still
 * contains duplicate data-access code.
 */

describe('Bundle Test: Slack Audit Enable Command (Production Flow)', () => {
  let context;
  const testSiteBaseURL = 'https://mammotome.com';
  const testAuditType = '404';

  before(function () {
    // Skip if bundle environment variable not set
    if (!process.env.HELIX_TEST_BUNDLE_NAME) {
      console.log('⚠️  Skipping bundle test - HELIX_TEST_BUNDLE_NAME not set');
      console.log('   Run: npm run build && export HELIX_TEST_BUNDLE_NAME=dist/...');
      this.skip();
    }
  });

  beforeEach(() => {
    context = {
      log: console,
      runtime: { region: 'us-east-1' },
      pathInfo: { method: 'POST', suffix: '/slack/events', route: 'slack-events' },
      env: {
        SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
        SLACK_SIGNING_SECRET: process.env.SLACK_SIGNING_SECRET,
        SLACK_OPS_CHANNEL_WORKSPACE_EXTERNAL: process.env.SLACK_OPS_CHANNEL_WORKSPACE_EXTERNAL,
        SLACK_TOKEN_WORKSPACE_EXTERNAL_ELEVATED:
          process.env.SLACK_TOKEN_WORKSPACE_EXTERNAL_ELEVATED,
        S3_MYSTIQUE_BUCKET: process.env.S3_MYSTIQUE_BUCKET,
        S3_REPORT_BUCKET: process.env.S3_REPORT_BUCKET,
        REPORT_JOBS_QUEUE_URL: process.env.REPORT_JOBS_QUEUE_URL,
        SCRAPE_JOB_CONFIGURATION: process.env.SCRAPE_JOB_CONFIGURATION,
        IMS_HOST: process.env.IMS_HOST,
        IMS_CLIENT_ID: process.env.IMS_CLIENT_ID,
        IMS_CLIENT_CODE: process.env.IMS_CLIENT_CODE,
        IMS_CLIENT_SECRET: process.env.IMS_CLIENT_SECRET,
        DYNAMO_TABLE_NAME_DATA: process.env.DYNAMO_TABLE_NAME_DATA,
        DYNAMO_TABLE_NAME_CONFIGURATIONS: process.env.DYNAMO_TABLE_NAME_CONFIGURATIONS,
        DYNAMO_TABLE_NAME_SITES: process.env.DYNAMO_TABLE_NAME_SITES,
        AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
        AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
        AWS_SESSION_TOKEN: process.env.AWS_SESSION_TOKEN,
      },
    };
  });

  it('should handle "audit enable" command without ConditionalCheckFailedException', async function () {
    this.timeout(30000); // 30 second timeout for AWS operations

    console.log('\n=== Testing Slack Audit Enable Command ===');
    console.log(`Bundle: ${process.env.HELIX_TEST_BUNDLE_NAME}`);
    console.log(`Command: @spacecat-dev audit enable ${testSiteBaseURL} ${testAuditType}`);
    console.log('\n📋 Test Flow:');
    console.log('  1. Simulate Slack app_mention event');
    console.log('  2. Call Configuration.findLatest()');
    console.log('  3. Call Site.findByBaseURL()');
    console.log('  4. Call configuration.enableHandlerForSite()');
    console.log('  5. Call configuration.save()');
    console.log('\n🎯 Expected: No ConditionalCheckFailedException');
    console.log('🔴 If Failed: ESBuild bundle contains duplicate data-access code\n');

    // Create a properly formatted Slack app_mention event
    // This matches the actual event structure from Slack
    // Based on thread: https://cq-dev.slack.com/archives/C07E7BQMSEP/p1764482810749119
    const slackEvent = {
      type: 'app_mention',
      text: `<@U01234567> audit enable ${testSiteBaseURL} ${testAuditType}`,
      user: 'U01234567',
      ts: '1764482810.749119',
      channel: 'C07E7BQMSEP',
      event_ts: '1764482810.749119',
    };

    const slackPayload = {
      token: process.env.SLACK_BOT_TOKEN,
      team_id: 'T01234567',
      api_app_id: 'A01234567',
      event: slackEvent,
      type: 'event_callback',
      event_id: `Ev${Date.now()}`,
      event_time: Math.floor(Date.now() / 1000),
      authorizations: [{
        enterprise_id: null,
        team_id: 'T01234567',
        user_id: 'U01234567',
        is_bot: true,
        is_enterprise_install: false,
      }],
    };

    // Calculate Slack signature for authentication
    const timestamp = Math.floor(Date.now() / 1000);
    const signingSecret = process.env.SLACK_SIGNING_SECRET;
    const requestBody = JSON.stringify(slackPayload);

    // Create HMAC signature (simplified - in production Slack does this)
    const crypto = await import('crypto');
    const hmac = crypto.createHmac('sha256', signingSecret);
    const sigBasestring = `v0:${timestamp}:${requestBody}`;
    hmac.update(sigBasestring);
    const signature = `v0=${hmac.digest('hex')}`;

    const headers = {
      'content-type': 'application/json',
      'x-slack-signature': signature,
      'x-slack-request-timestamp': timestamp.toString(),
    };

    const request = {
      method: 'POST',
      url: 'https://base.spacecat/slack/events',
      headers: {
        get: (name) => headers[name.toLowerCase()],
        plain: () => headers,
      },
      json: async () => slackPayload,
      text: async () => requestBody,
    };

    // Capture logs to detect errors
    const logs = [];
    const originalLog = console.log;
    const originalError = console.error;

    console.log = (...args) => {
      const msg = args.join(' ');
      logs.push(msg);
      originalLog.apply(console, args);
    };

    console.error = (...args) => {
      const msg = args.join(' ');
      logs.push(msg);
      originalError.apply(console, args);
    };

    try {
      console.log('🚀 Sending Slack event to bundle...\n');

      const response = await main(request, context);

      // Restore console
      console.log = originalLog;
      console.error = originalError;

      console.log('\n📬 Slack Response:');
      console.log(`  Status: ${response.status}`);
      await response.text(); // consume body

      expect(response.status).to.equal(200);

      // Slack always returns 200, even for internal errors
      // Check the logs for error messages
      console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('VERIFICATION: Check if audit was actually enabled');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

      // Check if the Slack bot sent an error message
      const errorMessages = logs.filter((log) => log.includes(':x: An error occurred')
        || log.includes('Failed to create')
        || log.includes('ConditionalCheckFailedException'));

      console.log(`\n📊 Total log messages: ${logs.length}`);
      console.log(`   Error messages found: ${errorMessages.length}`);

      if (errorMessages.length > 0) {
        console.log('\n🔴 FAILURE: Error messages detected in logs:');
        errorMessages.forEach((msg, i) => {
          console.log(`   ${i + 1}. ${msg.substring(0, 100)}...`);
        });
        console.log('\n   This means Configuration.save() failed due to ConditionalCheckFailedException');
        console.log('   Root Cause: Duplicate data-access code in the bundle\n');

        expect.fail('Configuration.save() failed - Slack bot sent error message');
      } else {
        console.log('\n✅ SUCCESS: No error messages detected');
        console.log('   Audit was enabled and Configuration was saved successfully');
        console.log('   Bundle correctly handled the Slack command\n');
      }
    } catch (error) {
      // Restore console
      console.log = originalLog;
      console.error = originalError;

      console.log('\n🔴 ERROR CAUGHT:');
      console.log(`  Type: ${error.constructor.name}`);
      console.log(`  Message: ${error.message}`);

      if (error.stack) {
        console.log('\n  Stack trace:');
        const stackLines = error.stack.split('\n').slice(0, 15);
        stackLines.forEach((line) => console.log(`    ${line}`));
      }

      // Check for the specific error we're trying to detect
      if (error.message && error.message.includes('The conditional request failed')) {
        console.log('\n❌ CRITICAL: ConditionalCheckFailedException detected!');
        console.log('   This means the ESBuild bundle contains DUPLICATE data-access code.');
        console.log('   The Configuration version calculation is happening multiple times.');
        console.log('\n   Root Cause: Multiple copies of data-access in the bundle');
        console.log('   Expected: Single, deduplicated data-access@2.88.7 code');
      }

      throw error;
    }
  });

  it('should directly test Configuration.findLatest() and save() flow', async function () {
    this.timeout(30000);

    console.log('\n=== DIAGNOSTIC: Configuration Flow Test ===');
    console.log('Capturing all data to understand why ConditionalCheckFailedException occurs\n');

    try {
      // Use main from test/utils.js which loads the bundle
      const request = {
        method: 'POST',
        url: 'https://base.spacecat/slack/events',
        headers: {
          get: () => null,
          plain: () => ({}),
        },
        json: async () => ({}),
        text: async () => '',
      };

      // Call main to initialize dataAccess in context
      await main(request, context);

      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('STEP 1: Query existing configurations');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

      console.log('\n📞 Calling Configuration.findLatest()...');
      const latestConfig = await context.dataAccess.Configuration.findLatest();

      console.log('\n📊 findLatest() RESULT:');
      if (latestConfig) {
        console.log('   ✅ Found configuration');
        console.log(`   📌 Version: ${latestConfig.getVersion()}`);
        console.log(`   📌 Version String: ${latestConfig.getVersionString()}`);
        console.log(`   📌 ID: ${latestConfig.getId()}`);
        console.log(`   📌 Created At: ${latestConfig.getCreatedAt()}`);
        console.log(`   📌 Updated At: ${latestConfig.getUpdatedAt()}`);
        const configJson = latestConfig.toJSON();
        console.log(`   📌 Full config keys: ${Object.keys(configJson).join(', ')}`);
      } else {
        console.log('   ⚠️  NO configuration found (null)');
      }

      console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('STEP 2: Replicate actual Slack command flow (enable audit)');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

      // Track all DynamoDB PutItem calls
      let putItemCallCount = 0;
      const putItemCalls = [];

      // Monkey-patch the DynamoDB client's send method
      const originalSend = context.dataAccess.Configuration.entity.client.send;
      context.dataAccess.Configuration.entity.client.send = function (command) {
        const commandName = command.constructor.name;
        const timestamp = Date.now();

        if (commandName === 'PutCommand' || commandName === 'PutItemCommand') {
          putItemCallCount += 1;
          console.log(`\n🔍 INTERCEPTED DynamoDB PutItem #${putItemCallCount} at ${timestamp}`);
          console.log(`   Command: ${commandName}`);
          console.log('   Stack trace:');
          const stack = new Error().stack.split('\n').slice(2, 8);
          stack.forEach((line) => console.log(`     ${line.trim()}`));

          putItemCalls.push({
            callNumber: putItemCallCount,
            timestamp,
            commandName,
            input: command.input,
          });
        }

        return originalSend.call(this, command);
      };

      console.log('\n📞 Step 2a: Get or create site...');
      let site = await context.dataAccess.Site.findByBaseURL(testSiteBaseURL);
      if (!site) {
        site = await context.dataAccess.Site.create({
          baseURL: testSiteBaseURL,
        });
        console.log(`   ✅ Created site: ${testSiteBaseURL}`);
      } else {
        console.log(`   ✅ Found site: ${testSiteBaseURL}`);
      }

      console.log('\n📞 Step 2b: Get latest configuration...');
      const config = await context.dataAccess.Configuration.findLatest();
      console.log(`   ✅ Found configuration version ${config.getVersion()}`);

      console.log('\n📞 Step 2c: Enable audit for site (as Slack command does)...');
      config.enableHandlerForSite(testAuditType, site);
      console.log(`   ✅ Enabled "${testAuditType}" audit for site`);

      console.log('\n📞 Step 2d: Save configuration...');
      console.log('   Tracking all DynamoDB PutItem operations...');
      console.log('   This is where ConditionalCheckFailedException occurs in production');

      try {
        const savedConfig = await config.save();

        // Restore original send method
        context.dataAccess.Configuration.entity.client.send = originalSend;

        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('DynamoDB PutItem Call Analysis');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        console.log(`\n📊 Total PutItem calls: ${putItemCallCount}`);

        if (putItemCallCount === 1) {
          console.log('   ✅ Only ONE PutItem call - no duplicate execution detected');
        } else if (putItemCallCount > 1) {
          console.log(`   🔴 WARNING: ${putItemCallCount} PutItem calls detected`);
          console.log('   This suggests duplicate code execution even though save() succeeded');
        }

        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('Success Result');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        console.log('\n✅ Configuration.save() SUCCEEDED');
        console.log(`   📌 Version: ${savedConfig.getVersion()}`);
        console.log(`   📌 Version String: ${savedConfig.getVersionString()}`);
        console.log(`   📌 ID: ${savedConfig.getId()}`);
      } catch (createError) {
        // Restore original send method
        context.dataAccess.Configuration.entity.client.send = originalSend;

        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('DynamoDB PutItem Call Analysis');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        console.log(`\n📊 Total PutItem calls: ${putItemCallCount}`);

        if (putItemCallCount === 0) {
          console.log('   ⚠️  No PutItem calls detected - create() didn\'t even try to write');
        } else if (putItemCallCount === 1) {
          console.log('   ✅ Only ONE PutItem call detected');
          console.log('   💡 This means there is NO duplicate execution');
          console.log('   💡 The ConditionalCheckFailedException must be due to:');
          console.log('      - Version already exists in database');
          console.log('      - findLatest() returned wrong/stale data');
          console.log('      - Race condition from previous failed run');
        } else {
          console.log(`   🔴 MULTIPLE PutItem calls detected (${putItemCallCount})!`);
          console.log('   💡 This PROVES duplicate execution is happening');
          console.log('   💡 ESBuild bundled multiple copies that are executing simultaneously');

          // Analyze timing
          const timeDiffs = [];
          for (let i = 1; i < putItemCalls.length; i += 1) {
            const diff = putItemCalls[i].timestamp - putItemCalls[i - 1].timestamp;
            timeDiffs.push(diff);
            console.log(`\n   Time between call #${i} and #${i + 1}: ${diff}ms`);
          }

          if (timeDiffs.every((diff) => diff < 10)) {
            console.log('\n   🔴 All calls happened within 10ms of each other');
            console.log('   💡 This is SIMULTANEOUS execution from duplicate code');
          }
        }

        putItemCalls.forEach((call, index) => {
          console.log(`\n   Call #${index + 1} details:`);
          const item = call.input?.Item;
          if (item && item.version) {
            console.log(`     Version attempting to create: ${item.version?.N || item.version}`);
          }
        });

        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('Error Details');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        console.log('\n❌ Configuration.create() FAILED');
        console.log(`   Error Type: ${createError.constructor.name}`);
        console.log(`   Error Message: ${createError.message}`);

        if (createError.cause) {
          console.log(`\n   🔍 CAUSE: ${createError.cause.constructor.name}`);
          console.log(`   Cause Message: ${createError.cause.message}`);

          if (createError.cause.cause) {
            console.log(`\n   🔍 ROOT CAUSE: ${createError.cause.cause.constructor.name}`);
            console.log(`   Root Cause Message: ${createError.cause.cause.message}`);
          }
        }

        // Now let's manually trace what create() does
        throw createError;
      }
    } catch (error) {
      console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('TEST FAILED - See diagnostic output above');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      throw error;
    }
  });
});
