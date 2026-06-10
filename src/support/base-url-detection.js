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

import { Config } from '@adobe/spacecat-shared-data-access/src/models/site/config.js';
import { hasText, tracingFetch as fetch } from '@adobe/spacecat-shared-utils';
import URI from 'urijs';

const BASE_URL_PROBE_TIMEOUT_MS = 5000;

async function isUrlReachable(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), BASE_URL_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(url, { method: 'HEAD', signal: controller.signal });
    clearTimeout(timeoutId);
    return response.ok;
    /* c8 ignore next 4 */
  } catch {
    clearTimeout(timeoutId);
    return false;
  }
}

/**
 * Auto-detects whether the site's baseURL is unreachable but the www-toggled
 * variant is reachable (or vice versa). If so, persists overrideBaseURL on the
 * site's fetchConfig so all audit types use the correct domain.
 *
 * Handles cases like dupont.com where the apex domain has no HTTPS listener
 * but www.dupont.com works, or vice versa.
 *
 * No-ops when overrideBaseURL is already set, or when the site already uses a
 * non-www subdomain (blog.example.com), since toggling does not apply there.
 *
 * @param {object} site - Site model instance.
 * @param {object} context - Request/worker context (provides log).
 * @returns {Promise<void>}
 */
export async function autoDetectOverrideBaseURL(site, context) {
  const { log } = context;

  if (site.getConfig()?.getFetchConfig?.()?.overrideBaseURL) {
    return;
  }

  const baseURL = site.getBaseURL();
  let hostname;
  try {
    hostname = new URL(baseURL).hostname;
  } catch {
    /* c8 ignore next */
    return;
  }

  const uri = new URI(baseURL);
  const subdomain = uri.subdomain();
  if (hasText(subdomain) && subdomain !== 'www') {
    return;
  }

  if (await isUrlReachable(baseURL)) {
    return;
  }

  const toggledHostname = hostname.startsWith('www.') ? hostname.slice(4) : `www.${hostname}`;
  const { protocol } = new URL(baseURL);
  const toggledURL = `${protocol}//${toggledHostname}`;

  if (!(await isUrlReachable(toggledURL))) {
    /* c8 ignore next */
    log.warn(`[auto-detect-base-url] neither ${baseURL} nor ${toggledURL} reachable for siteId=${site.getId?.()}`);
    return;
  }

  log.warn(`[auto-detect-base-url] ${baseURL} unreachable, ${toggledURL} reachable — setting overrideBaseURL for siteId=${site.getId?.()}`);
  const siteConfig = site.getConfig();
  const existingFetchConfig = siteConfig.getFetchConfig() || {};
  siteConfig.updateFetchConfig({ ...existingFetchConfig, overrideBaseURL: toggledURL });
  site.setConfig(Config.toDynamoItem(siteConfig));
  await site.save();
}
