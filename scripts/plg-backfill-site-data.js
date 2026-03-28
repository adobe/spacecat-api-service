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
 * PLG Backfill Site Data Script
 *
 * Checks preonboarded/onboarded sites for missing data and fills in gaps
 * WITHOUT overwriting any existing values. Only populates fields that are
 * null/undefined/empty.
 *
 * Fields checked and backfilled:
 *   - overrideBaseURL (canonical URL resolution)
 *   - deliveryConfig (authorURL, programId, environmentId via RUM)
 *   - code (owner, repo, ref from EDS RUM host)
 *   - hlxConfig (EDS site config from RUM host)
 *   - language / region (locale detection)
 *   - projectId (project assignment)
 *
 * Usage:
 *   node scripts/plg-backfill-site-data.js <input.json>
 *
 * Input JSON format:
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
import { Config } from '@adobe/spacecat-shared-data-access/src/models/site/config.js';
import RUMAPIClient, { RUM_BUNDLER_API_HOST } from '@adobe/spacecat-shared-rum-api-client';
import {
  composeBaseURL,
  detectLocale,
  resolveCanonicalUrl,
  tracingFetch as fetch,
} from '@adobe/spacecat-shared-utils';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const AEM_CS_PUBLISH_HOST_PATTERN = /^publish-p(\d+)-e(\d+)\.adobeaemcloud\.(com|net)$/i;
const EDS_HOST_PATTERN = /^([\w-]+)--([\w-]+)--([\w-]+)\.(aem\.live|hlx\.live)$/i;

const log = {
  info: (...args) => console.log('[INFO]', ...args),
  warn: (...args) => console.warn('[WARN]', ...args),
  error: (...args) => console.error('[ERROR]', ...args),
  debug: () => {},
};

/** Derive a project name from a baseURL (inlined from src/support/utils.js). */
function deriveProjectName(baseURL) {
  const { hostname } = new URL(baseURL);
  const parts = hostname.split('.');
  if (parts.length <= 2) return hostname;
  for (let i = 0; i < Math.min(parts.length, 2); i += 1) {
    if (parts[i].length === 2 || parts[i].length === 3) {
      parts[i] = null;
    }
  }
  return parts.filter(Boolean).join('.');
}

/**
 * Auto-resolve author URL from RUM bundles.
 * Returns { authorURL, programId, environmentId, host } or null.
 */
