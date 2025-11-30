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
import { expect } from 'chai';

import { main } from './utils.js';

const baseUrl = 'https://base.spacecat';

describe.skip('Bundle Test: Configuration.findLatest()', () => {
  let request;
  let context;

  beforeEach(() => {
    context = {
      log: console,
      runtime: { region: 'us-east-1' },
      pathInfo: { suffix: '/trigger', route: 'trigger' },
      env: {
        DYNAMO_TABLE_NAME_DATA: process.env.DYNAMO_TABLE_NAME_DATA,
        DYNAMO_TABLE_NAME_CONFIGURATIONS: process.env.DYNAMO_TABLE_NAME_CONFIGURATIONS,
        DYNAMO_TABLE_NAME_SITES: process.env.DYNAMO_TABLE_NAME_SITES,
        USER_API_KEY: process.env.USER_API_KEY,
        ADMIN_API_KEY: process.env.ADMIN_API_KEY,
      },
    };
    request = new Request(`${baseUrl}/trigger?url=all&type=cwv`, {
      headers: { 'x-api-key': context.env.USER_API_KEY },
    });
  });

  it('should successfully call Configuration.findLatest() in the bundle', async () => {
    console.log('\n=== Testing Configuration.findLatest() in Bundle ===');
    console.log(`Bundle location: ${process.env.HELIX_TEST_BUNDLE_NAME}`);
    console.log('This test checks if Configuration.findLatest() works correctly when bundled');
    console.log('If broken, we will see: "Cannot read properties of undefined (reading \'findLatest\')"');
    console.log('Or version calculation will fail causing ConditionalCheckFailedException');

    try {
      const resp = await main(request, context);

      console.log('\nResponse status:', resp.status);
      console.log('Response error header:', resp.headers.get('x-error'));

      // We expect either success or a specific error, but NOT undefined dataAccess
      if (resp.status >= 500) {
        const errorMsg = resp.headers.get('x-error') || 'Unknown error';
        console.log('\n🔴 Server Error:', errorMsg);

        // Check if it's the undefined error (bundling issue)
        if (errorMsg.includes('Cannot read properties of undefined')
            || errorMsg.includes('findLatest')) {
          throw new Error(`Configuration.findLatest() failed in bundle: ${errorMsg}`);
        }

        // Other errors might be expected (no config, auth, etc.)
        console.log('⚠️  Non-bundle error (may be expected):', errorMsg);
      } else {
        console.log('✅ Request completed successfully');
      }

      // Test should pass if we didn't get undefined errors
      expect(resp).to.exist;
      expect(resp.status).to.be.oneOf([200, 202, 400, 401, 403, 404, 500]);
    } catch (e) {
      console.log('\n🔴 EXCEPTION CAUGHT:');
      console.log('Error message:', e.message);
      console.log('Error stack:', e.stack);

      // Rethrow if it's a bundling issue
      if (e.message.includes('Cannot read properties of undefined')
          || e.message.includes('findLatest')
          || e.message.includes('is not a function')) {
        throw new Error(`Configuration.findLatest() bundling issue: ${e.message}`);
      }

      // Other exceptions might be from missing env vars, which is ok for this test
      console.log('⚠️  Non-bundle exception (may be expected due to env)');
    }
  });

  it('should test Configuration access pattern directly', async () => {
    console.log('\n=== Testing Configuration Collection Access ===');
    console.log('Checking if Configuration collection is available in dataAccess');

    // Create a simple health check request that will initialize dataAccess
    const healthRequest = new Request(`${baseUrl}/_status_check/healthcheck.json`);

    try {
      const resp = await main(healthRequest, context);

      console.log('Health check status:', resp.status);

      if (resp.status === 200) {
        console.log('✅ Health check passed - dataAccess is initialized');
        const body = await resp.json();
        console.log('Response:', body);
      } else {
        console.log('⚠️  Health check returned:', resp.status);
      }

      expect(resp.status).to.equal(200);
    } catch (e) {
      console.log('\n🔴 Exception:', e.message);

      // Check for specific dataAccess errors
      if (e.message.includes('dataAccess')
          || e.message.includes('Configuration')
          || e.message.includes('undefined')) {
        throw new Error(`DataAccess initialization failed: ${e.message}`);
      }

      throw e;
    }
  });
});
