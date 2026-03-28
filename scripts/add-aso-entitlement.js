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
 * Add ASO Free Trial Entitlement Script
 *
 * Adds an ASO FREE_TRIAL entitlement to an organization.
 * Accepts either a siteId or an organizationId directly.
 * Skips if entitlement already exists.
 *
 * Usage:
 *   node scripts/add-aso-entitlement.js --site <siteId>
 *   node scripts/add-aso-entitlement.js --org <organizationId>
 *
 * Required environment variables:
 *   POSTGREST_URL      - PostgREST base URL
 *   POSTGREST_API_KEY  - PostgREST writer JWT
 *   AWS_REGION         - AWS region
 */

// eslint-disable-next-line import/no-extraneous-dependencies
import 'dotenv/config';
import { createDataAccess } from '@adobe/spacecat-shared-data-access';
import { Entitlement } from '@adobe/spacecat-shared-data-access/src/models/entitlement/index.js';

const log = {
  info: (...args) => console.log('[INFO]', ...args), // eslint-disable-line no-console
  warn: (...args) => console.warn('[WARN]', ...args), // eslint-disable-line no-console
  error: (...args) => console.error('[ERROR]', ...args), // eslint-disable-line no-console
};

function validateEnv() {
  const required = ['POSTGREST_URL', 'POSTGREST_API_KEY', 'AWS_REGION'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  }
}

async function main() {
  const [flag, value] = process.argv.slice(2);

  if (!flag || !value || !['--site', '--org'].includes(flag)) {
    console.error('Usage: node scripts/add-aso-entitlement.js --site <siteId>'); // eslint-disable-line no-console
    console.error('       node scripts/add-aso-entitlement.js --org <organizationId>'); // eslint-disable-line no-console
    process.exit(1);
  }

  validateEnv();

  const dataAccess = await createDataAccess(
    {
      postgrestUrl: process.env.POSTGREST_URL,
      postgrestApiKey: process.env.POSTGREST_API_KEY,
      region: process.env.AWS_REGION,
    },
    log,
  );

  const { Site, Organization, Entitlement: EntitlementModel } = dataAccess;

  let organizationId;

  if (flag === '--site') {
    const site = await Site.findById(value);
    if (!site) {
      log.error(`Site ${value} not found`);
      process.exit(1);
    }
    organizationId = site.getOrganizationId();
    log.info(`Site:         ${site.getBaseURL()} (${value})`);
  } else {
    organizationId = value;
  }

  const org = await Organization.findById(organizationId);
  if (!org) {
    log.error(`Organization ${organizationId} not found`);
    process.exit(1);
  }

  log.info(`Organization: ${org.getName()} (${organizationId})`);

  // Check if ASO entitlement already exists
  const existing = (await EntitlementModel.allByOrganizationId(organizationId))
    .find((e) => e.getProductCode() === Entitlement.PRODUCT_CODES.ASO);

  if (existing) {
    log.warn(`ASO entitlement already exists (${existing.getId()}) — skipping`);
    process.exit(0);
  }

  const entitlement = await EntitlementModel.create({
    organizationId,
    productCode: Entitlement.PRODUCT_CODES.ASO,
    tier: Entitlement.TIERS.FREE_TRIAL,
  });

  log.info(`Created ASO FREE_TRIAL entitlement: ${entitlement.getId()}`);
  log.info('Done.');
}

main().catch((error) => {
  console.error('Fatal error:', error); // eslint-disable-line no-console
  process.exit(1);
});
