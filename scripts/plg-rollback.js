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
 * PLG Rollback Script
 *
 * Rolls back a preonboarding by undoing what plg-preonboard.js created,
 * using the steps recorded on the PlgOnboarding record to decide what
 * is safe to remove.
 *
 * Safe to re-run: already-removed resources are skipped gracefully.
 *
 * What gets rolled back (in reverse order):
 *   1. Disable audits + summit-plg via SpaceCat API
 *   2. Delete ASO entitlement (if entitlementCreated)
 *   3. Delete site (only if siteCreated — i.e. created by preonboarding)
 *   4. Delete org (only if it has no remaining sites)
 *   5. Delete PlgOnboarding record
 *
 * Usage:
 *   node scripts/plg-rollback.js <input.json>
 *
 * Input JSON format (same as plg-preonboard.js):
 *   [
 *     { "domain": "example.com", "imsOrgId": "ABC123@AdobeOrg" }
 *   ]
 *
 * Required environment variables:
 *   POSTGREST_URL          - PostgREST base URL
 *   POSTGREST_API_KEY      - PostgREST writer JWT
 *   AWS_REGION             - AWS region
 *   SPACECAT_API_BASE_URL  - SpaceCat API base URL
 *   ADMIN_API_KEY          - Admin API key for SpaceCat API
 */

// eslint-disable-next-line import/no-extraneous-dependencies
import 'dotenv/config';
import { readFileSync } from 'fs';
import { createDataAccess } from '@adobe/spacecat-shared-data-access';
import { Entitlement as EntitlementModel } from '@adobe/spacecat-shared-data-access/src/models/entitlement/index.js';
import TierClient from '@adobe/spacecat-shared-tier-client';
import { composeBaseURL, tracingFetch as fetch } from '@adobe/spacecat-shared-utils';

const ASO_PRODUCT_CODE = EntitlementModel.PRODUCT_CODES.ASO;

const AUDIT_TYPES = ['alt-text', 'cwv', 'broken-backlinks', 'scrape-top-pages'];

const log = {
  info: (...args) => console.log('[INFO]', ...args), // eslint-disable-line no-console
  warn: (...args) => console.warn('[WARN]', ...args), // eslint-disable-line no-console
  error: (...args) => console.error('[ERROR]', ...args), // eslint-disable-line no-console
  debug: () => {},
};

function validateEnv() {
  const required = [
    'POSTGREST_URL', 'POSTGREST_API_KEY', 'AWS_REGION',
    'SPACECAT_API_BASE_URL', 'ADMIN_API_KEY',
  ];
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
    env: {},
  };
}

async function disableAuditsAndPlg(baseURL) {
  const apiUrl = process.env.SPACECAT_API_BASE_URL;
  const apiKey = process.env.ADMIN_API_KEY;

  // Disable profile audits
  try {
    const payload = AUDIT_TYPES.map((auditType) => ({ baseURL, auditType, enable: false }));
    const resp = await fetch(`${apiUrl}/configurations/sites/audits`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      log.warn(`  Failed to disable audits: ${resp.status}`);
    } else {
      log.info(`  Disabled audits: ${AUDIT_TYPES.join(', ')}`);
    }
  } catch (error) {
    log.warn(`  Error disabling audits: ${error.message}`);
  }

  // Disable summit-plg
  try {
    const resp = await fetch(`${apiUrl}/configurations/sites/audits`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify([{ baseURL, auditType: 'summit-plg', enable: false }]),
    });
    if (!resp.ok) {
      log.warn(`  Failed to disable summit-plg: ${resp.status}`);
    } else {
      log.info('  Disabled summit-plg');
    }
  } catch (error) {
    log.warn(`  Error disabling summit-plg: ${error.message}`);
  }
}

async function deleteEntitlement(organization, context) {
  try {
    const tierClient = TierClient.createForOrg(context, organization, ASO_PRODUCT_CODE);
    const entitlements = await tierClient.getEntitlements();
    const aso = entitlements?.find((e) => e.getProductCode() === ASO_PRODUCT_CODE);
    if (!aso) {
      log.info('  No ASO entitlement found, skipping');
      return;
    }
    await aso.remove();
    log.info(`  Deleted ASO entitlement ${aso.getId()}`);
  } catch (error) {
    log.warn(`  Failed to delete ASO entitlement: ${error.message}`);
  }
}

