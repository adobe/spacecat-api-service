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

import LaunchDarklyClient from '@adobe/spacecat-shared-launchdarkly-client';

const LD_FF_PROJECT_NAME = 'experience-success-studio';
const LD_API_TOKEN_ENV_VAR = 'LD_EXPERIENCE_SUCCESS_API_TOKEN';
export const LD_AUTO_FIX_FLAGS = [
  'FF_cwv-auto-fix',
  'FF_alt-text-auto-fix',
  'FF_broken-backlinks-auto-fix',
];

/**
 * Upserts a single LaunchDarkly flag's variation 0 to include the org + site.
 * Variation 0 value is a JSON object: { [imsOrgId]: [siteIds] }.
 *
 * NOTE: This function performs a read-modify-write on the flag variation without
 * locking. Two concurrent onboardings could overwrite each other's addition. The
 * idempotent check makes this self-healing on retry, but a missed write will not
 * be detected automatically.
 */
async function upsertLdFlag(ldClient, flagKey, imsOrgId, siteId, log) {
  const flag = await ldClient.getFeatureFlag(LD_FF_PROJECT_NAME, flagKey);
  const rawValue = flag.variations?.[0]?.value;

  if (rawValue === undefined) {
    log.warn(`LaunchDarkly flag ${flagKey} has no variations`);
    return;
  }

  const isStringWrapped = typeof rawValue === 'string';
  let parsed;
  try {
    parsed = isStringWrapped ? JSON.parse(rawValue) : rawValue;
  } catch (e) {
    log.warn(`LaunchDarkly flag ${flagKey} has malformed JSON in variation 0, skipping: ${e.message}`);
    return;
  }

  const existingSites = parsed[imsOrgId] ?? [];
  if (existingSites.includes(siteId)) {
    log.info(`LaunchDarkly: site ${siteId} already in ${flagKey} for org ${imsOrgId}`);
    return;
  }

  const merged = { ...parsed, [imsOrgId]: [...existingSites, siteId] };
  const newValue = isStringWrapped ? JSON.stringify(merged) : merged;

  await ldClient.updateVariationValue(
    LD_FF_PROJECT_NAME,
    flagKey,
    0,
    newValue,
    `plg-onboarding: enable ${flagKey} for ${imsOrgId} / ${siteId}`,
  );

  log.info(`LaunchDarkly: enabled ${flagKey} for org ${imsOrgId}, site ${siteId}`);
}

/**
 * Enables all PLG auto-fix LaunchDarkly feature flags for the given site's org.
 * Uses the experience-success-studio project token (LD_EXPERIENCE_SUCCESS_API_TOKEN).
 * Each flag update is non-fatal — onboarding continues even if one fails.
 *
 * Takes the target organization explicitly (resolved upstream from the request's imsOrgId)
 * rather than re-deriving it from site.getOrganizationId(). An earlier production incident
 * flipped flags under the wrong IMS org id because the in-memory site still reported its
 * pre-reassignment (internal) org after save.
 */
export async function updateLaunchDarklyFlags(site, organization, context) {
  const { log, env } = context;
  const LaunchDarklyCtor = context.LaunchDarklyClient || LaunchDarklyClient;

  const apiToken = env[LD_API_TOKEN_ENV_VAR];
  if (!apiToken) {
    log.warn(`Cannot update LaunchDarkly flags: ${LD_API_TOKEN_ENV_VAR} is not set`);
    return;
  }

  const ldClient = new LaunchDarklyCtor({ apiToken }, log);
  const imsOrgId = organization?.getImsOrgId?.();

  if (!imsOrgId) {
    log.warn(`Cannot update LaunchDarkly flags: no IMS org ID for site ${site.getId()}`);
    return;
  }

  const siteId = site.getId();
  const results = await Promise.allSettled(
    LD_AUTO_FIX_FLAGS.map((flagKey) => upsertLdFlag(ldClient, flagKey, imsOrgId, siteId, log)),
  );

  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      log.error(`Failed to update LaunchDarkly flag ${LD_AUTO_FIX_FLAGS[i]}: ${result.reason?.message}`);
    }
  });
}
