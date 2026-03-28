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
 * Set PLG Onboarding Status to PRE_ONBOARDING
 *
 * Usage:
 *   node scripts/set-plg-preonboarding.js <imsOrgId> <domain>
 *
 * Example:
 *   node scripts/set-plg-preonboarding.js ABC123@AdobeOrg example.com
 *
 * Required environment variables:
 *   POSTGREST_URL      - PostgREST base URL
 *   POSTGREST_API_KEY  - PostgREST writer JWT
 *   AWS_REGION         - AWS region
 */

// eslint-disable-next-line import/no-extraneous-dependencies
import 'dotenv/config';
import { createDataAccess } from '@adobe/spacecat-shared-data-access';
import PlgOnboardingModel from '@adobe/spacecat-shared-data-access/src/models/plg-onboarding/plg-onboarding.model.js';

const { STATUSES } = PlgOnboardingModel;

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
  const [imsOrgId, domain] = process.argv.slice(2);

  if (!imsOrgId || !domain) {
    console.error('Usage: node scripts/set-plg-preonboarding.js <imsOrgId> <domain>'); // eslint-disable-line no-console
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

  const onboarding = await PlgOnboarding.findByImsOrgIdAndDomain(imsOrgId, domain);
  if (!onboarding) {
    log.error(`No PLG onboarding record found for imsOrgId=${imsOrgId} domain=${domain}`);
    process.exit(1);
  }

  const oldStatus = onboarding.getStatus();
  log.info(`Record:     ${onboarding.getId()}`);
  log.info(`Domain:     ${domain}`);
  log.info(`Old status: ${oldStatus}`);
  log.info(`New status: ${STATUSES.PRE_ONBOARDING}`);

  onboarding.setStatus(STATUSES.PRE_ONBOARDING);
  await onboarding.save();

  log.info('Done.');
}

main().catch((error) => {
  console.error('Fatal error:', error); // eslint-disable-line no-console
  process.exit(1);
});