async function rollbackDomain({ domain, imsOrgId }, context) {
  const { dataAccess: da } = context;
  const { PlgOnboarding, Site, Organization } = da;

  const baseURL = composeBaseURL(domain);
  log.info(`\nRolling back: ${domain} (${imsOrgId}), baseURL: ${baseURL}`);

  const onboarding = await PlgOnboarding.findByImsOrgIdAndDomain(imsOrgId, domain);
  if (!onboarding) {
    log.info('  No PlgOnboarding record found, nothing to roll back');
    return { domain, status: 'skipped', reason: 'no record found' };
  }

  const steps = onboarding.getSteps() || {};
  const siteId = onboarding.getSiteId();
  const organizationId = onboarding.getOrganizationId();
  log.info(`  PlgOnboarding ${onboarding.getId()} | status: ${onboarding.getStatus()} | steps: ${JSON.stringify(steps)}`);

  // Step 1: Disable audits + summit-plg via API
  if (steps.auditsEnabled) {
    await disableAuditsAndPlg(baseURL);
  } else {
    log.info('  Audits were not enabled, skipping disable');
  }

  // Step 2: Delete ASO entitlement
  if (steps.entitlementCreated && organizationId) {
    const organization = await Organization.findById(organizationId);
    if (organization) {
      await deleteEntitlement(organization, context);
    } else {
      log.warn(`  Org ${organizationId} not found, skipping entitlement delete`);
    }
  } else {
    log.info('  Entitlement was not created, skipping delete');
  }

  // Step 3: Delete site (only if created by preonboarding)
  if (steps.siteCreated && siteId) {
    try {
      const site = await Site.findById(siteId);
      if (site) {
        await site.remove();
        log.info(`  Deleted site ${siteId}`);
      } else {
        log.info(`  Site ${siteId} not found, already deleted`);
      }
    } catch (error) {
      log.warn(`  Failed to delete site ${siteId}: ${error.message}`);
    }
  } else if (siteId) {
    log.info(`  Site ${siteId} was pre-existing, not deleting`);
  }

  // Step 4: Delete org only if it has no remaining sites
  if (organizationId) {
    try {
      const organization = await Organization.findById(organizationId);
      if (organization) {
        const sites = await Site.allByOrganizationId(organizationId);
        if (sites.length === 0) {
          await organization.remove();
          log.info(`  Deleted org ${organizationId} (no remaining sites)`);
        } else {
          log.info(`  Org ${organizationId} has ${sites.length} remaining site(s), not deleting`);
        }
      } else {
        log.info(`  Org ${organizationId} not found, already deleted`);
      }
    } catch (error) {
      log.warn(`  Failed to check/delete org ${organizationId}: ${error.message}`);
    }
  }

  // Step 5: Delete PlgOnboarding record
  try {
    await onboarding.remove();
    log.info(`  Deleted PlgOnboarding record ${onboarding.getId()}`);
  } catch (error) {
    log.warn(`  Failed to delete PlgOnboarding record: ${error.message}`);
  }

  log.info('  Rollback complete');
  return {
    domain,
    status: 'rolled back',
    siteId: siteId || '',
    organizationId: organizationId || '',
  };
}

async function main() {
  const inputFile = process.argv[2];
  if (!inputFile) {
    console.error('Usage: node scripts/plg-rollback.js <input.json>'); // eslint-disable-line no-console
    process.exit(1);
  }

  validateEnv();

  const domains = JSON.parse(readFileSync(inputFile, 'utf-8'));
  if (!Array.isArray(domains) || domains.length === 0) {
    console.error('Input must be a non-empty JSON array'); // eslint-disable-line no-console
    process.exit(1);
  }

  log.info(`Rolling back ${domains.length} domain(s)...`);

  const context = await createContext();
  const results = [];

  await Promise.allSettled(
    domains.map(async ({ domain, imsOrgId }) => {
      if (!domain || !imsOrgId) {
        log.error(`Skipping invalid entry: ${JSON.stringify({ domain, imsOrgId })}`);
        return;
      }
      try {
        const result = await rollbackDomain({ domain, imsOrgId }, context);
        if (result) results.push(result);
      } catch (error) {
        log.error(`Unexpected error for ${domain}: ${error.message}`);
      }
    }),
  );

  log.info('\nSummary:');
  results.forEach((r) => log.info(`  ${r.domain}: ${r.status}`));
  log.info('\nDone.');
}

main().catch((error) => {
  console.error('Fatal error:', error); // eslint-disable-line no-console
  process.exit(1);
});
