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
 * PLG Preonboarding Script (API-only, no PostgREST required)
 *
 * Preonboards domains for PLG ASO customers using only the SpaceCat API.
 * If the site already exists and its org has an imsOrgId, keeps that org.
 * Otherwise uses (or creates) the org matching the input imsOrgId.
 * Enables audits/imports and creates ASO entitlement for all sites.
 *
 * Usage:
 *   node scripts/plg-preonboard-api.js <input.json>
 *
 * Input JSON format:
 *   [
 *     { "domain": "example.com", "imsOrgId": "ABC123@AdobeOrg" },
 *     { "domain": "another.com", "imsOrgId": "DEF456@AdobeOrg" }
 *   ]
 *
 * Required environment variables:
 *   SPACECAT_API_BASE_URL - SpaceCat API base URL
 *   ADMIN_API_KEY         - Admin API key for SpaceCat API
 *
 * Optional environment variables:
 *   RUM_ADMIN_KEY         - RUM admin key for auto-resolving author URL
 */

// eslint-disable-next-line import/no-extraneous-dependencies
import 'dotenv/config';
import { readFileSync, appendFileSync, writeFileSync } from 'fs';
import RUMAPIClient, { RUM_BUNDLER_API_HOST } from '@adobe/spacecat-shared-rum-api-client';
import {
  composeBaseURL,
  detectAEMVersion,
  detectBotBlocker,
  detectLocale,
  resolveCanonicalUrl,
  tracingFetch as fetch,
} from '@adobe/spacecat-shared-utils';

