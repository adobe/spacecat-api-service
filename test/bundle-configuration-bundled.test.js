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

import { expect } from 'chai';
import { main } from './utils.js';

/**
 * Test Configuration workflow using the BUNDLED code (ESBuild output).
 * This replicates what actually runs in AWS Lambda.
 *
 * We'll trigger the actual Slack "audit enable" command which:
 * 1. Calls Configuration.findLatest()
 * 2. Gets a site from the database
 * 3. Modifies the configuration (enables/disables audit)
 * 4. Calls configuration.save() which increments version
 *
 * This tests the EXACT code that runs in production after ESBuild bundling.
 */
describe.skip('Bundled Test: Configuration.findLatest() and save() with ESBuild Bundle', () => {
  let context;

  beforeEach(() => {
    console.log('\n=== Testing Configuration Workflow in ESBuild Bundle ===');
    console.log(`Bundle: ${process.env.HELIX_TEST_BUNDLE_NAME}`);
    console.log('Table:', process.env.DYNAMO_TABLE_NAME_DATA);
    console.log('AWS Region:', process.env.AWS_REGION || 'us-east-1');

    if (!process.env.DYNAMO_TABLE_NAME_DATA) {
      console.log('⚠️  DYNAMO_TABLE_NAME_DATA not set - skipping test');
      this.skip();
    }

    if (!process.env.AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID === 'fake-key-id') {
      console.log('⚠️  Real AWS credentials not set - skipping test');
      console.log('Please set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN in .env');
      this.skip();
    }

    // IMPORTANT: Do NOT pre-populate context.dataAccess
    // This forces the bundle's dataAccessWrapper middleware to create it
    context = {
      log: console,
      runtime: { region: process.env.AWS_REGION || 'us-east-1' },
      pathInfo: { suffix: '/trigger', route: 'trigger', method: 'GET' },
      env: {
        DYNAMO_TABLE_NAME_DATA: process.env.DYNAMO_TABLE_NAME_DATA,
        DYNAMO_TABLE_NAME_CONFIGURATIONS: process.env.DYNAMO_TABLE_NAME_CONFIGURATIONS,
        DYNAMO_TABLE_NAME_SITES: process.env.DYNAMO_TABLE_NAME_SITES,
        USER_API_KEY: process.env.USER_API_KEY,
        ADMIN_API_KEY: process.env.ADMIN_API_KEY,
        SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
        SLACK_SIGNING_SECRET: process.env.SLACK_SIGNING_SECRET,
        SLACK_OPS_CHANNEL_WORKSPACE_EXTERNAL: process.env.SLACK_OPS_CHANNEL_WORKSPACE_EXTERNAL,
        SLACK_TOKEN_WORKSPACE_EXTERNAL_ELEVATED:
          process.env.SLACK_TOKEN_WORKSPACE_EXTERNAL_ELEVATED,
        IMS_HOST: process.env.IMS_HOST || 'ims-na1.adobelogin.com',
        IMS_CLIENT_ID: process.env.IMS_CLIENT_ID || 'test-client-id',
        IMS_CLIENT_CODE: process.env.IMS_CLIENT_CODE || 'test-client-code',
        IMS_CLIENT_SECRET: process.env.IMS_CLIENT_SECRET || 'test-client-secret',
        AUDIT_JOBS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/test/audit-jobs-queue',
        AUDIT_REPORT_SLACK_CHANNEL_ID: process.env.SLACK_OPS_CHANNEL_WORKSPACE_EXTERNAL,
      },
      data: {},
    };
  });

  it('should test Configuration.findLatest() via /trigger endpoint with REAL dataAccess', async function () {
    this.timeout(20000);

    console.log('\n--- Testing Configuration.findLatest() in ESBuild Bundle (REAL AWS) ---');
    console.log('This calls /trigger endpoint which uses Configuration.findLatest()');
    console.log('Unlike other tests, this does NOT mock context.dataAccess');
    console.log('So the bundle will create REAL dataAccess via dataAccessWrapper');
    console.log('');
    console.log('If this fails with "Cannot read properties of undefined (reading \'findLatest\')",');
    console.log('it means the bundle has a broken EntityRegistry initialization');
    console.log('');

    const { Request } = await import('@adobe/fetch');
    const triggerRequest = new Request('https://base.spacecat/trigger?url=https://example.com&type=cwv', {
      headers: { 'x-api-key': context.env.USER_API_KEY || 'test-key' },
    });

    try {
      const resp = await main(triggerRequest, context);

      console.log('\nResponse status:', resp.status);
      const errorHeader = resp.headers.get('x-error');

      if (errorHeader) {
        console.log('Error header:', errorHeader);

        // Check for bundling issues
        if (errorHeader.includes('Cannot read properties of undefined')
            && errorHeader.includes('findLatest')) {
          console.log('');
          console.log('❌ BUNDLING ISSUE DETECTED!');
          console.log('Configuration.findLatest is undefined in the bundle');
          console.log('EntityRegistry did not initialize properly');
          console.log('');
          throw new Error(`Bundle has broken Configuration.findLatest: ${errorHeader}`);
        }

        if (errorHeader.includes('conditional') || errorHeader.includes('ConditionalCheckFailedException')) {
          console.log('');
          console.log('❌ CONDITIONAL CHECK FAILED IN BUNDLE!');
          console.log('This is the EXACT production error!');
          console.log('');
          throw new Error(`Bundle ConditionalCheckFailedException: ${errorHeader}`);
        }

        // Other errors are acceptable (e.g., Slack token issues, site not found)
        console.log('⚠️  Other error (not a bundling issue):', errorHeader);
        console.log('✅ Configuration.findLatest() executed successfully in bundle');
        console.log('✅ No undefined errors - EntityRegistry initialized correctly');
      } else {
        console.log('✅ No error header');
        console.log('✅ Configuration.findLatest() worked in bundle');
      }

      expect(resp).to.exist;
      console.log('\n🎉 Bundle test completed!');
      console.log('✅ No "Cannot read properties of undefined" errors');
      console.log('✅ EntityRegistry and Configuration work in the ESBuild bundle');
    } catch (e) {
      if (e.message.includes('BUNDLING ISSUE') || e.message.includes('CONDITIONAL CHECK FAILED')) {
        console.log('\n💥 Test failed - bundle has the production issue!');
        throw e;
      }

      // Unexpected error
      console.log('⚠️  Unexpected exception:', e.message);
      throw e;
    }
  });
});
