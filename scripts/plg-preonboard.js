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
 * If the site already exists on a real org, uses that org; otherwise creates
 * the site under the demo org. Enables audits/imports, triggers audit runs,
 * and creates ASO entitlement + site enrollment (new sites only).
 * Sets PlgOnboarding status to PRE_ONBOARDING (keeps customer imsOrgId).
 *
 * When the customer later calls POST /plg/onboard, the fast-track path
 * picks up the PRE_ONBOARDING record, creates site enrollment, and sets ONBOARDED.
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
 *   AWS_REGION          - AWS region
 *   DEFAULT_ORGANIZATION_ID - Default org ID (for internal org check)
 *   AUDIT_JOBS_QUEUE_URL    - (optional) SQS audit queue URL (for update-redirects)
 *   RUM_ADMIN_KEY           - (optional) RUM admin key for auto-resolving author URL
 *   SPACECAT_API_BASE_URL        - SpaceCat API base URL (e.g. https://xxx.cloudfront.net)
 *   ADMIN_API_KEY        - Admin API key for SpaceCat API
 */

// eslint-disable-next-line import/no-extraneous-dependencies
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'fs';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { createDataAccess, Site as SiteModel } from '@adobe/spacecat-shared-data-access';
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

const ASO_DEMO_ORG = '908936ED5D35CC220A495CD4@AdobeOrg';
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const AEM_CS_PUBLISH_HOST_PATTERN = /^publish-p(\d+)-e(\d+)\.adobeaemcloud\.(com|net)$/i;
const EDS_HOST_PATTERN = /^([\w-]+)--([\w-]+)--([\w-]+)\.(aem\.live|hlx\.live)$/i;

// ---------------------------------------------------------------------------
// Inlined helpers (no imports from src/ so the script runs standalone)
// ---------------------------------------------------------------------------

const logLines = [];
const log = {
  info: (...args) => {
    const msg = `[INFO] ${args.join(' ')}`;
    // eslint-disable-next-line no-console
    console.log(msg);
    logLines.push(msg);
  },
  warn: (...args) => {
    const msg = `[WARN] ${args.join(' ')}`;
    // eslint-disable-next-line no-console
    console.warn(msg);
    logLines.push(msg);
  },
  error: (...args) => {
    const msg = `[ERROR] ${args.join(' ')}`;
    // eslint-disable-next-line no-console
    console.error(msg);
    logLines.push(msg);
  },
  debug: () => {},
};

/** ASO PLG profile – mirrors static/onboard/profiles.json "aso_plg" entry. */
const ASO_PLG_PROFILE = {
  audits: {
    'alt-text': {},
    cwv: {},
    'scrape-top-pages': {},
    'broken-backlinks': {},
    'broken-backlinks-auto-suggest': {},
    'broken-backlinks-auto-fix': {},
    'alt-text-auto-fix': {},
    'alt-text-auto-suggest-mystique': {},
    'cwv-auto-fix': {},
    'cwv-auto-suggest': {},
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

/**
 * Auto-resolve author URL from RUM bundles (inlined from src/support/utils.js).
 * Returns { authorURL, programId, environmentId, host } or null.
 */
async function autoResolveAuthorUrl(domain, context) {
  try {
    const rumApiClient = RUMAPIClient.createFrom(context);
    const domainkey = await rumApiClient.retrieveDomainkey(domain);

    // Try up to 7 days back to find a bundle with a host
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
        log.warn(`  Failed to fetch RUM bundles for ${domain} (${year}-${month}-${day}): status ${response.status}`);
        // eslint-disable-next-line no-continue
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      const data = await response.json();
      const rumBundles = data?.rumBundles || [];
      if (rumBundles.length > 0) {
        [{ host }] = rumBundles;
        log.info(`  Found RUM bundles for ${domain} on ${year}-${month}-${day}`);
        break;
      }
    }

    if (!host) {
      log.info(`  No RUM bundles found for ${domain} in last 7 days`);
      return null;
    }
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
  const required = ['POSTGREST_URL', 'POSTGREST_API_KEY', 'AWS_REGION', 'SPACECAT_API_BASE_URL', 'ADMIN_API_KEY', 'DEFAULT_ORGANIZATION_ID'];
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
      DEFAULT_ORGANIZATION_ID: process.env.DEFAULT_ORGANIZATION_ID,
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
      return {
        domain,
        imsOrgId,
        siteId: onboarding.getSiteId() || '',
        organizationId: onboarding.getOrganizationId() || '',
        status: `SKIPPED (${status})`,
        siteCreated: '',
        botBlocker: '',
        botBlockerIPs: '',
        rumHost: '',
        deliveryType: '',
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
        entitlement: '',
        steps: Object.keys(onboarding.getSteps() || {}).join(';'),
        v_deliveryType: '',
        v_overrideBaseURL: '',
        v_authorURL: '',
        v_code: '',
        v_hlxConfig: '',
        originalSite: '',
      };
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
  const validation = {};

  try {
    // Step 1: Check if site already exists to determine organization
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

    // Step 2: Resolve organization
    // If site exists on a real org (not default), use that org. Otherwise use demo org.
    const { Organization } = da;
    let organizationId;
    if (site) {
      const existingOrgId = site.getOrganizationId();
      if (existingOrgId && existingOrgId !== context.env.DEFAULT_ORGANIZATION_ID) {
        organizationId = existingOrgId;
        log.info(`  Using existing site org: ${organizationId}`);
      }
    }
    if (!organizationId) {
      const demoOrg = await Organization.findByImsOrgId(ASO_DEMO_ORG);
      if (!demoOrg) {
        throw new Error(`Demo org ${ASO_DEMO_ORG} not found`);
      }
      organizationId = demoOrg.getId();
      log.info(`  Org resolved (demo): ${organizationId}`);
    }
    onboarding.setOrganizationId(organizationId);
    steps.orgResolved = true;

    // Reassign site to resolved org if needed (e.g. site was on default org)
    if (site && site.getOrganizationId() !== organizationId) {
      log.info(`  Reassigning site from ${site.getOrganizationId()} to ${organizationId}`);
      site.setOrganizationId(organizationId);
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
        siteCreated: 'no',
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
        v_deliveryType: '',
        v_overrideBaseURL: '',
        v_authorURL: '',
        v_code: '',
        v_hlxConfig: '',
        originalSite: originalSiteSnapshot || '',
      };
    }

    // Step 4: Create site if new, or verify existing site info
    let siteCreated = false;
    if (!site) {
      const deliveryType = await findDeliveryType(baseURL);
      site = await Site.create({
        baseURL,
        organizationId,
        ...(deliveryType && { deliveryType }),
      });
      siteCreated = true;
      log.info(`  Created site ${site.getId()}`);
      steps.siteCreated = true;
    } else {
      // Verify and update delivery type if missing, validate if present
      const resolvedDeliveryType = await findDeliveryType(baseURL);
      if (!site.getDeliveryType()) {
        if (resolvedDeliveryType) {
          site.setDeliveryType(resolvedDeliveryType);
          log.info(`  Updated delivery type: ${resolvedDeliveryType}`);
        }
        validation.deliveryType = resolvedDeliveryType ? 'absent_added' : 'absent_unknown';
      } else if (resolvedDeliveryType && site.getDeliveryType() !== resolvedDeliveryType) {
        validation.deliveryType = `wrong:actual=${site.getDeliveryType()}|expected=${resolvedDeliveryType}`;
        log.warn(`  deliveryType mismatch: has '${site.getDeliveryType()}', resolved '${resolvedDeliveryType}'`);
      } else {
        validation.deliveryType = 'correct';
      }
    }
    onboarding.setSiteId(site.getId());
    steps.siteResolved = true;

    // Step 4b: Resolve canonical URL early so the RUM lookup uses the correct hostname
    // (e.g. abbviepro.com redirects to www.abbviepro.com — RUM is keyed on the www host)
    const siteConfig = site.getConfig();
    const currentFetchConfig = siteConfig.getFetchConfig() || {};
    let overrideBaseURL = currentFetchConfig.overrideBaseURL || null;
    let resolvedOverrideBaseURL = null;
    try {
      const resolvedUrl = await resolveCanonicalUrl(baseURL);
      if (resolvedUrl) {
        const { pathname: basePath, origin: baseOrigin } = new URL(baseURL);
        const { pathname: resolvedPath, origin: resolvedOrigin } = new URL(resolvedUrl);
        if (basePath !== resolvedPath || baseOrigin !== resolvedOrigin) {
          resolvedOverrideBaseURL = basePath !== '/' ? `${resolvedOrigin}${basePath}` : resolvedOrigin;
        }
      }
    } catch (error) {
      log.warn(`  Failed to resolve canonical URL: ${error.message}`);
    }

    if (!overrideBaseURL) {
      if (resolvedOverrideBaseURL) {
        overrideBaseURL = resolvedOverrideBaseURL;
        siteConfig.updateFetchConfig({ ...currentFetchConfig, overrideBaseURL });
        log.info(`  Set overrideBaseURL to ${overrideBaseURL}`);
        validation.overrideBaseURL = 'absent_added';
      }
    } else if (resolvedOverrideBaseURL && overrideBaseURL !== resolvedOverrideBaseURL) {
      validation.overrideBaseURL = `wrong:actual=${overrideBaseURL}|expected=${resolvedOverrideBaseURL}`;
      log.warn(`  overrideBaseURL mismatch: has '${overrideBaseURL}', resolved '${resolvedOverrideBaseURL}'`);
    } else if (resolvedOverrideBaseURL) {
      validation.overrideBaseURL = 'correct';
    }

    // Use the canonical hostname for RUM lookup when available
    const effectiveDomain = overrideBaseURL ? new URL(overrideBaseURL).hostname : domain;

    // Step 4c: Auto-resolve author URL and RUM host
    let rumHost = null;
    try {
      const resolvedConfig = await autoResolveAuthorUrl(effectiveDomain, context);
      rumHost = resolvedConfig?.host || null;

      const existingDeliveryConfig = site.getDeliveryConfig() || {};
      if (resolvedConfig?.authorURL) {
        if (!existingDeliveryConfig.authorURL) {
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
          validation.authorURL = 'absent_added';
        } else if (existingDeliveryConfig.authorURL !== resolvedConfig.authorURL) {
          validation.authorURL = `wrong:actual=${existingDeliveryConfig.authorURL}|expected=${resolvedConfig.authorURL}`;
          log.warn(`  authorURL mismatch: has '${existingDeliveryConfig.authorURL}', resolved '${resolvedConfig.authorURL}'`);
        } else {
          validation.authorURL = 'correct';
        }
      }
    } catch (error) {
      log.warn(`  Failed to auto-resolve author URL: ${error.message}`);
    }

    // Step 4d: Resolve EDS code config from RUM host
    if (rumHost) {
      const existingCode = site.getCode() || {};
      const edsCodeMatch = rumHost.match(EDS_HOST_PATTERN);
      if (edsCodeMatch) {
        const [, ref, repo, owner] = edsCodeMatch;
        if (!existingCode.owner) {
          site.setCode({
            type: 'github',
            owner,
            repo,
            ref,
            url: `https://github.com/${owner}/${repo}`,
          });
          log.info(`  Set code config: ${owner}/${repo}@${ref}`);
          steps.codeConfigResolved = true;
          validation.code = 'absent_added';
        } else if (existingCode.owner !== owner || existingCode.repo !== repo) {
          validation.code = `wrong:actual=${existingCode.owner}/${existingCode.repo}|expected=${owner}/${repo}`;
          log.warn(`  code config mismatch: has '${existingCode.owner}/${existingCode.repo}', resolved '${owner}/${repo}'`);
        } else {
          validation.code = 'correct';
        }
      }
    }

    // Step 4e: Set hlxConfig for EDS sites
    if (rumHost) {
      const edsMatch = rumHost.match(EDS_HOST_PATTERN);
      if (edsMatch) {
        const [, ref, repo, owner, tld] = edsMatch;
        const existingHlxConfig = site.getHlxConfig();
        if (!existingHlxConfig) {
          site.setHlxConfig({
            hlxVersion: 5,
            rso: {
              ref, site: repo, owner, tld,
            },
          });
          log.info(`  Set hlxConfig: ${ref}--${repo}--${owner}.${tld}`);
          steps.hlxConfigSet = true;
          validation.hlxConfig = 'absent_added';
        } else {
          const rso = existingHlxConfig.rso || {};
          if (rso.owner !== owner || rso.site !== repo) {
            validation.hlxConfig = `wrong:actual=${rso.owner}/${rso.site}|expected=${owner}/${repo}`;
            log.warn(`  hlxConfig mismatch: has '${rso.owner}/${rso.site}', resolved '${owner}/${repo}'`);
          } else {
            validation.hlxConfig = 'correct';
          }
        }
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

    // Step 5b: Queue update-redirects for AEM CS/CW sites
    const authoringType = site.getAuthoringType();
    const deliveryType = site.getDeliveryType();
    const validForRedirects = [
      SiteModel.AUTHORING_TYPES.CS,
      SiteModel.AUTHORING_TYPES.CS_CW,
    ].includes(authoringType)
      || deliveryType === SiteModel.DELIVERY_TYPES.AEM_CS;

    if (!validForRedirects) {
      log.info(`  Skipping update-redirects: site ${baseURL} is not AEM CS/CW (authoringType=${authoringType}, deliveryType=${deliveryType})`);
    } else {
      try {
        const deliveryConfig = site.getDeliveryConfig() || {};
        const { programId, environmentId } = deliveryConfig;
        if (!programId || !environmentId) {
          log.warn(`  Skipping update-redirects: missing deliveryConfig.programId or environmentId for ${baseURL}`);
        } else if (!process.env.AUDIT_JOBS_QUEUE_URL) {
          log.warn('  Skipping update-redirects: AUDIT_JOBS_QUEUE_URL not set');
        } else {
          await context.sqs.sendMessage(process.env.AUDIT_JOBS_QUEUE_URL, {
            type: 'identify-redirects',
            siteId: site.getId(),
            baseURL,
            programId: String(programId),
            environmentId: String(environmentId),
            minutes: 2000,
            updateRedirects: true,
          });
          steps.redirectsQueued = true;
          log.info(`  Queued update-redirects for ${baseURL}`);
        }
      } catch (error) {
        log.warn(`  update-redirects queue failed for ${baseURL}: ${error.message}`);
      }
    }

    // Step 6: Enable all audit handlers via SpaceCat API
    const allHandlers = [
      ...new Set([
        ...Object.keys(profile.audits || {}),
        'summit-plg',
      ]),
    ];
    const apiUrl = process.env.SPACECAT_API_BASE_URL;
    const apiKey = process.env.ADMIN_API_KEY;
    try {
      const payload = allHandlers.map((auditType) => ({ baseURL, auditType, enable: true }));
      const resp = await fetch(`${apiUrl}/configurations/sites/audits`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        const errBody = await resp.text();
        log.warn(`  API enable handlers returned ${resp.status}: ${errBody}`);
      } else {
        const results = await resp.json();
        log.info(`  Enabled handlers via API: ${JSON.stringify(results)}`);
        steps.auditsEnabled = true;
      }
    } catch (error) {
      log.warn(`  Failed to enable handlers via API: ${error.message}`);
    }

    // Step 7: Create ASO entitlement + site enrollment (only for newly created sites)
    if (siteCreated) {
      try {
        const tierClient = await TierClient.createForSite(context, site, ASO_PRODUCT_CODE);
        const { entitlement, siteEnrollment } = await tierClient.createEntitlement(ASO_TIER);
        log.info(`  Created ASO entitlement ${entitlement.getId()} and enrollment ${siteEnrollment.getId()}`);
        steps.entitlementCreated = true;
      } catch (error) {
        if (error.message?.includes('already exists')
          || error.message?.includes('Already enrolled')) {
          log.info('  ASO entitlement/enrollment already exists');
          steps.entitlementCreated = true;
        } else {
          log.warn(`  Failed to create entitlement/enrollment: ${error.message}`);
        }
      }
    } else {
      log.info('  Skipping entitlement/enrollment for existing site (manual step needed)');
      steps.entitlementSkipped = true;
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
      siteCreated: siteCreated ? 'yes' : 'no',
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
      v_deliveryType: validation.deliveryType || '',
      v_overrideBaseURL: validation.overrideBaseURL || '',
      v_authorURL: validation.authorURL || '',
      v_code: validation.code || '',
      v_hlxConfig: validation.hlxConfig || '',
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
    log.error('Usage: node scripts/plg-preonboard.js <input.json>');
    process.exit(1);
  }

  validateEnv();

  const domains = JSON.parse(readFileSync(inputFile, 'utf-8'));
  if (!Array.isArray(domains) || domains.length === 0) {
    log.error('Input must be a non-empty JSON array');
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
        if (result) {
          results.push(result);
          succeeded += 1;
        } else {
          failed += 1;
        }
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
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const csvFile = inputFile.replace(/\.json$/, `-report-${timestamp}.csv`);
    writeFileSync(csvFile, csvLines.join('\n'), 'utf-8');
    log.info(`\nCSV report written to ${csvFile}`);
  }

  log.info(`\nDone. Succeeded: ${succeeded}, Failed: ${failed}`);

  // Write log file
  const logTimestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const logFile = inputFile.replace(/\.json$/, `-log-${logTimestamp}.log`);
  writeFileSync(logFile, logLines.join('\n'), 'utf-8');
  log.info(`Log file written to ${logFile}`);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Fatal error:', error);
  process.exit(1);
});
