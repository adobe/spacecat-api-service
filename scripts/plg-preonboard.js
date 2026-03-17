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
 * PLG Preonboarding Script (self-contained)
 *
 * One-time script to preonboard domains for PLG ASO customers.
 * Creates org, site, enables audits/imports, triggers audit runs,
 * and creates org-level ASO entitlement (no site enrollment).
 * Sets PlgOnboarding status to PRE_ONBOARDING.
 *
 * When the customer later calls POST /plg/onboard, the existing resume
 * logic picks up from PRE_ONBOARDING, adds entitlement, and sets ONBOARDED.
 *
 * Usage:
 *   node scripts/plg-preonboard.js <input.json>
 *
 * Input JSON format:
 *   [
 *     { "domain": "example.com", "imsOrgId": "ABC123@AdobeOrg" },
 *     { "domain": "another.com", "imsOrgId": "DEF456@AdobeOrg" }
 *   ]
 *
 * Required environment variables:
 *   POSTGREST_URL       - PostgREST base URL
 *   POSTGREST_API_KEY   - PostgREST writer JWT
 *   AUDIT_JOBS_QUEUE_URL - SQS audit queue URL
 *   AWS_REGION          - AWS region
 *   DEFAULT_ORGANIZATION_ID - Default org ID (for internal org check)
 *   RUM_ADMIN_KEY           - (optional) RUM admin key for auto-resolving author URL
 *   SPACECAT_API_BASE_URL        - SpaceCat API base URL (e.g. https://xxx.cloudfront.net)
 *   ADMIN_API_KEY        - Admin API key for SpaceCat API
 */

// eslint-disable-next-line import/no-extraneous-dependencies
import 'dotenv/config';
import { readFileSync } from 'fs';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { createDataAccess } from '@adobe/spacecat-shared-data-access';
import { Config } from '@adobe/spacecat-shared-data-access/src/models/site/config.js';
import PlgOnboardingModel from '@adobe/spacecat-shared-data-access/src/models/plg-onboarding/plg-onboarding.model.js';
import RUMAPIClient, { RUM_BUNDLER_API_HOST } from '@adobe/spacecat-shared-rum-api-client';
import { Entitlement as EntitlementModel } from '@adobe/spacecat-shared-data-access/src/models/entitlement/index.js';
import TierClient from '@adobe/spacecat-shared-tier-client';
import {
  composeBaseURL,
  detectAEMVersion,
  detectBotBlocker,
  detectLocale,
  resolveCanonicalUrl,
  tracingFetch as fetch,
} from '@adobe/spacecat-shared-utils';

const { STATUSES } = PlgOnboardingModel;
const ASO_PRODUCT_CODE = EntitlementModel.PRODUCT_CODES.ASO;
const ASO_TIER = EntitlementModel.TIERS.FREE_TRIAL;

const ASO_DEMO_ORG = '66331367-70e6-4a49-8445-4f6d9c265af9';
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const AEM_CS_PUBLISH_HOST_PATTERN = /^publish-p(\d+)-e(\d+)\.adobeaemcloud\.(com|net)$/i;
const EDS_HOST_PATTERN = /^([\w-]+)--([\w-]+)--([\w-]+)\.(aem\.live|hlx\.live)$/i;

// ---------------------------------------------------------------------------
// Inlined helpers (no imports from src/ so the script runs standalone)
// ---------------------------------------------------------------------------

const log = {
  info: (...args) => console.log('[INFO]', ...args),
  warn: (...args) => console.warn('[WARN]', ...args),
  error: (...args) => console.error('[ERROR]', ...args),
  debug: () => {},
};

/** ASO PLG profile – mirrors static/onboard/profiles.json "aso_plg" entry. */
const ASO_PLG_PROFILE = {
  audits: {
    'alt-text': {},
    cwv: {},
    'broken-backlinks': {},
    'scrape-top-pages': {},
  },
  imports: {
    'organic-traffic': {},
    'top-pages': {},
    'all-traffic': {},
  },
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

/** Detect AEM delivery type for a URL (inlined from src/support/utils.js). */
async function findDeliveryType(url) {
  try {
    const resp = await fetch(url);
    return detectAEMVersion(await resp.text());
  } catch {
    return 'other';
  }
}

/** Create or find an organization by IMS Org ID (inlined from llmo-onboarding.js). */
async function createOrFindOrganization(imsOrgId, context) {
  const { dataAccess: da } = context;
  const { Organization } = da;

  let organization = await Organization.findByImsOrgId(imsOrgId);
  if (organization) {
    log.info(`  Found existing org ${organization.getId()}`);
    return organization;
  }

  organization = await Organization.create({
    name: `Organization ${imsOrgId}`,
    imsOrgId,
  });
  log.info(`  Created org ${organization.getId()}`);
  return organization;
}

/**
 * Auto-resolve author URL from RUM bundles (inlined from src/support/utils.js).
 * Returns { authorURL, programId, environmentId, host } or null.
 */
async function autoResolveAuthorUrl(domain, context) {
  try {
    const rumApiClient = RUMAPIClient.createFrom(context);
    const domainkey = await rumApiClient.retrieveDomainkey(domain);

    const yesterday = new Date(Date.now() - ONE_DAY_MS);
    const year = yesterday.getUTCFullYear();
    const month = (yesterday.getUTCMonth() + 1).toString().padStart(2, '0');
    const day = yesterday.getUTCDate().toString().padStart(2, '0');
    const bundlesUrl = `${RUM_BUNDLER_API_HOST}/bundles/${domain}/${year}/${month}/${day}?domainkey=${domainkey}`;

    const response = await fetch(bundlesUrl);
    if (!response.ok) {
      log.warn(`  Failed to fetch RUM bundles for ${domain}: status ${response.status}`);
      return null;
    }

    const data = await response.json();
    const rumBundles = data?.rumBundles || [];
    if (rumBundles.length === 0) {
      log.info(`  No RUM bundles found for ${domain}`);
      return null;
    }

    const { host } = rumBundles[0];
    const match = host?.match(AEM_CS_PUBLISH_HOST_PATTERN);
    if (!match) {
      log.info(`  RUM host '${host}' is not AEM CS publish host`);
      return { host };
    }

    const [, programId, environmentId] = match;
    const authorURL = `https://author-p${programId}-e${environmentId}.adobeaemcloud.com`;
    log.info(`  Auto-resolved author URL: ${authorURL}`);
    return {
      authorURL, programId, environmentId, host,
    };
  } catch (error) {
    log.warn(`  Auto-resolve author URL failed for ${domain}: ${error.message}`);
    return null;
  }
}

/** Enable imports on a site config (inlined from llmo-onboarding.js). */
function enableImports(siteConfig, imports) {
  const existingImports = siteConfig.getImports();

  imports.forEach(({ type }) => {
    try {
      const isEnabled = existingImports?.find(
        (imp) => imp.type === type && imp.enabled,
      );
      if (!isEnabled) {
        siteConfig.enableImport(type);
      }
    } catch (error) {
      log.warn(`  Failed to enable import '${type}': ${error.message}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Script infrastructure
// ---------------------------------------------------------------------------

function validateEnv() {
  const required = ['POSTGREST_URL', 'POSTGREST_API_KEY', 'AWS_REGION', 'SPACECAT_API_BASE_URL', 'ADMIN_API_KEY'];
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

  const sqsClient = new SQSClient({ region: process.env.AWS_REGION });
  const sqs = {
    sendMessage: async (queueUrl, message) => {
      await sqsClient.send(new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(message),
      }));
    },
  };

  return {
    dataAccess,
    log,
    sqs,
    env: {
      DEFAULT_ORGANIZATION_ID: process.env.DEFAULT_ORGANIZATION_ID || '',
      RUM_ADMIN_KEY: process.env.RUM_ADMIN_KEY || '',
    },
  };
}

async function createOrFindProject(baseURL, organizationId, context) {
  const { dataAccess: da } = context;
  const { Project } = da;
  const projectName = deriveProjectName(baseURL);

  const existing = (await Project.allByOrganizationId(organizationId))
    .find((p) => p.getProjectName() === projectName);

  if (existing) {
    log.info(`  Found existing project ${existing.getId()}`);
    return existing;
  }

  const project = await Project.create({ projectName, organizationId });
  log.info(`  Created project ${project.getId()}`);
  return project;
}

// ---------------------------------------------------------------------------
// Preonboarding logic
// ---------------------------------------------------------------------------

async function preonboardDomain({ domain, imsOrgId }, context) {
  const { dataAccess: da } = context;
  const { Site, PlgOnboarding } = da;

  const baseURL = composeBaseURL(domain);
  log.info(`\nPreonboarding: ${domain} (${imsOrgId}), baseURL: ${baseURL}`);

  const profile = ASO_PLG_PROFILE;

  // Check for existing record
  let onboarding = await PlgOnboarding.findByImsOrgIdAndDomain(imsOrgId, domain);
  if (onboarding) {
    const status = onboarding.getStatus();
    if (status === STATUSES.ONBOARDED || status === STATUSES.PRE_ONBOARDING) {
      log.info(`  Already ${status}, skipping`);
      return null;
    }
  }

  // Create PlgOnboarding record
  if (!onboarding) {
    onboarding = await PlgOnboarding.create({
      imsOrgId,
      domain,
      baseURL,
      status: STATUSES.IN_PROGRESS,
    });
    log.info(`  Created PlgOnboarding record ${onboarding.getId()}`);
  } else {
    onboarding.setStatus(STATUSES.IN_PROGRESS);
    onboarding.setError(null);
  }

  const steps = { ...(onboarding.getSteps() || {}) };

  try {
    // Step 1: Resolve organization
    const organization = await createOrFindOrganization(imsOrgId, context);
    const organizationId = organization.getId();
    onboarding.setOrganizationId(organizationId);
    steps.orgResolved = true;
    log.info(`  Org resolved: ${organizationId}`);

    // Step 2: Check site ownership
    let site = await Site.findByBaseURL(baseURL);

    // Snapshot original site state for rollback reference (captured before any modifications)
    const originalSiteSnapshot = site ? JSON.stringify({
      siteId: site.getId(),
      organizationId: site.getOrganizationId(),
      deliveryType: site.getDeliveryType(),
      deliveryConfig: site.getDeliveryConfig(),
      code: site.getCode(),
      hlxConfig: site.getHlxConfig(),
      language: site.getLanguage(),
      region: site.getRegion(),
      fetchConfig: site.getConfig()?.getFetchConfig(),
    }) : null;

    if (site) {
      const existingOrgId = site.getOrganizationId();
      if (existingOrgId !== organizationId
        && existingOrgId !== context.env.DEFAULT_ORGANIZATION_ID
        && existingOrgId !== ASO_DEMO_ORG) {
        log.warn(`  Domain ${domain} belongs to org ${existingOrgId}, waitlisting`);
        onboarding.setStatus(STATUSES.WAITLISTED);
        onboarding.setWaitlistReason(`Domain ${domain} is already assigned to another organization`);
        onboarding.setSiteId(site.getId());
        onboarding.setSteps(steps);
        await onboarding.save();
        return null;
      }

      if (existingOrgId !== organizationId) {
        site.setOrganizationId(organizationId);
        log.info(`  Reassigning site from ${existingOrgId} to ${organizationId}`);
      }
    }

    // Step 3: Bot blocker check
    const botBlockerResult = await detectBotBlocker({ baseUrl: baseURL });
    if (!botBlockerResult.crawlable) {
      if (site) await site.save();
      onboarding.setStatus(STATUSES.WAITING_FOR_IP_ALLOWLISTING);
      onboarding.setBotBlocker({
        type: botBlockerResult.type,
        ipsToAllowlist: botBlockerResult.ipsToAllowlist || botBlockerResult.ipsToWhitelist,
        userAgent: botBlockerResult.userAgent,
      });
      onboarding.setSiteId(site?.getId() || null);
      onboarding.setSteps(steps);
      await onboarding.save();
      log.warn(`  Bot blocker detected (${botBlockerResult.type}), saved as WAITING_FOR_IP_ALLOWLISTING`);
      return {
        domain,
        imsOrgId,
        siteId: site?.getId() || '',
        organizationId,
        status: STATUSES.WAITING_FOR_IP_ALLOWLISTING,
        botBlocker: botBlockerResult.type || '',
        botBlockerIPs: (botBlockerResult.ipsToAllowlist || botBlockerResult.ipsToWhitelist || []).join(';'),
        rumHost: '',
        deliveryType: site?.getDeliveryType() || '',
        authorURL: '',
        programId: '',
        environmentId: '',
        preferContentApi: false,
        codeOwner: '',
        codeRepo: '',
        hlxConfig: 'no',
        overrideBaseURL: '',
        language: '',
        region: '',
        entitlement: 'no',
        steps: Object.keys(steps).filter((k) => steps[k]).join(';'),
      };
    }

    // Step 4: Create site if new
    if (!site) {
      const deliveryType = await findDeliveryType(baseURL);
      site = await Site.create({
        baseURL,
        organizationId,
        ...(deliveryType && { deliveryType }),
      });
      log.info(`  Created site ${site.getId()}`);
      steps.siteCreated = true;
    }
    onboarding.setSiteId(site.getId());
    steps.siteResolved = true;

    // Step 4b: Resolve canonical URL early so the RUM lookup uses the correct hostname
    // (e.g. abbviepro.com redirects to www.abbviepro.com — RUM is keyed on the www host)
    const siteConfig = site.getConfig();
    const currentFetchConfig = siteConfig.getFetchConfig() || {};
    let overrideBaseURL = currentFetchConfig.overrideBaseURL || null;
    if (!overrideBaseURL) {
      try {
        const resolvedUrl = await resolveCanonicalUrl(baseURL);
        if (resolvedUrl) {
          const { pathname: basePath, origin: baseOrigin } = new URL(baseURL);
          const { pathname: resolvedPath, origin: resolvedOrigin } = new URL(resolvedUrl);
          if (basePath !== resolvedPath || baseOrigin !== resolvedOrigin) {
            overrideBaseURL = basePath !== '/' ? `${resolvedOrigin}${basePath}` : resolvedOrigin;
            siteConfig.updateFetchConfig({ ...currentFetchConfig, overrideBaseURL });
            log.info(`  Set overrideBaseURL to ${overrideBaseURL}`);
          }
        }
      } catch (error) {
        log.warn(`  Failed to resolve canonical URL: ${error.message}`);
      }
    }

    // Use the canonical hostname for RUM lookup when available
    const effectiveDomain = overrideBaseURL ? new URL(overrideBaseURL).hostname : domain;

    // Step 4c: Auto-resolve author URL and RUM host
    let rumHost = null;
    try {
      const resolvedConfig = await autoResolveAuthorUrl(effectiveDomain, context);
      rumHost = resolvedConfig?.host || null;

      const existingDeliveryConfig = site.getDeliveryConfig() || {};
      if (!existingDeliveryConfig.authorURL && resolvedConfig?.authorURL) {
        site.setDeliveryConfig({
          ...existingDeliveryConfig,
          authorURL: resolvedConfig.authorURL,
          programId: resolvedConfig.programId,
          environmentId: resolvedConfig.environmentId,
          preferContentApi: true,
          imsOrgId,
        });
        log.info(`  Set deliveryConfig: authorURL=${resolvedConfig.authorURL}`);
        steps.authorUrlResolved = true;
      }
    } catch (error) {
      log.warn(`  Failed to auto-resolve author URL: ${error.message}`);
    }

    // Step 4c: Resolve EDS code config from RUM host
    if (rumHost) {
      const existingCode = site.getCode() || {};
      if (!existingCode.owner) {
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
          log.info(`  Set code config: ${owner}/${repo}@${ref}`);
          steps.codeConfigResolved = true;
        }
      }
    }

    // Step 4d: Set hlxConfig for EDS sites
    if (rumHost && !site.getHlxConfig()) {
      const edsMatch = rumHost.match(EDS_HOST_PATTERN);
      if (edsMatch) {
        const [, ref, repo, owner, tld] = edsMatch;
        site.setHlxConfig({
          hlxVersion: 5,
          rso: {
            ref, site: repo, owner, tld,
          },
        });
        log.info(`  Set hlxConfig: ${ref}--${repo}--${owner}.${tld}`);
        steps.hlxConfigSet = true;
      }
    }

    // Step 5: Update configs
    const importDefs = Object.keys(profile.imports || {}).map((type) => ({ type }));
    enableImports(siteConfig, importDefs);

    // Detect locale
    if (!site.getLanguage() || !site.getRegion()) {
      try {
        const locale = await detectLocale({ baseUrl: baseURL });
        if (!site.getLanguage() && locale.language) site.setLanguage(locale.language);
        if (!site.getRegion() && locale.region) site.setRegion(locale.region);
      } catch (error) {
        log.warn(`  Locale detection failed: ${error.message}`);
        if (!site.getLanguage()) site.setLanguage('en');
        if (!site.getRegion()) site.setRegion('US');
      }
    }

    // Create/assign project
    const project = await createOrFindProject(baseURL, organizationId, context);
    if (!site.getProjectId()) site.setProjectId(project.getId());

    site.setConfig(Config.toDynamoItem(siteConfig));
    await site.save();
    steps.configUpdated = true;

    // Step 6: Enable audits via SpaceCat API
    // (old: direct S3 write via enableAudits — requires IAM permissions not available locally)
    // await enableAudits(site, context, auditTypes);
    const auditTypes = Object.keys(profile.audits || {});
    const apiUrl = process.env.SPACECAT_API_BASE_URL;
    const apiKey = process.env.ADMIN_API_KEY;
    try {
      const auditsPayload = auditTypes.map((auditType) => ({
        baseURL, auditType, enable: true,
      }));
      const auditsResp = await fetch(`${apiUrl}/configurations/sites/audits`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify(auditsPayload),
      });
      if (!auditsResp.ok) {
        const errBody = await auditsResp.text();
        log.warn(`  API enable audits returned ${auditsResp.status}: ${errBody}`);
      } else {
        const results = await auditsResp.json();
        log.info(`  Enabled audits via API: ${JSON.stringify(results)}`);
        steps.auditsEnabled = true;
      }
    } catch (error) {
      log.warn(`  Failed to enable audits via API: ${error.message}`);
    }

    // Step 7: Enroll in summit-plg via SpaceCat API
    // (old: direct Configuration.save — requires IAM permissions not available locally)
    // const { Configuration } = da;
    // const configuration = await Configuration.findLatest();
    // configuration.enableHandlerForSite('summit-plg', site);
    // await configuration.save();
    try {
      const summitPayload = [{ baseURL, auditType: 'summit-plg', enable: true }];
      const summitResp = await fetch(`${apiUrl}/configurations/sites/audits`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify(summitPayload),
      });
      const summitResults = await summitResp.json();
      log.info(`  summit-plg API response: ${JSON.stringify(summitResults)}`);
      if (!summitResp.ok) {
        log.warn(`  API summit-plg enrollment returned ${summitResp.status}`);
      }
    } catch (error) {
      log.warn(`  Failed to enroll in summit-plg via API: ${error.message}`);
    }

    // Step 8: Create ASO entitlement (org-level only, no site enrollment)
    try {
      const tierClient = TierClient.createForOrg(context, organization, ASO_PRODUCT_CODE);
      const { entitlement } = await tierClient.createEntitlement(ASO_TIER);
      log.info(`  Created ASO entitlement ${entitlement.getId()}`);
      steps.entitlementCreated = true;
    } catch (error) {
      if (error.message?.includes('already exists')) {
        log.info('  ASO entitlement already exists');
        steps.entitlementCreated = true;
      } else {
        log.warn(`  Failed to create entitlement: ${error.message}`);
      }
    }

    // Mark as PRE_ONBOARDING
    onboarding.setStatus(STATUSES.PRE_ONBOARDING);
    onboarding.setSteps(steps);
    await onboarding.save();

    log.info(`  Preonboarding complete: ${onboarding.getId()} -> PRE_ONBOARDING`);

    // Return result for CSV reporting
    return {
      domain,
      imsOrgId,
      siteId: site.getId(),
      organizationId,
      status: STATUSES.PRE_ONBOARDING,
      botBlocker: '',
      botBlockerIPs: '',
      rumHost: rumHost || '',
      deliveryType: site.getDeliveryType() || '',
      authorURL: site.getDeliveryConfig()?.authorURL || '',
      programId: site.getDeliveryConfig()?.programId || '',
      environmentId: site.getDeliveryConfig()?.environmentId || '',
      preferContentApi: site.getDeliveryConfig()?.preferContentApi || false,
      codeOwner: site.getCode()?.owner || '',
      codeRepo: site.getCode()?.repo || '',
      hlxConfig: Object.keys(site.getHlxConfig() || {}).length > 0 ? 'yes' : 'no',
      overrideBaseURL: site.getConfig()?.getFetchConfig()?.overrideBaseURL || '',
      language: site.getLanguage() || '',
      region: site.getRegion() || '',
      entitlement: steps.entitlementCreated ? 'yes' : 'no',
      steps: Object.keys(steps).filter((k) => steps[k]).join(';'),
      originalSite: originalSiteSnapshot || '',
    };
  } catch (error) {
    onboarding.setStatus(STATUSES.ERROR);
    onboarding.setSteps(steps);
    onboarding.setError({ message: error.message });
    try {
      await onboarding.save();
    } catch (saveError) {
      log.error(`  Failed to save error state: ${saveError.message}`);
    }
    log.error(`  Failed: ${error.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const inputFile = process.argv[2];
  if (!inputFile) {
    console.error('Usage: node scripts/plg-preonboard.js <input.json>');
    process.exit(1);
  }

  validateEnv();

  const domains = JSON.parse(readFileSync(inputFile, 'utf-8'));
  if (!Array.isArray(domains) || domains.length === 0) {
    console.error('Input must be a non-empty JSON array');
    process.exit(1);
  }

  log.info(`Preonboarding ${domains.length} domain(s)...`);

  const context = await createContext();

  let succeeded = 0;
  let failed = 0;
  const results = [];

  const entries = domains.map(({ domain, imsOrgId }) => ({ domain, imsOrgId }));
  await Promise.allSettled(
    entries.map(async ({ domain, imsOrgId }) => {
      if (!domain || !imsOrgId) {
        log.error(`Skipping invalid entry: ${JSON.stringify({ domain, imsOrgId })}`);
        failed += 1;
        return;
      }
      try {
        const result = await preonboardDomain({ domain, imsOrgId }, context);
        if (result) results.push(result);
        succeeded += 1;
      } catch (error) {
        log.error(`Unexpected error for ${domain}: ${error.message}`);
        failed += 1;
      }
    }),
  );

  // Write CSV report
  if (results.length > 0) {
    const headers = Object.keys(results[0]);
    const csvLines = [
      headers.join(','),
      ...results.map((r) => headers.map((h) => `"${String(r[h]).replace(/"/g, '""')}"`).join(',')),
    ];
    const csvFile = inputFile.replace(/\.json$/, '-report.csv');
    const { writeFileSync } = await import('fs');
    writeFileSync(csvFile, csvLines.join('\n'), 'utf-8');
    log.info(`\nCSV report written to ${csvFile}`);
  }

  log.info(`\nDone. Succeeded: ${succeeded}, Failed: ${failed}`);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
