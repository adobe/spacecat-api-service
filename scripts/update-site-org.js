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
 * Update Site Organisation Script
 *
 * Changes the organization of a site by imsOrgId.
 * If no organization exists for the given imsOrgId, one is created automatically.
 *
 * Usage:
 *   node scripts/update-site-org.js <siteId> <imsOrgId>
 *
 * Example:
 *   node scripts/update-site-org.js c8dc13b1-... ABC123@AdobeOrg
 *
 * Required environment variables:
 *   POSTGREST_URL      - PostgREST base URL
 *   POSTGREST_API_KEY  - PostgREST writer JWT
 *   AWS_REGION         - AWS region
 */

// eslint-disable-next-line import/no-extraneous-dependencies
import 'dotenv/config';
import { createDataAccess } from '@adobe/spacecat-shared-data-access';

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
  const [siteId, imsOrgId] = process.argv.slice(2);

  if (!siteId || !imsOrgId) {
    console.error('Usage: node scripts/update-site-org.js <siteId> <imsOrgId>'); // eslint-disable-line no-console
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

  const { Site, Organization } = dataAccess;

  const site = await Site.findById(siteId);
  if (!site) {
    log.error(`Site ${siteId} not found`);
    process.exit(1);
  }

  let org = await Organization.findByImsOrgId(imsOrgId);
  if (org) {
    log.info(`Found existing organization: ${org.getName()} (${org.getId()})`);
  } else {
    log.info(`No organization found for ${imsOrgId}, creating one...`);
    org = await Organization.create({ name: `Organization ${imsOrgId}`, imsOrgId });
    log.info(`Created organization: ${org.getId()}`);
  }

  const oldOrgId = site.getOrganizationId();
  log.info(`Site:     ${site.getBaseURL()} (${siteId})`);
  log.info(`Old org:  ${oldOrgId}`);
  log.info(`New org:  ${org.getName()} (${org.getId()})`);

  site.setOrganizationId(org.getId());
  await site.save();

  log.info('Done.');
}

main().catch((error) => {
  console.error('Fatal error:', error); // eslint-disable-line no-console
  process.exit(1);
});
