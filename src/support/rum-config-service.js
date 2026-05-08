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

import RUMAPIClient from '@adobe/spacecat-shared-rum-api-client';

const RUM_CHECK_TIMEOUT_MS = 3000;

/**
 * Checks whether the site has a RUM domain key and persists the result in
 * site.config.rumConfig. Callers that already call site.save() themselves
 * (e.g. onboardSingleSite) should pass { save: false } to avoid a double-save.
 *
 * @param {object} site - Site model instance.
 * @param {object} context - Request/worker context (provides env, log).
 * @param {{ save?: boolean }} [options]
 * @returns {Promise<boolean>} true if a domain key was found.
 */
export async function updateRumConfig(site, context, { save = true } = {}) {
  const { log } = context;
  const domain = site.getBaseURL().replace(/^https?:\/\//, '');

  let hasDomainKey = false;
  try {
    const rumApiClient = RUMAPIClient.createFrom(context);
    await Promise.race([
      rumApiClient.retrieveDomainkey(domain),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('RUM check timed out')), RUM_CHECK_TIMEOUT_MS);
      }),
    ]);
    hasDomainKey = true;
  } catch (e) {
    log.warn(`[rum-config-service] RUM check failed for ${domain}: ${e.message}`);
  }

  site.getConfig().updateRumConfig(hasDomainKey);

  if (save) {
    await site.save();
  }

  return hasDomainKey;
}
