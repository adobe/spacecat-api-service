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
import { createDataAccess } from '@adobe/spacecat-shared-data-access';

/**
 * Direct test of Configuration workflow WITHOUT using the bundle.
 * This tests the actual DynamoDB operations to reproduce the Slack command workflow.
 *
 * Prerequisites:
 * - Set DYNAMO_TABLE_NAME_DATA in .env
 * - AWS credentials configured (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN)
 * - DynamoDB table exists with at least one Configuration and one Site
 */
describe.skip('Direct Test: Configuration.findLatest() and save() with Real DynamoDB', () => {
  let dataAccess;
  let Configuration;
  let Site;

  before(() => {
    console.log('\n=== Setting up Direct Data Access ===');
    console.log('Table:', process.env.DYNAMO_TABLE_NAME_DATA);
    console.log('AWS Region:', process.env.AWS_REGION || 'us-east-1');
    console.log('AWS_ACCESS_KEY_ID:', process.env.AWS_ACCESS_KEY_ID ? `SET (length=${process.env.AWS_ACCESS_KEY_ID.length}) [${process.env.AWS_ACCESS_KEY_ID.substring(0, 8)}...]` : 'NOT SET');
    console.log('AWS_SECRET_ACCESS_KEY:', process.env.AWS_SECRET_ACCESS_KEY ? `SET (length=${process.env.AWS_SECRET_ACCESS_KEY.length}) [${process.env.AWS_SECRET_ACCESS_KEY.substring(0, 8)}...]` : 'NOT SET');
    console.log('AWS_SESSION_TOKEN:', process.env.AWS_SESSION_TOKEN ? `SET (length=${process.env.AWS_SESSION_TOKEN.length}) [${process.env.AWS_SESSION_TOKEN.substring(0, 12)}...]` : 'NOT SET');

    if (!process.env.DYNAMO_TABLE_NAME_DATA) {
      console.log('⚠️  DYNAMO_TABLE_NAME_DATA not set - skipping test');
      this.skip();
    }

    if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
      console.log('⚠️  AWS credentials not set - skipping test');
      console.log('Please set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in .env');
      this.skip();
    }

    try {
      dataAccess = createDataAccess({
        tableNameData: process.env.DYNAMO_TABLE_NAME_DATA,
        region: process.env.AWS_REGION || 'us-east-1',
      }, console);

      Configuration = dataAccess.Configuration;
      Site = dataAccess.Site;

      console.log('✅ DataAccess initialized');
      console.log('Configuration:', !!Configuration);
      console.log('Site:', !!Site);
    } catch (error) {
      console.log('🔴 Failed to create dataAccess:', error.message);
      throw error;
    }
  });

  it('should successfully call Configuration.findLatest() with real DynamoDB', async function () {
    this.timeout(10000); // Allow time for DynamoDB call

    console.log('\n=== Testing Configuration.findLatest() ===');
    console.log('This is the exact call the audit enable command makes');

    try {
      const configuration = await Configuration.findLatest();

      console.log('✅ Configuration.findLatest() succeeded');
      console.log('Result:', configuration ? 'Found configuration' : 'No configuration (empty DB)');

      if (configuration) {
        console.log('Version:', configuration.getVersion());
        console.log('ID:', configuration.getId());
        console.log('Has handlers:', !!configuration.getHandlers());
        console.log('Handler count:', Object.keys(configuration.getHandlers() || {}).length);
      }

      expect(configuration).to.exist;
      expect(configuration.getVersion).to.be.a('function');
    } catch (error) {
      console.log('🔴 Configuration.findLatest() FAILED');
      console.log('Error:', error.message);
      console.log('Stack:', error.stack);
      throw error;
    }
  });

  it('should successfully save a modified configuration (audit enable workflow)', async function () {
    this.timeout(15000); // Allow time for multiple DynamoDB calls

    console.log('\n=== Testing Full Audit Enable Workflow ===');
    console.log('This replicates the exact sequence from the Slack audit enable command:');
    console.log('1. Configuration.findLatest()');
    console.log('2. Site.all() to get a test site');
    console.log('3. configuration.enableHandlerForSite()');
    console.log('4. configuration.save() (which creates new version)');
    console.log('');

    // Step 1: Get latest configuration
    console.log('Step 1: Calling Configuration.findLatest()...');
    let configuration;
    try {
      configuration = await Configuration.findLatest();
      if (!configuration) {
        console.log('⚠️  No configuration found - cannot test save workflow');
        this.skip();
      }
      console.log(`✅ Found configuration v${configuration.getVersion()}`);
    } catch (error) {
      console.log('🔴 findLatest() failed:', error.message);
      throw error;
    }

    // Step 2: Get a test site
    console.log('\nStep 2: Getting a test site...');
    let site;
    try {
      const sites = await Site.all();
      if (!sites || sites.length === 0) {
        console.log('⚠️  No sites found - cannot test enable workflow');
        this.skip();
      }
      // eslint-disable-next-line prefer-destructuring
      site = sites[0];
      console.log(`✅ Found site: ${site.getBaseURL()}`);
    } catch (error) {
      console.log('🔴 Site.all() failed:', error.message);
      throw error;
    }

    // Step 3: Modify configuration (enable/disable a handler)
    console.log('\nStep 3: Toggling lhs-mobile audit for site...');
    const currentVersion = configuration.getVersion();
    const isCurrentlyEnabled = configuration.isHandlerEnabledForSite('lhs-mobile', site);
    console.log(`Currently enabled: ${isCurrentlyEnabled}`);

    if (isCurrentlyEnabled) {
      configuration.disableHandlerForSite('lhs-mobile', site);
      console.log('Disabled handler (will re-enable on next test run)');
    } else {
      configuration.enableHandlerForSite('lhs-mobile', site);
      console.log('Enabled handler (will disable on next test run)');
    }

    // Step 4: Save (this is where the error happens in production)
    console.log('\nStep 4: Saving configuration...');
    console.log(`Current version: ${currentVersion}`);
    console.log('This will:');
    console.log('  a) Call findLatest() again internally');
    console.log('  b) Increment version to', currentVersion + 1);
    console.log('  c) Create new Configuration record with conditional write');
    console.log('');

    try {
      const savedConfiguration = await configuration.save();

      console.log('✅ Configuration.save() SUCCEEDED!');
      console.log(`New version: ${savedConfiguration.getVersion()}`);
      console.log(`Version increment: ${currentVersion} → ${savedConfiguration.getVersion()}`);
      console.log('');
      console.log('🎉 The workflow works correctly!');
      console.log('No ConditionalCheckFailedException');
      console.log('No version collision');

      expect(savedConfiguration.getVersion()).to.equal(currentVersion + 1);
    } catch (error) {
      console.log('🔴 Configuration.save() FAILED');
      console.log('Error name:', error.constructor.name);
      console.log('Error message:', error.message);

      if (error.message && error.message.includes('conditional request failed')) {
        console.log('');
        console.log('❌ ConditionalCheckFailedException - THIS IS THE PRODUCTION ERROR!');
        console.log('');
        console.log('Debugging info:');

        // Try to understand why the condition failed
        try {
          const currentLatest = await Configuration.findLatest();
          console.log('Latest version in DB:', currentLatest ? currentLatest.getVersion() : 'null');
          console.log('Version we tried to create:', currentVersion + 1);

          if (currentLatest && currentLatest.getVersion() >= currentVersion + 1) {
            console.log('');
            console.log('💡 DIAGNOSIS: A newer version already exists!');
            console.log('This means either:');
            console.log('1. Another process created a new version concurrently');
            console.log('2. findLatest() returned stale data');
            console.log('3. The version we modified was not the actual latest');
          }
        } catch (e) {
          console.log('Could not fetch current latest:', e.message);
        }
      }

      console.log('');
      console.log('Full error stack:');
      console.log(error.stack);

      throw error;
    }
  });
});
