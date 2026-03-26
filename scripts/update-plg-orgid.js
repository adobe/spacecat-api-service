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
 * Update Organization ID in PLG Onboarding Table
 *
 * Usage:
 *   node scripts/update-plg-orgid.js <imsOrgId> <domain> <newOrganizationId>
 *
 * Example:
 *   node scripts/update-plg-orgid.js ABC123@AdobeOrg example.com <uuid>
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
  const [imsOrgId, domain, newOrganizationId] = process.argv.slice(2);

  if (!imsOrgId || !domain || !newOrganizationId) {
    console.error('Usage: node scripts/update-plg-orgid.js <imsOrgId> <domain> <newOrganizationId>'); // eslint-disable-line no-console
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

  const { PlgOnboarding, Organization } = dataAccess;

  const onboarding = await PlgOnboarding.findByImsOrgIdAndDomain(imsOrgId, domain);
  if (!onboarding) {
    log.error(`No PLG onboarding record found for imsOrgId=${imsOrgId} domain=${domain}`);
    process.exit(1);
  }

  const org = await Organization.findById(newOrganizationId);
  if (!org) {
    log.error(`Organization ${newOrganizationId} not found`);
    process.exit(1);
  }

  log.info(`Record:      ${onboarding.getId()}`);
  log.info(`Domain:      ${domain}`);
  log.info(`Status:      ${onboarding.getStatus()}`);
  log.info(`Old orgId:   ${onboarding.getOrganizationId()}`);
  log.info(`New orgId:   ${org.getName()} (${newOrganizationId})`);

  onboarding.setOrganizationId(newOrganizationId);
  await onboarding.save();

  log.info('Done.');
}

main().catch((error) => {
  console.error('Fatal error:', error); // eslint-disable-line no-console
  process.exit(1);
});
