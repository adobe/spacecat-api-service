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
 * PLG Pageviews Script
 *
 * Fetches RUM pageview counts for a list of domains.
 *
 * Usage:
 *   node scripts/plg-pageviews.js <input.json> [interval]
 *
 * Input JSON format (same as plg-preonboard.js):
 *   [
 *     { "domain": "example.com", "imsOrgId": "ABC123@AdobeOrg" },
 *     { "domain": "another.com", "imsOrgId": "DEF456@AdobeOrg" }
 *   ]
 *
 * Arguments:
 *   input.json  - Path to JSON file with domain entries
 *   interval    - (optional) Number of days to look back, default 7
 *
 * Required environment variables:
 *   RUM_ADMIN_KEY - RUM admin key for domain key exchange
 *
 * Output:
 *   Prints a table of domains and their pageview counts.
 *   Also writes a CSV report to <input>-pageviews.csv.
 */

// eslint-disable-next-line import/no-extraneous-dependencies
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'fs';
import RUMAPIClient from '@adobe/spacecat-shared-rum-api-client';

const log = {
  info: (...args) => console.log('[INFO]', ...args), // eslint-disable-line no-console
  warn: (...args) => console.warn('[WARN]', ...args), // eslint-disable-line no-console
  error: (...args) => console.error('[ERROR]', ...args), // eslint-disable-line no-console
  debug: () => {},
};

function validateEnv() {
  if (!process.env.RUM_ADMIN_KEY) {
    throw new Error('Missing environment variable: RUM_ADMIN_KEY');
  }
}

async function main() {
  const inputFile = process.argv[2];
  const interval = parseInt(process.argv[3], 10) || 7;

  if (!inputFile) {
    console.error('Usage: node scripts/plg-pageviews.js <input.json> [interval]'); // eslint-disable-line no-console
    process.exit(1);
  }

  validateEnv();

  const domains = JSON.parse(readFileSync(inputFile, 'utf-8'));
  if (!Array.isArray(domains) || domains.length === 0) {
    console.error('Input must be a non-empty JSON array'); // eslint-disable-line no-console
    process.exit(1);
  }

  const context = {
    log,
    env: { RUM_ADMIN_KEY: process.env.RUM_ADMIN_KEY },
  };

  const rumClient = RUMAPIClient.createFrom(context);

  log.info(`Fetching pageviews for ${domains.length} domain(s) over the last ${interval} day(s)...\n`);

  const results = [];

  for (const { domain, imsOrgId } of domains) {
    if (!domain) {
      log.warn(`Skipping entry with missing domain: ${JSON.stringify({ domain, imsOrgId })}`);
      // eslint-disable-next-line no-continue
      continue;
    }

    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await rumClient.query('pageviews', {
        domain,
        interval,
      });

      const pageviews = result?.pageviews ?? 0;
      log.info(`  ${domain}: ${pageviews.toLocaleString()} pageviews`);
      results.push({ domain, imsOrgId: imsOrgId || '', pageviews });
    } catch (error) {
      log.warn(`  ${domain}: error - ${error.message}`);
      results.push({ domain, imsOrgId: imsOrgId || '', pageviews: 'error' });
    }
  }

  // Write CSV report
  const csvLines = [
    'domain,imsOrgId,pageviews',
    ...results.map((r) => `"${r.domain}","${r.imsOrgId}","${r.pageviews}"`),
  ];
  const csvFile = inputFile.replace(/\.json$/, '-pageviews.csv');
  writeFileSync(csvFile, csvLines.join('\n'), 'utf-8');

  log.info(`\nCSV report written to ${csvFile}`);
  log.info('Done.');
}

main().catch((error) => {
  console.error('Fatal error:', error); // eslint-disable-line no-console
  process.exit(1);
});
