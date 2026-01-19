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
 * Temporary script to create generic-autofix-edge opportunity and suggestions
 * for Adobe products pages based on schema.org data.
 * 
 * Usage: node scripts/create-generic-autofix-suggestions.js <siteId>
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';
import { createDataAccess } from '@adobe/spacecat-shared-data-access';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load environment variables from .env file
config({ path: path.join(__dirname, '../.env-dev') });

// Constants
const OPPORTUNITY_TYPE = 'generic-autofix-edge';
const BASE_URL = 'https://www.adobe.com/products';
const DATA_FOLDER = path.join(__dirname, '../test/www-adobe-com-products');

// Fixed suggestion fields
const FIXED_SUGGESTION_FIELDS = {
  format: 'json',
  aggregationKey: null,
  contentBefore: null,
  transformRules: {
    action: 'appendChild',
    selector: 'head',
  },
  tag: 'script',
  expectedContentAfter: null,
  rationale: 'This creates a json ld in the page\'s head element',
  attrs: '{ "type": "application/ld+json" }',
};

// Opportunity template
const OPPORTUNITY_TEMPLATE = {
  runbook: 'https://wiki.corp.adobe.com/display/AEMSites/Generic+Autofix+Edge',
  type: OPPORTUNITY_TYPE,
  data: {
    dataSources: ['AI', 'Site'],
  },
  origin: 'AI',
  title: 'Product Page Enrichment',
  description: 'Generic opportunity which allows to auto-fix @ edge.',
  tags: ['isElmo'],
  status: 'NEW',
};

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
  
  // Custom logger that suppresses debug/info logs from dataAccess internals
  const log = {
    debug: () => {}, // Suppress debug logs
    info: () => {},  // Suppress info logs
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  return createDataAccess({
    tableNameData: tableName,
    s3Bucket,
    region,
  }, log, dynamoClient);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


/**
 * Make a HEAD request to validate URL exists
 */
async function validateUrlExists(url) {
  try {
    await delay(100);
    const response = await fetch(url, { method: 'HEAD' });
    return response.ok;
  } catch (error) {
    console.warn(`Failed to validate URL ${url}: ${error.message}`);
    return false;
  }
}

/**
 * Convert folder path to URL
 * Example: photoshop/features/all.fragment.html -> https://www.adobe.com/products/photoshop/features/all.html
 */
function deriveUrlFromPath(relativePath) {
  // Remove .fragment.html and add .html
  const urlPath = relativePath.replace('.fragment.html', '.html');
  return `${BASE_URL}/${urlPath}`;
}

/**
 * Extract patchValue from HTML file
 * The HTML files contain only the script tag with JSON-LD content
 */
async function extractPatchValue(filePath) {
  try {
    const htmlContent = await fs.readFile(filePath, 'utf-8');
    
    // Extract content between <script type="application/ld+json"> and </script>
    const scriptRegex = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i;
    const match = htmlContent.match(scriptRegex);
    
    if (!match || !match[1]) {
      console.warn(`No JSON-LD script found in ${filePath}`);
      return null;
    }
    
    // Return the JSON content (trimmed)
    const jsonContent = match[1].trim();
    
    // Validate it's valid JSON
    try {
      JSON.parse(jsonContent);
      return jsonContent;
    } catch (jsonError) {
      console.warn(`Invalid JSON in ${filePath}: ${jsonError.message}`);
      return null;
    }
  } catch (error) {
    console.error(`Error extracting patchValue from ${filePath}: ${error.message}`);
    return null;
  }
}

/**
 * Recursively find all .fragment.html files in a directory
 */
async function findFragmentFiles(dir, baseDir = dir) {
  const files = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    
    if (entry.isDirectory()) {
      const subFiles = await findFragmentFiles(fullPath, baseDir);
      files.push(...subFiles);
    } else if (entry.isFile() && entry.name.endsWith('.fragment.html')) {
      const relativePath = path.relative(baseDir, fullPath);
      files.push({ fullPath, relativePath });
    }
  }

  return files;
}

/**
 * Find or create the generic-autofix-edge opportunity
 */
async function ensureOpportunity(dataAccessInstance, siteId) {
  const { Opportunity } = dataAccessInstance;

  console.log(`Checking for existing ${OPPORTUNITY_TYPE} opportunity for site ${siteId}...`);

  // Check if opportunity already exists
  const opportunities = await Opportunity.allBySiteId(siteId);
  const existingOpportunity = opportunities.find(
    (opp) => opp.getType() === OPPORTUNITY_TYPE
  );

  if (existingOpportunity) {
    console.log(`Found existing opportunity: ${existingOpportunity.getId()}`);
    return existingOpportunity;
  }

  // Create new opportunity
  console.log(`Creating new ${OPPORTUNITY_TYPE} opportunity...`);
  const opportunityData = {
    ...OPPORTUNITY_TEMPLATE,
    siteId,
  };

  const newOpportunity = await Opportunity.create(opportunityData);
  console.log(`Created opportunity: ${newOpportunity.getId()}`);
  
  return newOpportunity;
}

