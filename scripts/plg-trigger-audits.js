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
 * PLG Trigger Audits Script
 *
 * Triggers immediate audit runs for domains that are already preonboarded.
 * Useful when audit triggers failed during preonboarding (e.g. expired AWS credentials).
 *
 * Usage:
 *   node scripts/plg-trigger-audits.js <input.json>
 *
 * Input JSON format (same as plg-preonboard.js):
 *   [
 *     { "domain": "example.com", "imsOrgId": "ABC123@AdobeOrg" }
 *   ]
 *
 * Required environment variables:
 *   POSTGREST_URL        - PostgREST base URL
 *   POSTGREST_API_KEY    - PostgREST writer JWT
 *   AWS_REGION           - AWS region
 *   AUDIT_JOBS_QUEUE_URL - SQS audit queue URL
 */

// eslint-disable-next-line import/no-extraneous-dependencies
import 'dotenv/config';
import { readFileSync } from 'fs';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { createDataAccess } from '@adobe/spacecat-shared-data-access';
import { composeBaseURL } from '@adobe/spacecat-shared-utils';

const AUDIT_TYPES = ['alt-text', 'cwv', 'broken-backlinks', 'scrape-top-pages'];

const log = {
  info: (...args) => console.log('[INFO]', ...args), // eslint-disable-line no-console
  warn: (...args) => console.warn('[WARN]', ...args), // eslint-disable-line no-console
  error: (...args) => console.error('[ERROR]', ...args), // eslint-disable-line no-console
};

function validateEnv() {
  const required = ['POSTGREST_URL', 'POSTGREST_API_KEY', 'AWS_REGION', 'AUDIT_JOBS_QUEUE_URL'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  }
}

async function main() {
  const inputFile = process.argv[2];
  if (!inputFile) {
    console.error('Usage: node scripts/plg-trigger-audits.js <input.json>'); // eslint-disable-line no-console
    process.exit(1);
  }

  validateEnv();

  const domains = JSON.parse(readFileSync(inputFile, 'utf-8'));
  if (!Array.isArray(domains) || domains.length === 0) {
    console.error('Input must be a non-empty JSON array'); // eslint-disable-line no-console
    process.exit(1);
  }

  const dataAccess = await createDataAccess(
    {
      postgrestUrl: process.env.POSTGREST_URL,
      postgrestApiKey: process.env.POSTGREST_API_KEY,
      region: process.env.AWS_REGION,
    },
    log,
  );

  const sqsClient = new SQSClient({ region: process.env.AWS_REGION });
  const queueUrl = process.env.AUDIT_JOBS_QUEUE_URL;
  const { Site } = dataAccess;

  log.info(`Triggering audits for ${domains.length} domain(s)...`);

  for (const { domain } of domains) {
    if (!domain) continue; // eslint-disable-line no-continue
    const baseURL = composeBaseURL(domain);
    // eslint-disable-next-line no-await-in-loop
    const site = await Site.findByBaseURL(baseURL);
    if (!site) {
      log.warn(`  ${domain}: site not found, skipping`);
      continue; // eslint-disable-line no-continue
    }

    log.info(`\n  ${domain} (${site.getId()})`);
    // eslint-disable-next-line no-await-in-loop
    await Promise.allSettled(
      AUDIT_TYPES.map(async (auditType) => {
        try {
          await sqsClient.send(new SendMessageCommand({
            QueueUrl: queueUrl,
            MessageBody: JSON.stringify({ type: auditType, siteId: site.getId() }),
          }));
          log.info(`    Triggered ${auditType}`);
        } catch (error) {
          log.warn(`    Failed to trigger ${auditType}: ${error.message}`);
        }
      }),
    );
  }

  log.info('\nDone.');
}

main().catch((error) => {
  console.error('Fatal error:', error); // eslint-disable-line no-console
  process.exit(1);
});
