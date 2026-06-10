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
import { Config } from '@adobe/spacecat-shared-data-access/src/models/site/config.js';

const RUM_CHECK_TIMEOUT_MS = 3000;

/**
 * Checks whether the site has a RUM domain key and optionally persists the result.
 *
 * When called with the default { save: true }, this function applies the rumConfig
 * update and saves the site internally.
 *
 * When called with { save: false }, no config mutation or save is performed — the
 * caller must explicitly apply the returned value:
 *
 *   const hasDomainKey = await updateRumConfig(site, context, { save: false });
 *   siteConfig.updateRumConfig(hasDomainKey);
 *   site.setConfig(Config.toDynamoItem(siteConfig));
 *   await site.save();
 *
 * Omitting these steps silently discards the RUM check result.
 *
 * @param {object} site - Site model instance.
 * @param {object} context - Request/worker context (provides env, log).
 * @param {{ save?: boolean }} [options]
 * @returns {Promise<boolean>} true if a RUM domain key was found.
 */
export async function updateRumConfig(site, context, { save = true } = {}) {
  const { log } = context;
  const domain = new URL(site.getBaseURL()).hostname;

  let hasDomainKey = false;
  let timeoutId;

  try {
    const rumApiClient = RUMAPIClient.createFrom(context);
    await Promise.race([
      rumApiClient.retrieveDomainkey(domain),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('RUM check timed out')), RUM_CHECK_TIMEOUT_MS);
      }),
    ]);
    hasDomainKey = true;
  } catch (e) {
    log.warn(`[rum-config-service] RUM check failed for ${domain}: ${e.message}`);
  } finally {
    clearTimeout(timeoutId);
  }

  if (save) {
    const siteConfig = site.getConfig();
    siteConfig.updateRumConfig(hasDomainKey);
    site.setConfig(Config.toDynamoItem(siteConfig));
    await site.save();
  }

  return hasDomainKey;
}
