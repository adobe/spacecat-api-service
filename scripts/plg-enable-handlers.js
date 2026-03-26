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
 * PLG Enable Handlers Script
 *
 * Enables all ASO PLG audit handlers for a list of domains via SpaceCat API.
 * Use this when handler enablement failed during preonboarding (e.g. env mismatch).
 *
 * Usage:
 *   node scripts/plg-enable-handlers.js <input.json>
 *
 * Input JSON format:
 *   [
 *     { "domain": "example.com" },
 *     { "domain": "another.com" }
 *   ]
 *
 * Required environment variables:
 *   SPACECAT_API_BASE_URL - SpaceCat API base URL
 *   ADMIN_API_KEY         - Admin API key
 */

// eslint-disable-next-line import/no-extraneous-dependencies
import 'dotenv/config';
import { readFileSync } from 'fs';
import { composeBaseURL, tracingFetch as fetch } from '@adobe/spacecat-shared-utils';

const HANDLERS = [
  'alt-text',
  'cwv',
  'scrape-top-pages',
  'broken-backlinks',
  'broken-backlinks-auto-suggest',
  'broken-backlinks-auto-fix',
  'alt-text-auto-fix',
  'alt-text-auto-suggest-mystique',
  'cwv-auto-fix',
  'cwv-auto-suggest',
  'summit-plg',
];

const log = {
  info: (...args) => console.log('[INFO]', ...args), // eslint-disable-line no-console
  warn: (...args) => console.warn('[WARN]', ...args), // eslint-disable-line no-console
  error: (...args) => console.error('[ERROR]', ...args), // eslint-disable-line no-console
};

function validateEnv() {
  const required = ['SPACECAT_API_BASE_URL', 'ADMIN_API_KEY'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  }
}

async function enableHandlersForDomain(domain) {
  const baseURL = composeBaseURL(domain);
  const apiUrl = process.env.SPACECAT_API_BASE_URL;
  const apiKey = process.env.ADMIN_API_KEY;

  const payload = HANDLERS.map((auditType) => ({ baseURL, auditType, enable: true }));

  try {
    const resp = await fetch(`${apiUrl}/configurations/sites/audits`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify(payload),
    });

    const results = await resp.json();
    const failed = results.filter((r) => r.status !== 200);
    const succeeded = results.filter((r) => r.status === 200);

    log.info(`  ${domain}: ${succeeded.length}/${HANDLERS.length} handlers enabled`);
    if (failed.length > 0) {
      failed.forEach((r) => log.warn(`    FAILED: ${r.message}`));
    }
  } catch (error) {
    log.error(`  ${domain}: ${error.message}`);
  }
}

async function main() {
  const inputFile = process.argv[2];
  if (!inputFile) {
    console.error('Usage: node scripts/plg-enable-handlers.js <input.json>'); // eslint-disable-line no-console
    process.exit(1);
  }

  validateEnv();

  const domains = JSON.parse(readFileSync(inputFile, 'utf-8'));
  if (!Array.isArray(domains) || domains.length === 0) {
    console.error('Input must be a non-empty JSON array'); // eslint-disable-line no-console
    process.exit(1);
  }

  log.info(`Enabling handlers for ${domains.length} domain(s)...`);

  for (const { domain } of domains) {
    if (!domain) continue; // eslint-disable-line no-continue
    log.info(`\n${domain}`);
    // eslint-disable-next-line no-await-in-loop
    await enableHandlersForDomain(domain);
  }

  log.info('\nDone.');
}

main().catch((error) => {
  console.error('Fatal error:', error); // eslint-disable-line no-console
  process.exit(1);
});
