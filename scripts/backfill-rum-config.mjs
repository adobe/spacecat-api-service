#!/usr/bin/env node
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

/* eslint-disable no-console */

/**
 * One-time backfill script: seeds rumConfig.hasDomainKey for existing sites
 * that were created before the rum-config-service write path was added.
 *
 * Usage:
 *   POSTGREST_URL=<stage-url> RUM_ADMIN_KEY=<key> node scripts/backfill-rum-config.mjs [options]
 *
 * Options:
 *   --site-ids id1,id2,id3   Only process these specific site IDs (comma-separated)
 *   --dry-run                Print what would be updated without writing anything
 *
 * Examples:
 *   # Dry-run all sites
 *   POSTGREST_URL=... RUM_ADMIN_KEY=... node scripts/backfill-rum-config.mjs --dry-run
 *
 *   # Update 3 specific sites on stage
 *   POSTGREST_URL=... RUM_ADMIN_KEY=... node scripts/backfill-rum-config.mjs \
 *     --site-ids abc-123,def-456,ghi-789
 *
 *   # Full backfill (all sites without rumConfig)
 *   POSTGREST_URL=... RUM_ADMIN_KEY=... node scripts/backfill-rum-config.mjs
 *
 * Get POSTGREST_URL and RUM_ADMIN_KEY from the stage Lambda environment:
 *   aws lambda get-function-configuration --function-name spacecat-api-service-stage \
 *     --query 'Environment.Variables.{POSTGREST_URL:POSTGREST_URL,RUM_ADMIN_KEY:RUM_ADMIN_KEY}'
 */

import { createDataAccess } from '@adobe/spacecat-shared-data-access';
import { parseArgs } from 'node:util';
import { env, exit } from 'node:process';
import { updateRumConfig } from '../src/support/rum-config-service.js';

const RATE_LIMIT_MS = 500; // 500 ms between sites — avoid hammering the RUM API

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    'site-ids': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
});

const dryRun = values['dry-run'];
const targetSiteIds = values['site-ids']
  ? values['site-ids'].split(',').map((s) => s.trim()).filter(Boolean)
  : null;

// ---------------------------------------------------------------------------
// Validate env
// ---------------------------------------------------------------------------
if (!env.POSTGREST_URL) {
  console.error('ERROR: POSTGREST_URL is required');
  exit(1);
}
if (!env.RUM_ADMIN_KEY) {
  console.error('ERROR: RUM_ADMIN_KEY is required');
  exit(1);
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
const log = console;
const dataAccess = createDataAccess({ POSTGREST_URL: env.POSTGREST_URL }, log);
const context = { env: { RUM_ADMIN_KEY: env.RUM_ADMIN_KEY }, log };
const { Site } = dataAccess;

// ---------------------------------------------------------------------------
// Fetch sites
// ---------------------------------------------------------------------------
let sites;
if (targetSiteIds?.length) {
  log.info(`Fetching ${targetSiteIds.length} specific site(s)...`);
  const results = await Promise.all(targetSiteIds.map((id) => Site.findById(id)));
  sites = results.filter(Boolean);
  const missing = targetSiteIds.length - sites.length;
  if (missing > 0) {
    log.warn(`${missing} site ID(s) not found`);
  }
} else {
  log.info('Fetching all sites...');
  sites = await Site.all({}, { fetchAllPages: true });
}

// ---------------------------------------------------------------------------
// Filter — only sites that have no rumConfig yet
// ---------------------------------------------------------------------------
const toProcess = sites.filter((site) => !site.getConfig().getRumConfig());

log.info(`\nSites total:          ${sites.length}`);
log.info(`Already have rumConfig: ${sites.length - toProcess.length}`);
log.info(`Need backfill:          ${toProcess.length}`);

if (toProcess.length === 0) {
  log.info('\nNothing to do.');
  exit(0);
}

if (dryRun) {
  log.info('\n[DRY RUN] Would process:');
  toProcess.forEach((site) => log.info(`  ${site.getId()}  ${site.getBaseURL()}`));
  exit(0);
}

// ---------------------------------------------------------------------------
// Process
// ---------------------------------------------------------------------------
log.info('\nStarting backfill...\n');

let updated = 0;
let failed = 0;

for (const site of toProcess) {
  const domain = site.getBaseURL();
  try {
    // eslint-disable-next-line no-await-in-loop
    const hasDomainKey = await updateRumConfig(site, context);
    log.info(`✓  ${domain}  →  hasDomainKey: ${hasDomainKey}`);
    updated += 1;
  } catch (e) {
    log.error(`✗  ${domain}  →  ${e.message}`);
    failed += 1;
  }

  // Rate-limit to avoid hammering the RUM API
  // eslint-disable-next-line no-await-in-loop
  await new Promise((resolve) => {
    setTimeout(resolve, RATE_LIMIT_MS);
  });
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
log.info('\n-----------------------------');
log.info(`Updated:  ${updated}`);
log.info(`Failed:   ${failed}`);
log.info(`Skipped:  ${sites.length - toProcess.length} (already had rumConfig)`);
log.info('-----------------------------');

exit(failed > 0 ? 1 : 0);