/**
 * Create suggestions for all fragment files
 */
async function createSuggestions(opportunity, files) {
  console.log(`Processing ${files.length} fragment files...`);
  
  // Get existing suggestions and build a Set of existing URLs
  const existingSuggestions = await opportunity.getSuggestions();
  const existingUrls = new Set();
  
  existingSuggestions.forEach(suggestion => {
    const url = suggestion.getData()?.url;
    if (url) {
      existingUrls.add(url);
    }
  });
  
  if (existingSuggestions.length > 0) {
    console.log(`\nFound ${existingSuggestions.length} existing suggestions.`);
    console.log(`Will skip creating suggestions for URLs that already exist.\n`);
  }
  
  const suggestions = [];
  let rank = 1;
  let processed = 0;
  let skipped = 0;
  let skippedDuplicate = 0;
  let validated = 0;
  let invalid = 0;

  for (const { fullPath, relativePath } of files) {
    const url = deriveUrlFromPath(relativePath);
    
    // Check if suggestion with this URL already exists
    if (existingUrls.has(url)) {
      console.log(`Skipping ${relativePath} - suggestion already exists for URL: ${url}`);
      skippedDuplicate++;
      continue;
    }
    
    // Extract patchValue
    const patchValue = await extractPatchValue(fullPath);
    
    if (!patchValue) {
      console.warn(`Skipping ${relativePath} - no patchValue found`);
      skipped++;
      continue;
    }

    // Validate URL (optional but recommended)
    // If the URL does not exist, do NOT create a suggestion.
    const urlExists = await validateUrlExists(url);
    if (!urlExists) {
      console.error(`Skipping ${relativePath} - URL ${url} does not exist (HEAD request failed)`);
      invalid++;
      continue;
    }
    validated++;

    // Create suggestion data
    const suggestionData = {
      type: 'CODE_CHANGE',
      rank,
      status: 'NEW',
      data: {
        ...FIXED_SUGGESTION_FIELDS,
        patchValue,
        url,
      },
    };

    suggestions.push(suggestionData);
    processed++;

    if (processed % 10 === 0) {
      console.log(`Processed ${processed}/${files.length} files...`);
    }
  }

  console.log(`\nProcessing summary:`);
  console.log(`  Total files: ${files.length}`);
  console.log(`  Skipped (already exists): ${skippedDuplicate}`);
  console.log(`  Skipped (no patchValue): ${skipped}`);
  console.log(`  New suggestions to create: ${processed}`);
  console.log(`  URL validated: ${validated}`);
  console.log(`  URL invalid: ${invalid}`);

  if (suggestions.length === 0) {
    console.log('No suggestions to create.');
    return;
  }

  // Create suggestions in batches
  console.log(`\nCreating ${suggestions.length} suggestions...`);
  const result = await opportunity.addSuggestions(suggestions);
  
  if (result.errorItems && result.errorItems.length > 0) {
    console.error(`\nErrors creating suggestions:`);
    result.errorItems.forEach((errorItem, index) => {
      console.error(`  ${index + 1}. ${errorItem.error}`);
      if (errorItem.item?.data?.url) {
        console.error(`     URL: ${errorItem.item.data.url}`);
      }
    });
    console.log(`\nSuccessfully created: ${result.createdItems?.length || 0}`);
    console.log(`Failed: ${result.errorItems.length}`);
  } else {
    console.log(`Successfully created ${result.createdItems?.length || suggestions.length} suggestions!`);
  }
}


/**
 * Main execution
 */
async function main() {
  const siteId = process.argv[2];

  if (!siteId) {
    console.error('Usage: node scripts/create-generic-autofix-suggestions.js <siteId>');
    process.exit(1);
  }

  console.log('='.repeat(60));
  console.log('Generic Autofix Edge Opportunity & Suggestions Creator');
  console.log('='.repeat(60));
  console.log(`Site ID: ${siteId}`);
  console.log(`Data folder: ${DATA_FOLDER}`);
  console.log('='.repeat(60));

  try {
    // Initialize data access
    console.log('\nInitializing data access...');
    const dataAccessInstance = await initializeDataAccess();
    
    // Verify site exists
    const { Site } = dataAccessInstance;
    const site = await Site.findById(siteId);
    if (!site) {
      throw new Error(`Site with ID ${siteId} not found`);
    }
    console.log(`Site found: ${site.getBaseURL()}`);

    // Find or create opportunity
    const opportunity = await ensureOpportunity(dataAccessInstance, siteId);

    if (!opportunity) {
      console.error('Opportunity not found');
      process.exit(1);
    }
    // Find all fragment files
    console.log(`\nScanning for fragment files in ${DATA_FOLDER}...`);
    const files = await findFragmentFiles(DATA_FOLDER);
    console.log(`Found ${files.length} fragment files`);

    // Create suggestions (will skip URLs that already exist)
    await createSuggestions(opportunity, files);

    console.log('\n' + '='.repeat(60));
    console.log('✓ Script completed successfully!');
    console.log('='.repeat(60));
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
