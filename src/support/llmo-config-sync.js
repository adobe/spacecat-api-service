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

import { hasText, llmoConfig } from '@adobe/spacecat-shared-utils';
import { convertV1ToV2, convertV2ToV1 } from './customer-config-mapper.js';
import { mergeCustomerConfigV2 } from './customer-config-v2-metadata.js';

/**
 * After saving V2 customer config, sync each brand that has a linked site (v1SiteId)
 * to that site's V1 config. Uses the established V1 write path (writeConfig with versioning).
 * Errors for a single site are logged and do not fail the rest.
 *
 * @param {string} spaceCatId - Organization ID (already validated by caller).
 * @param {object} v2Config - The V2 customer config that was just saved.
 * @param {object} options
 * @param {import('@aws-sdk/client-s3').S3Client} options.s3Client - S3 client.
 * @param {string} [options.s3Bucket] - S3 bucket name.
 * @param {object} [options.log] - Logger (info/warn).
 */
export async function syncV2ToV1Sites(spaceCatId, v2Config, options = {}) {
  const { s3Client, s3Bucket, log } = options;
  if (!s3Client) return;

  const brands = v2Config?.customer?.brands || [];
  const linked = brands.filter((b) => hasText(b.v1SiteId));

  const results = await Promise.allSettled(
    linked.map(async (brand) => {
      const siteId = brand.v1SiteId;
      const configForBrand = {
        customer: {
          ...v2Config.customer,
          brands: [brand],
        },
      };
      const v1Config = convertV2ToV1(configForBrand);
      await llmoConfig.writeConfig(siteId, v1Config, s3Client, { s3Bucket });
      if (log) {
        log.info(`Synced V2 customer config to V1 for site ${siteId} (org ${spaceCatId})`);
      }
      return siteId;
    }),
  );

  results.forEach((result, i) => {
    if (result.status === 'rejected' && log) {
      log.warn(`Failed to sync V2 to V1 for site ${linked[i].v1SiteId}: ${result.reason?.message || result.reason}`);
    }
  });
}

/**
 * After saving V1 LLMO config for a site, update the corresponding brand in the org's V2 config.
 * Only runs when the org has a V2 config and a brand linked to this site (v1SiteId or baseUrl).
 *
 * @param {string} siteId - Site ID (already validated by caller).
 * @param {object} v1Config - The V1 LLMO config that was just written.
 * @param {object} options
 * @param {{ Site: object, Organization: object }} options.dataAccess - Site/Org models.
 * @param {import('@aws-sdk/client-s3').S3Client} options.s3Client - S3 client.
 * @param {string} [options.s3Bucket] - S3 bucket name.
 * @param {object} [options.log] - Logger (info/warn).
 * @param {string} [options.userId] - User ID for merge metadata.
 */
export async function syncV1ToV2(siteId, v1Config, options = {}) {
  const {
    dataAccess, s3Client, s3Bucket, log, userId = 'system',
  } = options;
  if (!dataAccess?.Site || !dataAccess?.Organization || !s3Client) return;

  const { Site, Organization } = dataAccess;
  let site;
  try {
    site = await Site.findById(siteId);
  } catch {
    if (log) log.warn(`syncV1ToV2: site not found ${siteId}`);
    return;
  }
  if (!site) return;

  const organizationId = site.getOrganizationId();
  if (!hasText(organizationId)) return;

  let org;
  try {
    org = await Organization.findById(organizationId);
  } catch {
    if (log) log.warn(`syncV1ToV2: organization not found ${organizationId}`);
    return;
  }
  if (!org) return;

  let existingV2;
  try {
    existingV2 = await llmoConfig.readCustomerConfigV2(organizationId, s3Client, { s3Bucket });
  } catch (err) {
    if (log) {
      log.warn(`syncV1ToV2: failed to read V2 config for org ${organizationId}: ${err?.message || err}`);
    }
    return;
  }
  if (!existingV2?.customer?.brands?.length) return;

  const baseUrl = typeof site.getBaseURL === 'function' ? site.getBaseURL() : undefined;
  const existingBrand = existingV2.customer.brands.find((b) => {
    if (b.v1SiteId === siteId) return true;
    return hasText(baseUrl) && b.baseUrl === baseUrl;
  });
  if (!existingBrand) return;

  try {
    const converted = convertV1ToV2(
      v1Config,
      existingBrand.name,
      existingV2.customer.imsOrgID || org.getImsOrgId?.() || '',
    );
    const convertedBrand = converted.customer.brands[0];
    if (!convertedBrand) return;

    const mergedBrand = {
      ...convertedBrand,
      id: existingBrand.id,
      v1SiteId: existingBrand.v1SiteId,
      baseUrl: existingBrand.baseUrl,
    };
    const updates = {
      customer: {
        ...existingV2.customer,
        brands: existingV2.customer.brands.map((b) => (
          b.id === existingBrand.id ? mergedBrand : b
        )),
      },
    };
    const { mergedConfig } = mergeCustomerConfigV2(updates, existingV2, userId);
    await llmoConfig.writeCustomerConfigV2(
      organizationId,
      mergedConfig,
      s3Client,
      { s3Bucket },
    );
    if (log) {
      log.info(
        `Synced V1 LLMO config to V2 for site ${siteId} (org ${organizationId}, brand ${existingBrand.id})`,
      );
    }
  } catch (err) {
    if (log) {
      log.warn(`Failed to sync V1 to V2 for site ${siteId}: ${err?.message || err}`);
    }
  }
}
