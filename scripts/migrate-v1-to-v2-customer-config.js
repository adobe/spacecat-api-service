#!/usr/bin/env node

/*
 * Copyright 2026 Adobe. All rights reserved.
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
 * Migration script to convert V1 LLMO configs to V2 Customer Configs
 *
 * Usage:
 *   node scripts/migrate-v1-to-v2-customer-config.js --org-id <organizationId>
 *   node scripts/migrate-v1-to-v2-customer-config.js --all
 *
 * This script:
 * 1. Fetches all sites for an organization
 * 2. Reads V1 LLMO config from S3 for each site (opportunities/{siteId}/config.json)
 * 3. Aggregates and deduplicates the data
 * 4. Converts to V2 Customer Config schema
 * 5. Saves to S3 (customer-config-v2/{imsOrgId}/config.json)
 */

/* eslint-disable no-console, no-await-in-loop, no-plusplus, no-shadow, import/no-extraneous-dependencies, max-len */

import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { config } from 'dotenv';
import { parseArgs } from 'util';
import { createDataAccess } from '@adobe/spacecat-shared-data-access';
import { convertV1ToV2 } from '../src/support/customer-config-mapper.js';
import { saveCustomerConfigV2ToS3 } from '../src/support/customer-config-v2-s3.js';

// Load environment variables
config();

const { AWS_REGION = 'us-east-1', S3_BUCKET_NAME } = process.env;

if (!S3_BUCKET_NAME) {
  console.error('Error: S3_BUCKET_NAME environment variable is required');
  process.exit(1);
}

const s3Client = new S3Client({ region: AWS_REGION });

/**
 * Fetches LLMO config from S3 for a site
 */
async function getLlmoConfigFromS3(siteId) {
  const key = `opportunities/${siteId}/config.json`;

  try {
    const command = new GetObjectCommand({
      Bucket: S3_BUCKET_NAME,
      Key: key,
    });

    const response = await s3Client.send(command);
    const body = await response.Body.transformToString();
    return JSON.parse(body);
  } catch (error) {
    if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
      return null;
    }
    throw error;
  }
}

/**
 * Merges multiple V2 configs (from different sites) into one org-level config
 */
function mergeV2Configs(configs) {
  if (configs.length === 0) {
    return null;
  }

  if (configs.length === 1) {
    return configs[0];
  }

  // Use first config as base
  const merged = JSON.parse(JSON.stringify(configs[0]));

  // Merge brands from other configs
  for (let i = 1; i < configs.length; i++) {
    const config = configs[i];

    config.customer.brands.forEach((brand) => {
      // Check if brand already exists (by name)
      const existingBrand = merged.customer.brands.find((b) => b.name === brand.name);

      if (!existingBrand) {
        merged.customer.brands.push(brand);
      } else {
        // Merge regions
        brand.region.forEach((region) => {
          if (!existingBrand.region.includes(region)) {
            existingBrand.region.push(region);
          }
        });

        // Merge aliases
        brand.brandAliases.forEach((alias) => {
          const exists = existingBrand.brandAliases.some((a) => a.name === alias.name);
          if (!exists) {
            existingBrand.brandAliases.push(alias);
          }
        });

        // Merge competitors
        brand.competitors.forEach((comp) => {
          const exists = existingBrand.competitors.some((c) => c.name === comp.name);
          if (!exists) {
            existingBrand.competitors.push(comp);
          }
        });

        // Merge categories (by name)
        brand.categories.forEach((category) => {
          const existingCategory = existingBrand.categories.find((c) => c.name === category.name);
          if (!existingCategory) {
            existingBrand.categories.push(category);
          }
        });
      }
    });
  }

  return merged;
}

/**
 * Migrates an organization
 */
