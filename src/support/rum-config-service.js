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
 * Tries candidates in priority order (override-first, www variants as fallback) and
 * stops on the first successful domain key lookup. The 3 s timeout is a shared budget
 * across the full candidate loop, not a per-domain limit.
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

  const siteConfig = site.getConfig();
  const overrideBaseURL = siteConfig.getFetchConfig()?.overrideBaseURL;

  let overrideHostname = null;
  if (overrideBaseURL) {
    try {
      overrideHostname = new URL(overrideBaseURL).hostname;
    } catch {
      log.warn(`[rum-config-service] Malformed overrideBaseURL for site ${site.getId()}: ${overrideBaseURL}, falling back to baseURL`);
    }
  }

  const baseHostname = new URL(site.getBaseURL()).hostname;
  const withWwwFallback = (d) => (d && !d.startsWith('www.') ? `www.${d}` : null);

  const domains = [...new Set([
    overrideHostname,
    withWwwFallback(overrideHostname),
    baseHostname,
    withWwwFallback(baseHostname),
  ].filter(Boolean))];

  let hasDomainKey = false;
  let timeoutId;
  let cancelled = false;

  const rumApiClient = RUMAPIClient.createFrom(context);

  try {
    await Promise.race([
      (async () => {
        for (const domain of domains) {
          if (cancelled) {
            break;
          }
          try {
            // eslint-disable-next-line no-await-in-loop
            await rumApiClient.retrieveDomainkey(domain);
            hasDomainKey = true;
            return;
          } catch (e) {
            log.info(`[rum-config-service] RUM check failed for ${domain}: ${e.message}`);
          }
        }
        if (!hasDomainKey) {
          log.warn(`[rum-config-service] No domain key found across all candidates: ${domains.join(', ')}`);
        }
      })(),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          cancelled = true;
          reject(new Error('RUM check timed out'));
        }, RUM_CHECK_TIMEOUT_MS);
      }),
    ]);
  } catch (e) {
    log.warn(`[rum-config-service] RUM check failed: ${e.message}`);
  } finally {
    clearTimeout(timeoutId);
  }

  if (save) {
    siteConfig.updateRumConfig(hasDomainKey);
    site.setConfig(Config.toDynamoItem(siteConfig));
    await site.save();
  }

  return hasDomainKey;
}
