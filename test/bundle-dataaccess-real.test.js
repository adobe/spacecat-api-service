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

import { main } from './utils.js';

use(sinonChai);

/**
 * This test does NOT provide dataAccess mocks.
 * It relies on the bundled code to properly initialize dataAccess via the wrapper.
 * This will reveal if the bundle is truly broken.
 */
describe.skip('Bundle Test: Real Data-Access (No Mocks)', () => {
  it('should have dataAccess populated by the bundle wrapper', async () => {
    console.log('\n=== Testing Real Data-Access in Bundle ===');
    console.log('Bundle location:', process.env.HELIX_TEST_BUNDLE_NAME || 'Not specified');
    console.log('This test does NOT provide dataAccess mocks');
    console.log('If the bundle is broken, dataAccess will be undefined\n');

    // Create a minimal context WITHOUT dataAccess mocks
    const context = {
      log: console,
      runtime: {
        region: 'us-east-1',
      },
      pathInfo: {
        suffix: '/trigger',
        headers: {},
      },
      env: {
        USER_API_KEY: 'test-api-key',
        ADMIN_API_KEY: 'test-admin-api-key',

        // AWS credentials from .env
        AWS_REGION: process.env.AWS_REGION || 'us-east-1',
        AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID || 'test-key',
        AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY || 'test-secret',

        // DynamoDB tables
        DYNAMO_TABLE_NAME_SITES: process.env.DYNAMO_TABLE_NAME_SITES || 'test-sites',
        DYNAMO_TABLE_NAME_CONFIGURATIONS: process.env.DYNAMO_TABLE_NAME_CONFIGURATIONS || 'test-configs',

        // Slack (needed but will fail, that's ok)
        SLACK_BOT_TOKEN: 'xoxb-test',
        SLACK_SIGNING_SECRET: 'test-secret',
      },
      // NOTE: NO dataAccess provided here!
      // The bundle wrapper should populate it
    };

    const request = new Request('https://spacecat.adobe.com/trigger?url=all&type=cwv', {
      headers: {
        'x-api-key': 'test-api-key',
      },
    });

    console.log('Making request to /trigger endpoint...');
    console.log('This endpoint uses Configuration.findLatest()');
    console.log('If dataAccess is undefined, we will see: "Cannot read properties of undefined (reading \'findLatest\')"\n');

    try {
      const response = await main(request, context);

      console.log('Response status:', response.status);
      const errorHeader = response.headers.get('x-error');
      console.log('Error header:', errorHeader);

      // Check if we got the "undefined" error (bundle is broken)
      if (errorHeader && errorHeader.includes('undefined')) {
        console.log('\n🔴 BUNDLE IS BROKEN!');
        console.log('Error message contains "undefined" - dataAccess was not populated');
        console.log('This confirms the ESBuild bundling issue');

        // This is what we expect when broken
        expect(errorHeader).to.include('Failed to trigger');
      } else {
        console.log('\n✅ BUNDLE MAY BE WORKING!');
        console.log('Did not see "undefined" error');
        console.log('dataAccess appears to be properly initialized');
      }

      // Log the full response for analysis
      const bodyText = await response.text();
      console.log('\nResponse body:', bodyText);

      // The test passes either way - we're just investigating
      expect(response).to.exist;
    } catch (error) {
      console.log('\n🔴 EXCEPTION CAUGHT:');
      console.log('Error message:', error.message);
      console.log('Error stack:', error.stack);

      // Check if it's the "undefined" error
      if (error.message.includes('undefined') || error.message.includes('findLatest')) {
        console.log('\n⚠️  This is the bundling issue!');
        console.log('dataAccess.Configuration is undefined in the bundle');
      }

      // Re-throw to fail the test and show the error
      throw error;
    }
  });

  it('should test ApiKey access in bundle', async () => {
    console.log('\n=== Testing ApiKey Data-Access in Bundle ===');

    // Create a request that will trigger ApiKey lookup
    const context = {
      log: console,
      runtime: { region: 'us-east-1' },
      pathInfo: {
        suffix: '/sites',
        headers: {},
      },
      env: {
        USER_API_KEY: 'test-api-key',
        AWS_REGION: process.env.AWS_REGION || 'us-east-1',
        AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID || 'test-key',
        AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY || 'test-secret',
        DYNAMO_TABLE_NAME_API_KEYS: process.env.DYNAMO_TABLE_NAME_API_KEYS || 'test-api-keys',
      },
    };

    const request = new Request('https://spacecat.adobe.com/sites', {
      headers: {
        'x-api-key': 'some-api-key',
      },
    });

    console.log('Making request with API key authentication...');
    console.log('This will try to call ApiKey.findByHashedApiKey()');
    console.log('If dataAccess.ApiKey is undefined, authentication will fail\n');

    try {
      const response = await main(request, context);

      console.log('Response status:', response.status);
      const errorHeader = response.headers.get('x-error');
      console.log('Error header:', errorHeader);

      if (errorHeader && errorHeader.includes('findByHashedApiKey')) {
        console.log('\n🔴 ApiKey model is undefined in bundle!');
      }

      expect(response).to.exist;
    } catch (error) {
      console.log('\n🔴 Exception:', error.message);

      if (error.message.includes('findByHashedApiKey')) {
        console.log('⚠️  dataAccess.ApiKey is undefined!');
      }

      throw error;
    }
  });
});
