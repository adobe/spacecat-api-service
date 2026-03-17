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
 * PLG Backfill Delivery Config Script
 *
 * For already-preonboarded sites where the RUM author URL lookup failed,
 * re-runs the RUM lookup using the canonical hostname (overrideBaseURL)
 * and backfills deliveryConfig (authorURL, programId, environmentId).
 *
 * Usage:
 *   node scripts/plg-backfill-delivery-config.js <input.json>
 *
 * Input JSON format (same as plg-preonboard.js):
 *   [
 *     { "domain": "example.com", "imsOrgId": "ABC123@AdobeOrg" },
 *   ]
 *
 * Required environment variables:
 *   POSTGREST_URL       - PostgREST base URL
 *   POSTGREST_API_KEY   - PostgREST writer JWT
 *   AWS_REGION          - AWS region
 *   RUM_ADMIN_KEY       - RUM admin key
 */

// eslint-disable-next-line import/no-extraneous-dependencies
import 'dotenv/config';
import { readFileSync } from 'fs';
import { createDataAccess } from '@adobe/spacecat-shared-data-access';
import RUMAPIClient, { RUM_BUNDLER_API_HOST } from '@adobe/spacecat-shared-rum-api-client';
import { composeBaseURL, tracingFetch as fetch } from '@adobe/spacecat-shared-utils';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const AEM_CS_PUBLISH_HOST_PATTERN = /^publish-p(\d+)-e(\d+)\.adobeaemcloud\.(com|net)$/i;

const log = {
  info: (...args) => console.log('[INFO]', ...args),
  warn: (...args) => console.warn('[WARN]', ...args),
  error: (...args) => console.error('[ERROR]', ...args),
  debug: () => {},
};

function validateEnv() {
  const required = ['POSTGREST_URL', 'POSTGREST_API_KEY', 'AWS_REGION', 'RUM_ADMIN_KEY'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  }
}

async function createContext() {
  const dataAccess = await createDataAccess(
    {
      postgrestUrl: process.env.POSTGREST_URL,
      postgrestApiKey: process.env.POSTGREST_API_KEY,
      s3Bucket: process.env.S3_CONFIG_BUCKET,
      region: process.env.AWS_REGION,
    },
    log,
  );
  return {
    dataAccess,
    log,
    env: { RUM_ADMIN_KEY: process.env.RUM_ADMIN_KEY },
  };
}

async function resolveAuthorUrl(effectiveDomain, context) {
  const rumApiClient = RUMAPIClient.createFrom(context);
  const domainkey = await rumApiClient.retrieveDomainkey(effectiveDomain);

  const yesterday = new Date(Date.now() - ONE_DAY_MS);
  const year = yesterday.getUTCFullYear();
  const month = (yesterday.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = yesterday.getUTCDate().toString().padStart(2, '0');
  const bundlesUrl = `${RUM_BUNDLER_API_HOST}/bundles/${effectiveDomain}/${year}/${month}/${day}?domainkey=${domainkey}`;

  const response = await fetch(bundlesUrl);
  if (!response.ok) {
    throw new Error(`RUM bundles fetch failed with status ${response.status}`);
  }

  const data = await response.json();
  const rumBundles = data?.rumBundles || [];
  if (rumBundles.length === 0) {
    throw new Error(`No RUM bundles found for ${effectiveDomain}`);
  }

  const { host } = rumBundles[0];
  const match = host?.match(AEM_CS_PUBLISH_HOST_PATTERN);
  if (!match) {
    throw new Error(`RUM host '${host}' is not an AEM CS publish host — no authorURL to set`);
  }

  const [, programId, environmentId] = match;
  const authorURL = `https://author-p${programId}-e${environmentId}.adobeaemcloud.com`;
  return {
    authorURL, programId, environmentId, host,
  };
}

async function backfillDeliveryConfig({ domain, imsOrgId }, context) {
  const { dataAccess: da } = context;
  const { Site } = da;

  const baseURL = composeBaseURL(domain);
  log.info(`\nProcessing: ${domain} (${imsOrgId}), baseURL: ${baseURL}`);

  const site = await Site.findByBaseURL(baseURL);
  if (!site) {
    log.warn(`  Site not found for ${baseURL}, skipping`);
    return { domain, status: 'skipped', reason: 'site not found' };
  }

  const existing = site.getDeliveryConfig() || {};
  if (existing.authorURL) {
    log.info(`  authorURL already set (${existing.authorURL}), skipping`);
    return {
      domain, status: 'skipped', reason: 'already set', authorURL: existing.authorURL,
    };
  }

  // Derive effective domain from overrideBaseURL (canonical hostname) if available
  const overrideBaseURL = site.getConfig()?.getFetchConfig()?.overrideBaseURL;
  const effectiveDomain = overrideBaseURL ? new URL(overrideBaseURL).hostname : domain;
  const fromOverride = effectiveDomain !== domain ? ' (from overrideBaseURL)' : '';
  log.info(`  Using effective domain: ${effectiveDomain}${fromOverride}`);

  try {
    const resolved = await resolveAuthorUrl(effectiveDomain, context);
    log.info(`  Resolved authorURL: ${resolved.authorURL} (host: ${resolved.host})`);

    site.setDeliveryConfig({
      ...existing,
      authorURL: resolved.authorURL,
      programId: resolved.programId,
      environmentId: resolved.environmentId,
      preferContentApi: true,
      imsOrgId,
    });
    await site.save();
    log.info(`  Saved deliveryConfig for site ${site.getId()}`);
    return {
      domain,
      status: 'updated',
      siteId: site.getId(),
      effectiveDomain,
      authorURL: resolved.authorURL,
      programId: resolved.programId,
      environmentId: resolved.environmentId,
    };
  } catch (error) {
    log.warn(`  Failed to resolve authorURL: ${error.message}`);
    return { domain, status: 'failed', reason: error.message };
  }
}

async function main() {
  const inputFile = process.argv[2];
  if (!inputFile) {
    console.error('Usage: node scripts/plg-backfill-delivery-config.js <input.json>');
    process.exit(1);
  }

  validateEnv();

  const domains = JSON.parse(readFileSync(inputFile, 'utf-8'));
  if (!Array.isArray(domains) || domains.length === 0) {
    console.error('Input must be a non-empty JSON array');
    process.exit(1);
  }

  log.info(`Backfilling delivery config for ${domains.length} domain(s)...`);

  const context = await createContext();
  const results = [];

  await Promise.allSettled(
    domains.map(async ({ domain, imsOrgId }) => {
      if (!domain || !imsOrgId) {
        log.error(`Skipping invalid entry: ${JSON.stringify({ domain, imsOrgId })}`);
        return;
      }
      const result = await backfillDeliveryConfig({ domain, imsOrgId }, context);
      if (result) results.push(result);
    }),
  );

  log.info('\nSummary:');
  results.forEach((r) => log.info(`  ${r.domain}: ${r.status}${r.authorURL ? ` → ${r.authorURL}` : ''}${r.reason ? ` (${r.reason})` : ''}`));
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