async function migrateOrganization(dataAccess, organization) {
  const orgId = organization.getId();
  const orgName = organization.getName();
  const imsOrgId = organization.getImsOrgId();

  console.log(`\nProcessing organization: ${orgName} (${orgId})`);
  console.log(`  IMS Org ID: ${imsOrgId}`);

  if (!imsOrgId) {
    console.log('  ⚠️  Skipped: No IMS Org ID configured');
    return { skipped: true, reason: 'no_ims_org_id' };
  }

  // Get all sites for this organization
  const sites = await dataAccess.Site.allByOrganizationId(orgId);
  console.log(`  Found ${sites.length} sites`);

  if (sites.length === 0) {
    console.log('  ⚠️  Skipped: No sites');
    return { skipped: true, reason: 'no_sites' };
  }

  // Fetch V1 LLMO configs for each site
  const v1Configs = [];
  for (const site of sites) {
    const siteId = site.getId();
    const baseURL = site.getBaseURL();

    console.log(`  Fetching LLMO config for site: ${baseURL} (${siteId})`);

    const llmoConfig = await getLlmoConfigFromS3(siteId);
    if (llmoConfig) {
      v1Configs.push({ siteId, baseURL, config: llmoConfig });
      console.log('    ✓ Found V1 config');
    } else {
      console.log('    - No V1 config found');
    }
  }

  if (v1Configs.length === 0) {
    console.log('  ⚠️  Skipped: No V1 LLMO configs found');
    return { skipped: true, reason: 'no_v1_configs' };
  }

  // Convert each V1 config to V2
  console.log(`  Converting ${v1Configs.length} V1 configs to V2...`);
  const v2Configs = v1Configs.map(({ siteId, config }) => {
    try {
      return convertV1ToV2(config, orgName, imsOrgId);
    } catch (error) {
      console.error(`    ✗ Failed to convert config for site ${siteId}:`, error.message);
      return null;
    }
  }).filter(Boolean);

  if (v2Configs.length === 0) {
    console.log('  ✗ Failed: Could not convert any V1 configs');
    return { failed: true, reason: 'conversion_failed' };
  }

  // Merge all V2 configs into one org-level config
  console.log(`  Merging ${v2Configs.length} V2 configs...`);
  const mergedConfig = mergeV2Configs(v2Configs);

  // Save to S3
  console.log(`  Saving to S3: customer-config-v2/${imsOrgId}/config.json`);
  await saveCustomerConfigV2ToS3(imsOrgId, mergedConfig, s3Client, S3_BUCKET_NAME);

  console.log('  ✓ Migration complete!');
  console.log(`    - Brands: ${mergedConfig.customer.brands.length}`);
  console.log(`    - Categories: ${mergedConfig.customer.brands.reduce((sum, b) => sum + b.categories.length, 0)}`);

  return { success: true, config: mergedConfig };
}

/**
 * Main function
 */
async function main() {
  const { values } = parseArgs({
    options: {
      'org-id': { type: 'string' },
      all: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
  });

  console.log('Customer Config V1 → V2 Migration Script');
  console.log('=========================================\n');

  if (values['dry-run']) {
    console.log('⚠️  DRY RUN MODE - No changes will be saved to S3\n');
  }

  // Initialize data access
  const dataAccess = createDataAccess();

  let organizations = [];

  if (values['org-id']) {
    const org = await dataAccess.Organization.findById(values['org-id']);
    if (!org) {
      console.error(`Error: Organization not found: ${values['org-id']}`);
      process.exit(1);
    }
    organizations = [org];
  } else if (values.all) {
    organizations = await dataAccess.Organization.all();
    console.log(`Found ${organizations.length} organizations\n`);
  } else {
    console.error('Error: Must specify --org-id or --all');
    console.log('\nUsage:');
    console.log('  node scripts/migrate-v1-to-v2-customer-config.js --org-id <organizationId>');
    console.log('  node scripts/migrate-v1-to-v2-customer-config.js --all');
    console.log('  node scripts/migrate-v1-to-v2-customer-config.js --all --dry-run');
    process.exit(1);
  }

  const results = {
    total: organizations.length,
    success: 0,
    skipped: 0,
    failed: 0,
  };

  for (const org of organizations) {
    try {
      const result = await migrateOrganization(dataAccess, org);

      if (result.success) {
        results.success++;
      } else if (result.skipped) {
        results.skipped++;
      } else if (result.failed) {
        results.failed++;
      }
    } catch (error) {
      console.error('  ✗ Unexpected error:', error);
      results.failed++;
    }
  }

  console.log('\n=========================================');
  console.log('Migration Summary:');
  console.log(`  Total organizations: ${results.total}`);
  console.log(`  ✓ Successful: ${results.success}`);
  console.log(`  - Skipped: ${results.skipped}`);
  console.log(`  ✗ Failed: ${results.failed}`);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
