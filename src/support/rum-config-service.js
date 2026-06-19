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

import { resolveRumDomainKey } from '@adobe/spacecat-shared-rum-api-client';
import { Config } from '@adobe/spacecat-shared-data-access/src/models/site/config.js';

/**
 * Checks whether the site has a RUM domain key and optionally persists the result.
 *
 * Candidate resolution and timeout logic live in the shared
 * {@link resolveRumDomainKey} helper; this function owns only the save semantics.
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
  let hasDomainKey = false;
  try {
    ({ hasDomainKey } = await resolveRumDomainKey(site, context));
  } catch (e) {
    context.log.warn(`[rum-config-service] resolveRumDomainKey failed: ${e.message}`);
  }

  if (save) {
    const siteConfig = site.getConfig();
    siteConfig.updateRumConfig(hasDomainKey);
    site.setConfig(Config.toDynamoItem(siteConfig));
    await site.save();
  }

  return hasDomainKey;
}
