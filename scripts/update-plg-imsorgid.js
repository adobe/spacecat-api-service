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
 * Update IMS Org ID in PLG Onboarding Table
 *
 * Updates the imsOrgId of a PLG onboarding record identified by domain + current imsOrgId.
 *
 * Usage:
 *   node scripts/update-plg-imsorgid.js <domain> <oldImsOrgId> <newImsOrgId>
 *
 * Example:
 *   node scripts/update-plg-imsorgid.js example.com ABC123@AdobeOrg XYZ456@AdobeOrg
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
  const [domain, oldImsOrgId, newImsOrgId] = process.argv.slice(2);

  if (!domain || !oldImsOrgId || !newImsOrgId) {
    console.error('Usage: node scripts/update-plg-imsorgid.js <domain> <oldImsOrgId> <newImsOrgId>'); // eslint-disable-line no-console
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

  const { PlgOnboarding } = dataAccess;

  const onboarding = await PlgOnboarding.findByImsOrgIdAndDomain(oldImsOrgId, domain);
  if (!onboarding) {
    log.error(`No PLG onboarding record found for imsOrgId=${oldImsOrgId} domain=${domain}`);
    process.exit(1);
  }

  log.info(`Record:      ${onboarding.getId()}`);
  log.info(`Domain:      ${domain}`);
  log.info(`Status:      ${onboarding.getStatus()}`);
  log.info(`Old imsOrgId: ${oldImsOrgId}`);
  log.info(`New imsOrgId: ${newImsOrgId}`);

  // imsOrgId is readOnly — create a new record with the new imsOrgId
  const newRecord = await PlgOnboarding.create({
    imsOrgId: newImsOrgId,
    domain: onboarding.getDomain(),
    baseURL: onboarding.getBaseURL(),
    status: onboarding.getStatus(),
    ...(onboarding.getSiteId() && { siteId: onboarding.getSiteId() }),
    ...(onboarding.getOrganizationId() && { organizationId: onboarding.getOrganizationId() }),
    ...(onboarding.getSteps() && { steps: onboarding.getSteps() }),
    ...(onboarding.getCompletedAt() && { completedAt: onboarding.getCompletedAt() }),
    ...(onboarding.getWaitlistReason() && { waitlistReason: onboarding.getWaitlistReason() }),
    ...(onboarding.getBotBlocker() && { botBlocker: onboarding.getBotBlocker() }),
    ...(onboarding.getError() && { error: onboarding.getError() }),
  });
  log.info(`Created new record: ${newRecord.getId()}`);

  log.info('Done.');
}

main().catch((error) => {
  console.error('Fatal error:', error); // eslint-disable-line no-console
  process.exit(1);
});
