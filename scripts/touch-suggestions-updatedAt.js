#!/usr/bin/env node

/* eslint-disable */
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

/**
 * Script to update updatedAt timestamp for all suggestions of the generic-autofix-edge
 * opportunity for a given site by re-saving them with the same data values.
 * 
 * Usage: node scripts/touch-suggestions-updatedAt.js <siteId>
 */

import { config } from 'dotenv';
import { createDataAccess } from '@adobe/spacecat-shared-data-access';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load environment variables from .env file
config({ path: path.join(__dirname, '../.env-dev') });

/**
 * Initialize DynamoDB connection
 */
async function initializeDataAccess() {
  const region = process.env.AWS_REGION || 'us-east-1';
  const tableName = process.env.DYNAMO_TABLE_NAME_DATA;
  const s3Bucket = process.env.S3_CONFIG_BUCKET;

  if (!tableName) {
    throw new Error('DYNAMO_TABLE_NAME_DATA environment variable is required');
  }

  const dynamoClient = new DynamoDBClient({ region });
  
  // Custom logger that suppresses debug/info logs
  const log = {
    debug: () => {},
    info: () => {},
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  return createDataAccess({
    tableNameData: tableName,
    s3Bucket,
    region,
  }, log, dynamoClient);
}

/**
 * Touch all suggestions for the generic-autofix-edge opportunity (update their updatedAt)
 */
async function touchSuggestions(dataAccessInstance, siteId) {
  const { Opportunity, Site } = dataAccessInstance;

  // Verify site exists
  console.log(`Verifying site ${siteId}...`);
  const site = await Site.findById(siteId);
  
  if (!site) {
    throw new Error(`Site with ID ${siteId} not found`);
  }

  console.log(`Site found: ${site.getBaseURL()}`);

  // Get all opportunities for this site
  console.log('\nFetching opportunities for site...');
  const opportunities = await Opportunity.allBySiteId(siteId);
  
  console.log(`Found ${opportunities.length} opportunities for this site.`);

  // Find the generic-autofix-edge opportunity
  const OPPORTUNITY_TYPE = 'generic-autofix-edge';
  const opportunity = opportunities.find(opp => opp.getType() === OPPORTUNITY_TYPE);

  if (!opportunity) {
    throw new Error(`No ${OPPORTUNITY_TYPE} opportunity found for site ${siteId}`);
  }

  console.log(`Found ${OPPORTUNITY_TYPE} opportunity: ${opportunity.getId()}`);

  // Get all suggestions for this opportunity
  console.log('\nFetching suggestions...');
  const suggestions = await opportunity.getSuggestions();
  
  if (suggestions.length === 0) {
    console.log('No suggestions found for this opportunity.');
    return;
  }

  console.log(`Found ${suggestions.length} suggestions.`);
  console.log('\nUpdating updatedAt for all suggestions...');

  let updated = 0;
  let failed = 0;
  const errors = [];

  for (const suggestion of suggestions) {
    try {
      // Get current data value
      const currentData = suggestion.getData();
      
      // Set it to the same value (this will trigger the update tracking)
      suggestion.setData(currentData);
      
      // Save (this will update updatedAt)
      await suggestion.save();
      
      updated++;
      
      if (updated % 10 === 0) {
        console.log(`  Processed ${updated}/${suggestions.length}...`);
      }
    } catch (error) {
      failed++;
      errors.push({
        suggestionId: suggestion.getId(),
        error: error.message,
      });
      console.error(`  Failed to update suggestion ${suggestion.getId()}: ${error.message}`);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('Summary:');
  console.log(`  Total suggestions: ${suggestions.length}`);
  console.log(`  Successfully updated: ${updated}`);
  console.log(`  Failed: ${failed}`);
  
  if (errors.length > 0) {
    console.log('\nErrors:');
    errors.forEach((err, idx) => {
      console.log(`  ${idx + 1}. Suggestion ${err.suggestionId}: ${err.error}`);
    });
  }
  console.log('='.repeat(60));
}

/**
 * Main execution
 */
async function main() {
  const siteId = process.argv[2];

  if (!siteId) {
    console.error('Usage: node scripts/touch-suggestions-updatedAt.js <siteId>');
    process.exit(1);
  }

  console.log('='.repeat(60));
  console.log('Touch Suggestions updatedAt Script');
  console.log('='.repeat(60));
  console.log(`Site ID: ${siteId}`);
  console.log('='.repeat(60));

  try {
    // Initialize data access
    console.log('\nInitializing data access...');
    const dataAccessInstance = await initializeDataAccess();

    // Touch all suggestions
    await touchSuggestions(dataAccessInstance, siteId);

    console.log('\n✓ Script completed successfully!');
  } catch (error) {
    console.error('\n' + '='.repeat(60));
    console.error('✗ Script failed:');
    console.error(error.message);
    console.error('='.repeat(60));
    if (error.stack) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }
    process.exit(1);
  }
}

main();