async function autoResolveAuthorUrl(domain, context) {
  try {
    const rumApiClient = RUMAPIClient.createFrom(context);
    const domainkey = await rumApiClient.retrieveDomainkey(domain);

    let host = null;
    for (let daysBack = 1; daysBack <= 7; daysBack += 1) {
      const date = new Date(Date.now() - daysBack * ONE_DAY_MS);
      const year = date.getUTCFullYear();
      const month = (date.getUTCMonth() + 1).toString().padStart(2, '0');
      const day = date.getUTCDate().toString().padStart(2, '0');
      const bundlesUrl = `${RUM_BUNDLER_API_HOST}/bundles/${domain}/${year}/${month}/${day}?domainkey=${domainkey}`;

      // eslint-disable-next-line no-await-in-loop
      const response = await fetch(bundlesUrl);
      if (!response.ok) {
        // eslint-disable-next-line no-continue
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      const data = await response.json();
      const rumBundles = data?.rumBundles || [];
      if (rumBundles.length > 0) {
        [{ host }] = rumBundles;
        break;
      }
    }

    if (!host) return null;

    const match = host?.match(AEM_CS_PUBLISH_HOST_PATTERN);
    if (!match) return { host };

    const [, programId, environmentId] = match;
    const authorURL = `https://author-p${programId}-e${environmentId}.adobeaemcloud.com`;
    return {
      authorURL, programId, environmentId, host,
    };
  } catch (error) {
    log.warn(`  Auto-resolve author URL failed for ${domain}: ${error.message}`);
    return null;
  }
}

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

async function createOrFindProject(baseURL, organizationId, context) {
  const { dataAccess: da } = context;
  const { Project } = da;
  const projectName = deriveProjectName(baseURL);

  const existing = (await Project.allByOrganizationId(organizationId))
    .find((p) => p.getProjectName() === projectName);

  if (existing) return existing;

  const project = await Project.create({ projectName, organizationId });
  log.info(`  Created project ${project.getId()}`);
  return project;
}

async function backfillSiteData({ domain, imsOrgId }, context) {
  const { dataAccess: da } = context;
  const { Site } = da;

  const baseURL = composeBaseURL(domain);
  log.info(`\nChecking: ${domain} (${imsOrgId}), baseURL: ${baseURL}`);

  const site = await Site.findByBaseURL(baseURL);
  if (!site) {
    log.warn(`  Site not found for ${baseURL}, skipping`);
    return {
      domain, imsOrgId, siteId: '', status: 'skipped', filled: '', originalSite: '',
    };
  }

  // Snapshot original site state before any modifications (for rollback)
  const originalSite = JSON.stringify({
    siteId: site.getId(),
    organizationId: site.getOrganizationId(),
    deliveryType: site.getDeliveryType(),
    deliveryConfig: site.getDeliveryConfig(),
    code: site.getCode(),
    hlxConfig: site.getHlxConfig(),
    language: site.getLanguage(),
    region: site.getRegion(),
    projectId: site.getProjectId(),
    fetchConfig: site.getConfig()?.getFetchConfig(),
  });

  const filled = [];
  let dirty = false;
  const siteConfig = site.getConfig();

  // 1. overrideBaseURL — canonical URL resolution
  const currentFetchConfig = siteConfig.getFetchConfig() || {};
  let { overrideBaseURL } = currentFetchConfig;
  if (!overrideBaseURL) {
    try {
      const resolvedUrl = await resolveCanonicalUrl(baseURL);
      if (resolvedUrl) {
        const { pathname: basePath, origin: baseOrigin } = new URL(baseURL);
        const { pathname: resolvedPath, origin: resolvedOrigin } = new URL(resolvedUrl);
        if (basePath !== resolvedPath || baseOrigin !== resolvedOrigin) {
          overrideBaseURL = basePath !== '/' ? `${resolvedOrigin}${basePath}` : resolvedOrigin;
          siteConfig.updateFetchConfig({ ...currentFetchConfig, overrideBaseURL });
          filled.push(`overrideBaseURL=${overrideBaseURL}`);
          dirty = true;
          log.info(`  Filled overrideBaseURL: ${overrideBaseURL}`);
        }
      }
    } catch (error) {
      log.warn(`  Failed to resolve canonical URL: ${error.message}`);
    }
  }

  // Use canonical hostname for RUM lookup
  const effectiveDomain = overrideBaseURL ? new URL(overrideBaseURL).hostname : domain;

  // 2. deliveryConfig — authorURL, programId, environmentId via RUM
  const existingDeliveryConfig = site.getDeliveryConfig() || {};
  let rumHost = null;
  if (!existingDeliveryConfig.authorURL) {
    const resolved = await autoResolveAuthorUrl(effectiveDomain, context);
    rumHost = resolved?.host || null;
    if (resolved?.authorURL) {
      site.setDeliveryConfig({
        ...existingDeliveryConfig,
        authorURL: resolved.authorURL,
        programId: resolved.programId,
        environmentId: resolved.environmentId,
        preferContentApi: true,
        imsOrgId,
      });
      filled.push(`authorURL=${resolved.authorURL}`);
      dirty = true;
      log.info(`  Filled deliveryConfig: authorURL=${resolved.authorURL}`);
    }
  } else {
    // Still try to get rumHost for code/hlx config even if deliveryConfig exists
    try {
      const resolved = await autoResolveAuthorUrl(effectiveDomain, context);
      rumHost = resolved?.host || null;
    } catch {
      // ignore — we only need rumHost for downstream checks
    }
  }

  // 3. code — owner, repo, ref from EDS RUM host
  const existingCode = site.getCode() || {};
  if (!existingCode.owner && rumHost) {
    const edsCodeMatch = rumHost.match(EDS_HOST_PATTERN);
    if (edsCodeMatch) {
      const [, ref, repo, owner] = edsCodeMatch;
      site.setCode({
        type: 'github',
        owner,
        repo,
        ref,
        url: `https://github.com/${owner}/${repo}`,
      });
      filled.push(`code=${owner}/${repo}@${ref}`);
      dirty = true;
      log.info(`  Filled code config: ${owner}/${repo}@${ref}`);
    }
  }

  // 4. hlxConfig — EDS site config from RUM host
  if (!site.getHlxConfig() && rumHost) {
    const edsMatch = rumHost.match(EDS_HOST_PATTERN);
    if (edsMatch) {
      const [, ref, repo, owner, tld] = edsMatch;
      site.setHlxConfig({
        hlxVersion: 5,
        rso: {
          ref, site: repo, owner, tld,
        },
      });
      filled.push(`hlxConfig=${ref}--${repo}--${owner}.${tld}`);
      dirty = true;
      log.info(`  Filled hlxConfig: ${ref}--${repo}--${owner}.${tld}`);
    }
  }

  // 5. language / region — locale detection
  if (!site.getLanguage() || !site.getRegion()) {
    try {
      const locale = await detectLocale({ baseUrl: baseURL });
      if (!site.getLanguage() && locale.language) {
        site.setLanguage(locale.language);
        filled.push(`language=${locale.language}`);
        dirty = true;
      }
      if (!site.getRegion() && locale.region) {
        site.setRegion(locale.region);
        filled.push(`region=${locale.region}`);
        dirty = true;
      }
    } catch (error) {
      log.warn(`  Locale detection failed: ${error.message}`);
    }
  }

  // 6. projectId — project assignment
  if (!site.getProjectId()) {
    const organizationId = site.getOrganizationId();
    const project = await createOrFindProject(baseURL, organizationId, context);
    site.setProjectId(project.getId());
    filled.push(`projectId=${project.getId()}`);
    dirty = true;
    log.info(`  Filled projectId: ${project.getId()}`);
  }

  // Save if anything changed
  if (dirty) {
    site.setConfig(Config.toDynamoItem(siteConfig));
    await site.save();
    log.info(`  Saved site ${site.getId()} with ${filled.length} field(s) filled`);
    return {
      domain,
      imsOrgId,
      siteId: site.getId(),
      status: 'updated',
      filled: filled.join('; '),
      originalSite,
    };
  }

  log.info(`  No missing data for site ${site.getId()}`);
  return {
    domain,
    imsOrgId,
    siteId: site.getId(),
    status: 'complete',
    filled: '',
    originalSite,
  };
}

async function main() {
  const inputFile = process.argv[2];
  if (!inputFile) {
    console.error('Usage: node scripts/plg-backfill-site-data.js <input.json>');
    process.exit(1);
  }

  validateEnv();

  const domains = JSON.parse(readFileSync(inputFile, 'utf-8'));
  if (!Array.isArray(domains) || domains.length === 0) {
    console.error('Input must be a non-empty JSON array');
    process.exit(1);
  }

  log.info(`Backfilling site data for ${domains.length} domain(s)...`);

  const context = await createContext();
  const results = [];

  await Promise.allSettled(
    domains.map(async ({ domain, imsOrgId }) => {
      if (!domain || !imsOrgId) {
        log.error(`Skipping invalid entry: ${JSON.stringify({ domain, imsOrgId })}`);
        return;
      }
      try {
        const result = await backfillSiteData({ domain, imsOrgId }, context);
        results.push(result);
      } catch (error) {
        log.error(`Unexpected error for ${domain}: ${error.message}`);
        results.push({
          domain, imsOrgId, siteId: '', status: 'failed', filled: error.message, originalSite: '',
        });
      }
    }),
  );

  // Write CSV report (includes original site snapshot for rollback)
  if (results.length > 0) {
    const headers = Object.keys(results[0]);
    const csvLines = [
      headers.join(','),
      ...results.map((r) => headers.map((h) => `"${String(r[h] || '').replace(/"/g, '""')}"`).join(',')),
    ];
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const csvFile = inputFile.replace(/\.json$/, `-backfill-report-${timestamp}.csv`);
    const { writeFileSync } = await import('fs');
    writeFileSync(csvFile, csvLines.join('\n'), 'utf-8');
    log.info(`\nCSV report written to ${csvFile}`);
  }

  // Summary
  log.info('\n--- Summary ---');
  const updated = results.filter((r) => r.status === 'updated');
  const complete = results.filter((r) => r.status === 'complete');
  const skipped = results.filter((r) => r.status === 'skipped');
  const failedResults = results.filter((r) => r.status === 'failed');

  log.info(`Updated: ${updated.length}, Already complete: ${complete.length}, Skipped: ${skipped.length}, Failed: ${failedResults.length}`);
  updated.forEach((r) => log.info(`  ${r.domain}: filled [${r.filled}]`));
  failedResults.forEach((r) => log.info(`  ${r.domain}: failed (${r.filled})`));
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