// ---------------------------------------------------------------------------
// Prevent unhandled stream errors (e.g. Brotli) from crashing the process
// ---------------------------------------------------------------------------
process.on('uncaughtException', (err) => {
  if (err.code === 'Z_BUF_ERROR' || err.code === 'ERR_PADDING_1') {
    // eslint-disable-next-line no-console
    console.warn(`[WARN] Suppressed stream error: ${err.message}`);
  } else {
    throw err;
  }
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const AEM_CS_PUBLISH_HOST_PATTERN = /^publish-p(\d+)-e(\d+)\.adobeaemcloud\.(com|net)$/i;
const EDS_HOST_PATTERN = /^([\w-]+)--([\w-]+)--([\w-]+)\.(aem\.live|hlx\.live)$/i;

const ASO_PLG_HANDLERS = [
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

// ---------------------------------------------------------------------------
// Logging (incremental file + console)
// ---------------------------------------------------------------------------

let logFilePath = null;

function writeLog(consoleMethod, level, args) {
  const msg = `[${level}] ${args.join(' ')}`;
  consoleMethod(msg); // eslint-disable-line no-console
  if (logFilePath) {
    appendFileSync(logFilePath, `${msg}\n`, 'utf-8');
  }
}

const log = {
  initLogFile: (path) => {
    logFilePath = path;
  },
  info: (...args) => writeLog(console.log, 'INFO', args), // eslint-disable-line no-console
  warn: (...args) => writeLog(console.warn, 'WARN', args), // eslint-disable-line no-console
  error: (...args) => writeLog(console.error, 'ERROR', args), // eslint-disable-line no-console
  debug: () => {},
};

// ---------------------------------------------------------------------------
// CSV (incremental file)
// ---------------------------------------------------------------------------

let csvFilePath = null;
let csvHeadersWritten = false;

function appendCsvRow(result) {
  if (!csvFilePath || !result) {
    return;
  }
  const headers = Object.keys(result);
  if (!csvHeadersWritten) {
    appendFileSync(csvFilePath, `${headers.join(';')}\n`, 'utf-8');
    csvHeadersWritten = true;
  }
  const row = headers
    .map((h) => `"${String(result[h]).replace(/"/g, '""')}"`)
    .join(';');
  appendFileSync(csvFilePath, `${row}\n`, 'utf-8');
}

// ---------------------------------------------------------------------------
// SpaceCat API helpers
// ---------------------------------------------------------------------------

function getApiConfig() {
  return {
    apiUrl: process.env.SPACECAT_API_BASE_URL,
    apiKey: process.env.ADMIN_API_KEY,
  };
}

async function apiFetch(path, options = {}) {
  const { apiUrl, apiKey } = getApiConfig();
  const resp = await fetch(`${apiUrl}${path}`, {
    ...options,
    headers: {
      'x-api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept-Encoding': 'gzip, deflate',
      ...options.headers,
    },
  });
  return resp;
}

async function apiGet(path) {
  const resp = await apiFetch(path);
  if (!resp.ok) {
    return null;
  }
  return resp.json();
}

async function apiPost(path, body) {
  const resp = await apiFetch(path, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return { status: resp.status, data: await resp.json().catch(() => null) };
}

async function apiPatch(path, body) {
  const resp = await apiFetch(path, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  return { status: resp.status, data: await resp.json().catch(() => null) };
}

// ---------------------------------------------------------------------------
// Cached lookups
// ---------------------------------------------------------------------------

const orgCache = new Map();
const imsOrgCache = new Map();

async function fetchOrgById(orgId) {
  if (!orgId) {
    return null;
  }
  if (orgCache.has(orgId)) {
    return orgCache.get(orgId);
  }
  const org = await apiGet(`/organizations/${orgId}`);
  orgCache.set(orgId, org);
  return org;
}

async function fetchOrgByImsOrgId(imsOrgId) {
  if (!imsOrgId) {
    return null;
  }
  if (imsOrgCache.has(imsOrgId)) {
    return imsOrgCache.get(imsOrgId);
  }
  const org = await apiGet(
    `/organizations/by-ims-org-id/${encodeURIComponent(imsOrgId)}`,
  );
  imsOrgCache.set(imsOrgId, org);
  return org;
}

async function fetchPlgRecords(imsOrgId) {
  if (!imsOrgId) {
    return [];
  }
  const data = await apiGet(
    `/plg/onboard/status/${encodeURIComponent(imsOrgId)}`,
  );
  return Array.isArray(data) ? data : [];
}

// ---------------------------------------------------------------------------
// Inlined helpers
// ---------------------------------------------------------------------------

function deriveProjectName(baseURL) {
  const { hostname } = new URL(baseURL);
  const parts = hostname.split('.');
  if (parts.length <= 2) {
    return hostname;
  }
  for (let i = 0; i < Math.min(parts.length, 2); i += 1) {
    if (parts[i].length === 2 || parts[i].length === 3) {
      parts[i] = null;
    }
  }
  return parts.filter(Boolean).join('.');
}

async function findDeliveryType(url) {
  try {
    const resp = await fetch(url);
    return detectAEMVersion(await resp.text());
  } catch {
    return 'other';
  }
}

async function autoResolveAuthorUrl(domain) {
  try {
    const context = {
      env: { RUM_ADMIN_KEY: process.env.RUM_ADMIN_KEY || '' },
      log,
    };
    const rumApiClient = RUMAPIClient.createFrom(context);
    const domainkey = await rumApiClient.retrieveDomainkey(domain);

    let host = null;
    for (let daysBack = 1; daysBack <= 7; daysBack += 1) {
      const date = new Date(Date.now() - daysBack * ONE_DAY_MS);
      const year = date.getUTCFullYear();
      const month = (date.getUTCMonth() + 1).toString()
        .padStart(2, '0');
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
        log.info(`  Found RUM bundles for ${domain} on ${year}-${month}-${day}`);
        break;
      }
    }

    if (!host) {
      return null;
    }

    const match = host?.match(AEM_CS_PUBLISH_HOST_PATTERN);
    if (!match) {
      return { host };
    }

    const [, programId, environmentId] = match;
    const authorURL = `https://author-p${programId}-e${environmentId}.adobeaemcloud.com`;
    log.info(`  Auto-resolved author URL: ${authorURL}`);
    return {
      authorURL, programId, environmentId, host,
    };
  } catch (error) {
    log.warn(`  Auto-resolve author URL failed: ${error.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function validateEnv() {
  const required = ['SPACECAT_API_BASE_URL', 'ADMIN_API_KEY'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing env vars: ${missing.join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// Preonboarding logic
// ---------------------------------------------------------------------------

async function preonboardDomain({ domain, imsOrgId }) {
  const baseURL = composeBaseURL(domain);
  log.info(`\nPreonboarding: ${domain} (${imsOrgId}), baseURL: ${baseURL}`);

  const steps = {};
  const validation = {};

  const emptyResult = (overrides) => ({
    domain,
    imsOrgId,
    skipped: 'no',
    skipReason: '',
    siteId: '',
    organizationId: '',
    status: '',
    siteCreated: '',
    botBlocker: '',
    botBlockerIPs: '',
    rumHost: '',
    deliveryType: '',
    authorURL: '',
    programId: '',
    environmentId: '',
    codeOwner: '',
    codeRepo: '',
    hlxConfig: 'no',
    overrideBaseURL: '',
    language: '',
    region: '',
    entitlement: '',
    enrollment: '',
    steps: '',
    v_deliveryType: '',
    v_overrideBaseURL: '',
    v_authorURL: '',
    v_code: '',
    v_hlxConfig: '',
    originalSite: '',
    ...overrides,
  });

  // Step 0: Check existing PLG record via API
  const plgRecords = await fetchPlgRecords(imsOrgId);
  const plgRecord = plgRecords.find((r) => r.domain === domain);
  if (plgRecord) {
    const { status } = plgRecord;
    if (status === 'ONBOARDED') {
      log.info(`  Already ${status}, skipping`);
      return emptyResult({
        skipped: 'yes',
        skipReason: status,
        siteId: plgRecord.siteId || '',
        organizationId: plgRecord.organizationId || '',
        status: `SKIPPED (${status})`,
      });
    }
    if (status === 'PRE_ONBOARDING') {
      log.info(`  Already ${status}, will validate and fix site object`);
    }
  }

  // Step 1: Look up site
  const encodedUrl = btoa(baseURL);
  let site = await apiGet(`/sites/by-base-url/${encodedUrl}`);
  const originalSiteSnapshot = site
    ? JSON.stringify(site) : '';

  // Step 2: Always resolve/create the input IMS org for customer-scoped operations
  let inputOrg = await fetchOrgByImsOrgId(imsOrgId);
  if (!inputOrg) {
    log.info(`  No org for ${imsOrgId}, creating...`);
    const { status, data } = await apiPost('/organizations', {
      name: `Organization ${imsOrgId}`,
      imsOrgId,
    });
    if (status >= 200 && status < 300 && data) {
      inputOrg = data;
      imsOrgCache.set(imsOrgId, inputOrg);
      log.info(`  Created org ${inputOrg.id}`);
      steps.orgCreated = true;
    } else {
      throw new Error(`Failed to create org: ${JSON.stringify(data)}`);
    }
  }
  const inputOrganizationId = inputOrg.id;

  // Step 3: Resolve site organization
  let organizationId;
  if (site) {
    const existingOrgId = site.organizationId;
    if (existingOrgId) {
      const existingOrg = await fetchOrgById(existingOrgId);
      if (existingOrg?.imsOrgId) {
        organizationId = existingOrgId;
        if (existingOrg.imsOrgId !== imsOrgId) {
          log.warn(`  Site org has different IMS: ${existingOrg.imsOrgId} (keeping it)`);
        } else {
          log.info(`  Site org IMS matches: ${existingOrg.imsOrgId}`);
        }
      }
    }
  }
  if (!organizationId) {
    organizationId = inputOrganizationId;
    log.info(`  Using input IMS org: ${organizationId}`);
  }
  steps.orgResolved = true;

  // Step 4: Bot blocker check
  let botBlockerResult = { crawlable: true };
  try {
    botBlockerResult = await detectBotBlocker({ baseUrl: baseURL });
  } catch (error) {
    log.warn(`  Bot blocker check failed: ${error.message}`);
  }
  if (!botBlockerResult.crawlable) {
    log.warn(`  Bot blocker detected (${botBlockerResult.type})`);
    return emptyResult({
      siteId: site?.id || '',
      organizationId,
      status: 'WAITING_FOR_IP_ALLOWLISTING',
      siteCreated: 'no',
      botBlocker: botBlockerResult.type || '',
      botBlockerIPs: (botBlockerResult.ipsToAllowlist || []).join(';'),
      deliveryType: site?.deliveryType || '',
      steps: Object.keys(steps).filter((k) => steps[k]).join(';'),
      originalSite: originalSiteSnapshot,
    });
  }

  // Step 5: Create site if new, or validate existing
  let siteCreated = false;
  if (!site) {
    const deliveryType = await findDeliveryType(baseURL);
    const { status, data } = await apiPost('/sites', {
      baseURL,
      organizationId,
      ...(deliveryType && deliveryType !== 'other' && { deliveryType }),
    });
    if (status === 201 || status === 200) {
      site = data;
      siteCreated = status === 201;
      log.info(`  ${siteCreated ? 'Created' : 'Found existing'} site ${site.id}`);
      steps.siteCreated = siteCreated;
    } else {
      throw new Error(`Failed to create site: ${JSON.stringify(data)}`);
    }
  } else {
    log.info(`  Found existing site ${site.id}`);
    const resolvedDeliveryType = await findDeliveryType(baseURL);
    if (!site.deliveryType) {
      validation.deliveryType = resolvedDeliveryType
        ? 'absent_added' : 'absent_unknown';
    } else if (resolvedDeliveryType && site.deliveryType !== resolvedDeliveryType) {
      validation.deliveryType = `wrong:actual=${site.deliveryType}|expected=${resolvedDeliveryType}`;
    } else {
      validation.deliveryType = 'correct';
    }
  }
  steps.siteResolved = true;

  // Step 5b: Resolve canonical URL
  let overrideBaseURL = null;
  let resolvedOverrideBaseURL = null;
  try {
    const resolvedUrl = await resolveCanonicalUrl(baseURL);
    if (resolvedUrl) {
      const { pathname: basePath, origin: baseOrigin } = new URL(baseURL);
      const {
        pathname: resolvedPath,
        origin: resolvedOrigin,
      } = new URL(resolvedUrl);
      if (basePath !== resolvedPath || baseOrigin !== resolvedOrigin) {
        resolvedOverrideBaseURL = basePath !== '/'
          ? `${resolvedOrigin}${basePath}` : resolvedOrigin;
      }
    }
  } catch (error) {
    log.warn(`  Failed to resolve canonical URL: ${error.message}`);
  }

  // Check existing overrideBaseURL from site config
  const existingOverride = site.config?.fetchConfig?.overrideBaseURL;
  if (!existingOverride) {
    if (resolvedOverrideBaseURL) {
      overrideBaseURL = resolvedOverrideBaseURL;
      validation.overrideBaseURL = 'absent_added';
    }
  } else {
    overrideBaseURL = existingOverride;
    if (resolvedOverrideBaseURL && existingOverride !== resolvedOverrideBaseURL) {
      validation.overrideBaseURL = `wrong:actual=${existingOverride}|expected=${resolvedOverrideBaseURL}`;
    } else if (resolvedOverrideBaseURL) {
      validation.overrideBaseURL = 'correct';
    }
  }

  const effectiveDomain = overrideBaseURL
    ? new URL(overrideBaseURL).hostname : domain;

  // Step 5c: Auto-resolve author URL and RUM host
  let rumHost = null;
  const resolvedConfig = await autoResolveAuthorUrl(effectiveDomain);
  steps.rumVerified = Boolean(resolvedConfig?.host);
  rumHost = resolvedConfig?.host || null;

  const existingDeliveryConfig = site.deliveryConfig || {};
  if (resolvedConfig?.authorURL) {
    if (!existingDeliveryConfig.authorURL) {
      validation.authorURL = 'absent_added';
    } else if (existingDeliveryConfig.authorURL !== resolvedConfig.authorURL) {
      validation.authorURL = `wrong:actual=${existingDeliveryConfig.authorURL}|expected=${resolvedConfig.authorURL}`;
    } else {
      validation.authorURL = 'correct';
    }
  }

  // Step 5d: Resolve EDS code config
  let codeOwner = site.code?.owner || '';
  let codeRepo = site.code?.repo || '';
  if (rumHost) {
    const edsMatch = rumHost.match(EDS_HOST_PATTERN);
    if (edsMatch) {
      const [,, repo, owner] = edsMatch;
      if (!site.code?.owner) {
        validation.code = 'absent_added';
      } else if (site.code.owner !== owner || site.code.repo !== repo) {
        validation.code = `wrong:actual=${site.code.owner}/${site.code.repo}|expected=${owner}/${repo}`;
      } else {
        validation.code = 'correct';
      }
      // Use resolved values for the update
      codeOwner = codeOwner || owner;
      codeRepo = codeRepo || repo;
      steps.codeConfigResolved = !site.code?.owner;
    }
  }

  // Step 5e: Resolve hlxConfig
  let hlxConfigResolved = null;
  if (rumHost) {
    const edsMatch = rumHost.match(EDS_HOST_PATTERN);
    if (edsMatch) {
      const [, ref, repo, owner, tld] = edsMatch;
      if (!site.hlxConfig) {
        hlxConfigResolved = {
          hlxVersion: 5,
          rso: {
            ref, site: repo, owner, tld,
          },
        };
        validation.hlxConfig = 'absent_added';
      } else {
        const rso = site.hlxConfig.rso || {};
        if (rso.owner !== owner || rso.site !== repo) {
          validation.hlxConfig = `wrong:actual=${rso.owner}/${rso.site}|expected=${owner}/${repo}`;
        } else {
          validation.hlxConfig = 'correct';
        }
      }
    }
  }

  // Step 6: Build PATCH body for site update
  const patchBody = {};

  // Delivery type (only set if missing)
  if (!site.deliveryType) {
    const dt = await findDeliveryType(baseURL);
    if (dt && dt !== 'other') {
      patchBody.deliveryType = dt;
    }
  }

  // Delivery config (author URL)
  if (resolvedConfig?.authorURL && !existingDeliveryConfig.authorURL) {
    patchBody.deliveryConfig = {
      ...existingDeliveryConfig,
      authorURL: resolvedConfig.authorURL,
      programId: resolvedConfig.programId,
      environmentId: resolvedConfig.environmentId,
      preferContentApi: true,
      imsOrgId,
    };
    steps.authorUrlResolved = true;
  }

  // Code config
  if (rumHost && !site.code?.owner) {
    const edsMatch = rumHost.match(EDS_HOST_PATTERN);
    if (edsMatch) {
      const [, ref, repo, owner] = edsMatch;
      patchBody.code = {
        type: 'github',
        owner,
        repo,
        ref,
        url: `https://github.com/${owner}/${repo}`,
      };
    }
  }

  // hlxConfig
  if (hlxConfigResolved) {
    patchBody.hlxConfig = hlxConfigResolved;
    steps.hlxConfigSet = true;
  }

  // Locale
  if (!site.language || !site.region) {
    try {
      const locale = await detectLocale({ baseUrl: baseURL });
      if (!site.language && locale.language) {
        patchBody.language = locale.language;
      }
      if (!site.region && locale.region) {
        patchBody.region = locale.region;
      }
    } catch (error) {
      log.warn(`  Locale detection failed: ${error.message}`);
      if (!site.language) {
        patchBody.language = 'en';
      }
      if (!site.region) {
        patchBody.region = 'US';
      }
    }
  }

  // Override base URL in config
  if (overrideBaseURL && !existingOverride) {
    patchBody.config = {
      ...(site.config || {}),
      fetchConfig: {
        ...(site.config?.fetchConfig || {}),
        overrideBaseURL,
      },
    };
    log.info(`  Set overrideBaseURL to ${overrideBaseURL}`);
  }

  // Apply site updates
  if (Object.keys(patchBody).length > 0) {
    const { status, data } = await apiPatch(`/sites/${site.id}`, patchBody);
    if (status >= 200 && status < 300) {
      log.info(`  Updated site: ${Object.keys(patchBody).join(', ')}`);
      steps.configUpdated = true;
      // Merge updates back into site object
      Object.assign(site, data || patchBody);
    } else {
      log.warn(`  PATCH site failed (${status}): ${JSON.stringify(data)}`);
    }
  }

  // Step 6b: Create/find project
  const projectName = deriveProjectName(baseURL);
  if (!site.projectId) {
    const { status: pStatus, data: pData } = await apiPost('/projects', {
      projectName,
      organizationId,
    });
    if (pStatus >= 200 && pStatus < 300 && pData) {
      // Update site with projectId
      await apiPatch(`/sites/${site.id}`, {
        projectId: pData.id,
      });
      log.info(`  Assigned project ${pData.id}`);
      steps.projectAssigned = true;
    }
  }

  // Step 7: Enable audit handlers via API
  try {
    const payload = ASO_PLG_HANDLERS
      .map((auditType) => ({ baseURL, auditType, enable: true }));
    const { apiUrl, apiKey } = getApiConfig();
    const resp = await fetch(`${apiUrl}/configurations/sites/audits`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify(payload),
    });
    if (resp.ok) {
      log.info('  Enabled audit handlers');
      steps.auditsEnabled = true;
    } else {
      log.warn(`  Enable handlers failed: ${resp.status}`);
    }
  } catch (error) {
    log.warn(`  Enable handlers error: ${error.message}`);
  }

  // Step 8: Create ASO entitlement on the input/customer IMS org
  try {
    const { status: eStatus, data: eData } = await apiPost(
      `/organizations/${inputOrganizationId}/entitlements`,
      { productCode: 'ASO', tier: 'PRE_ONBOARD' },
    );
    if (eStatus >= 200 && eStatus < 300) {
      log.info(`  Created ASO entitlement ${eData?.id || ''}`);
      steps.entitlementCreated = true;
    } else if (eData?.message?.includes('already exists')) {
      log.info('  ASO entitlement already exists');
      steps.entitlementCreated = true;
    } else {
      log.warn(`  Entitlement failed (${eStatus}): ${JSON.stringify(eData)}`);
    }
  } catch (error) {
    log.warn(`  Entitlement error: ${error.message}`);
  }

  // Step 9: Create site enrollment only for newly created sites
  if (siteCreated) {
    try {
      const { status: enrollmentStatus, data: enrollmentData } = await apiPost(
        `/sites/${site.id}/site-enrollments`,
        {},
      );
      if (enrollmentStatus === 201) {
        log.info(`  Created site enrollment ${enrollmentData?.id || ''}`);
        steps.enrollmentCreated = true;
      } else if (enrollmentStatus === 200 && enrollmentData?.skipped) {
        log.info(`  Site enrollment skipped: ${enrollmentData.reason}`);
        if (enrollmentData.reason === 'already_enrolled') {
          steps.enrollmentCreated = true;
        }
      } else {
        log.warn(`  Site enrollment failed (${enrollmentStatus}): ${JSON.stringify(enrollmentData)}`);
      }
    } catch (error) {
      log.warn(`  Site enrollment error: ${error.message}`);
    }
  } else {
    log.info('  Existing site detected, skipping site enrollment');
    steps.enrollmentSkipped = true;
  }

  // Step 10: Create PLG onboarding record
  try {
    const { status: plgStatus, data: plgData } = await apiPost(
      '/plg/records',
      {
        imsOrgId,
        domain,
        status: 'PRE_ONBOARDING',
        organizationId,
        siteId: site.id,
        steps,
      },
    );
    if (plgStatus >= 200 && plgStatus < 300) {
      log.info(`  Created PLG onboarding record ${plgData?.id || ''}`);
      steps.plgRecordCreated = true;
    } else if (plgStatus === 409) {
      log.info('  PLG onboarding record already exists');
      steps.plgRecordCreated = true;
    } else {
      log.warn(`  PLG onboarding record failed (${plgStatus}): ${JSON.stringify(plgData)}`);
    }
  } catch (error) {
    log.warn(`  PLG onboarding record error: ${error.message}`);
  }

  // Step 11: Audit triggers disabled
  log.info('  Audit triggers disabled, skipping');

  log.info(`  Preonboarding complete for ${domain}`);

  return {
    domain,
    imsOrgId,
    skipped: 'no',
    skipReason: '',
    siteId: site.id,
    organizationId,
    status: 'PRE_ONBOARDING',
    siteCreated: siteCreated ? 'yes' : 'no',
    botBlocker: '',
    botBlockerIPs: '',
    rumHost: rumHost || '',
    deliveryType: site.deliveryType || '',
    authorURL: (site.deliveryConfig || existingDeliveryConfig)?.authorURL || '',
    programId: (site.deliveryConfig || existingDeliveryConfig)?.programId || '',
    environmentId: (site.deliveryConfig || existingDeliveryConfig)?.environmentId || '',
    codeOwner,
    codeRepo,
    hlxConfig: site.hlxConfig ? 'yes' : 'no',
    overrideBaseURL: overrideBaseURL || existingOverride || '',
    language: site.language || patchBody.language || '',
    region: site.region || patchBody.region || '',
    entitlement: steps.entitlementCreated ? 'yes' : 'no',
    enrollment: steps.enrollmentCreated ? 'yes' : 'no',
    steps: Object.keys(steps).filter((k) => steps[k]).join(';'),
    v_deliveryType: validation.deliveryType || '',
    v_overrideBaseURL: validation.overrideBaseURL || '',
    v_authorURL: validation.authorURL || '',
    v_code: validation.code || '',
    v_hlxConfig: validation.hlxConfig || '',
    originalSite: originalSiteSnapshot,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const inputFile = process.argv[2];
  if (!inputFile) {
    log.error('Usage: node scripts/plg-preonboard-api.js <input.json>');
    process.exit(1);
  }

  validateEnv();

  const domains = JSON.parse(readFileSync(inputFile, 'utf-8'));
  if (!Array.isArray(domains) || domains.length === 0) {
    log.error('Input must be a non-empty JSON array');
    process.exit(1);
  }

  const timestamp = new Date().toISOString()
    .replace(/[:.]/g, '-').slice(0, 19);
  logFilePath = inputFile.replace(/\.json$/, `-api-log-${timestamp}.log`);
  csvFilePath = inputFile.replace(/\.json$/, `-api-report-${timestamp}.csv`);
  log.initLogFile(logFilePath);

  const plgRecordsFile = inputFile.replace(/\.json$/, `-plg-records-${timestamp}.json`);

  log.info(`Preonboarding ${domains.length} domain(s)...`);
  log.info(`CSV: ${csvFilePath}`);
  log.info(`Log: ${logFilePath}`);
  log.info(`PLG records: ${plgRecordsFile}`);

  // Initialize PLG records file
  writeFileSync(plgRecordsFile, '[\n', 'utf-8');
  let plgRecordCount = 0;

  let succeeded = 0;
  let failed = 0;

  for (const { domain, imsOrgId } of domains) {
    if (!domain || !imsOrgId) {
      log.error(`Skipping invalid entry: ${JSON.stringify({ domain, imsOrgId })}`);
      failed += 1;
      // eslint-disable-next-line no-continue
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await preonboardDomain({ domain, imsOrgId });
      if (result) {
        appendCsvRow(result);
        succeeded += 1;

        // Append PLG onboarding record immediately for DB backfill
        if (result.skipped !== 'yes') {
          const plgStatus = result.status === 'WAITING_FOR_IP_ALLOWLISTING'
            ? 'WAITING_FOR_IP_ALLOWLISTING' : 'PRE_ONBOARDING';
          const plgRecord = {
            imsOrgId,
            domain,
            baseURL: composeBaseURL(domain),
            status: plgStatus,
            ...(result.siteId && { siteId: result.siteId }),
            ...(result.organizationId && { organizationId: result.organizationId }),
            steps: Object.fromEntries(
              (result.steps || '').split(';').filter(Boolean).map((s) => [s, true]),
            ),
            ...(result.botBlocker && {
              botBlocker: {
                type: result.botBlocker,
                ...(result.botBlockerIPs && {
                  ipsToAllowlist: result.botBlockerIPs.split(';').filter(Boolean),
                }),
              },
            }),
            ...(plgStatus === 'PRE_ONBOARDING' && {
              completedAt: new Date().toISOString(),
            }),
          };
          const prefix = plgRecordCount > 0 ? ',\n' : '';
          appendFileSync(plgRecordsFile, `${prefix}${JSON.stringify(plgRecord, null, 2)}`, 'utf-8');
          plgRecordCount += 1;
        }
      } else {
        failed += 1;
      }
    } catch (error) {
      log.error(`Unexpected error for ${domain}: ${error.message}`);
      failed += 1;
    }
  }

  // Close PLG records JSON array
  appendFileSync(plgRecordsFile, '\n]\n', 'utf-8');
  log.info(`\nWrote ${plgRecordCount} PLG record(s) to ${plgRecordsFile}`);

  log.info(`\nDone. Succeeded: ${succeeded}, Failed: ${failed}`);
  log.info(`CSV report: ${csvFilePath}`);
  log.info(`Log file: ${logFilePath}`);
  log.info(`PLG records file: ${plgRecordsFile}`);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Fatal error:', error);
  process.exit(1);
});
