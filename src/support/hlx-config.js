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

import {
  isObject,
  isValidUrl,
  tracingFetch as fetch,
} from '@adobe/spacecat-shared-utils';
import yaml from 'js-yaml';

/**
 * Parses a domain string for the HLX RSO pattern: ref--site--owner.(hlx.live|aem.live)
 * @param {string} domain - The domain to parse.
 * @returns {object|null} - Parsed RSO object or null if no match.
 */
export function parseHlxRSO(domain) {
  const regex = /^([\w-]+)--([\w-]+)--([\w-]+)\.(hlx\.live|aem\.live)$/;
  const match = domain.match(regex);

  if (!match) {
    return null;
  }

  return {
    ref: match[1],
    site: match[2],
    owner: match[3],
    tld: match[4],
  };
}

/**
 * Fetches the aggregated HLX config from admin.hlx.page for the given owner/site.
 * Returns the config object containing cdn, code, and content, or null if not found.
 * @param {object} hlxConfig - The hlx config object with rso.owner and rso.site.
 * @param {string} hlxAdminToken - The HLX admin API token.
 * @param {object} log - The logger object.
 * @returns {Promise<object|null>} - The config from admin API, or null.
 */
export async function fetchHlxConfig(hlxConfig, hlxAdminToken, log) {
  const { hlxVersion, rso } = hlxConfig;

  if (hlxVersion < 5) {
    log.info(`HLX version is ${hlxVersion}. Skipping fetching hlx config`);
    return null;
  }

  const { owner, site } = rso;
  const url = `https://admin.hlx.page/config/${owner}/aggregated/${site}.json`;

  try {
    const response = await fetch(url, {
      headers: { Authorization: `token ${hlxAdminToken}` },
    });

    if (response.status === 200) {
      return response.json();
    }

    if (response.status === 404) {
      log.debug(`No hlx config found for ${owner}/${site}`);
      return null;
    }

    log.error(`Error fetching hlx config for ${owner}/${site}. Status: ${response.status}. Error: ${response.headers.get('x-error')}`);
  } catch (e) {
    log.error(`Error fetching hlx config for ${owner}/${site}`, e);
  }

  return null;
}

/**
 * Fetches the content source from fstab.yaml in the GitHub repository.
 * @param {object} hlxConfig - The hlx config object with rso.ref, rso.site, rso.owner.
 * @param {object} log - The logger object.
 * @returns {Promise<object|null>} - Content source object or null.
 */
export async function getContentSource(hlxConfig, log) {
  const { ref, site: repo, owner } = hlxConfig.rso;

  const fstabResponse = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/fstab.yaml`);

  if (fstabResponse.status !== 200) {
    log.error(`Error fetching fstab.yaml for ${owner}/${repo}. Status: ${fstabResponse.status}`);
    return null;
  }

  const fstabContent = await fstabResponse.text();
  const parsedContent = yaml.load(fstabContent);

  const url = parsedContent?.mountpoints
    ? Object.entries(parsedContent.mountpoints)?.[0]?.[1]
    : null;

  if (!isValidUrl(url)) {
    log.debug(`No content source found for ${owner}/${repo} in fstab.yaml`);
    return null;
  }

  const type = url.includes('drive.google') ? 'drive.google' : 'onedrive';
  return { source: { type, url } };
}

/**
 * Resolves the full HLX config and code object from a GitHub repository URL.
 *
 * Calls admin.hlx.page to fetch cdn, code, and content config. Falls back to
 * reading fstab.yaml from GitHub for content source if the admin API returns nothing.
 *
 * @param {string} gitHubURL - GitHub repository URL (e.g. https://github.com/owner/repo).
 * @param {string} hlxAdminToken - The HLX admin API token.
 * @param {object} log - The logger object.
 * @returns {Promise<{hlxConfig: object, code: object}>} - Resolved hlxConfig and code.
 */
export async function resolveHlxConfigFromGitHubURL(gitHubURL, hlxAdminToken, log) {
  const parsedUrl = new URL(gitHubURL);
  const pathParts = parsedUrl.pathname.split('/').filter(Boolean);
  const owner = pathParts[0];
  const repo = pathParts[1];

  const hlxConfig = {
    hlxVersion: 5,
    rso: { owner, site: repo, ref: 'main' },
  };

  // Fetch full config from admin.hlx.page
  const adminConfig = await fetchHlxConfig(hlxConfig, hlxAdminToken, log);
  if (isObject(adminConfig)) {
    const { cdn, code, content } = adminConfig;
    if (isObject(cdn)) {
      hlxConfig.cdn = cdn;
      // If CDN prod host is available, derive full rso with tld
      if (cdn.prod?.host) {
        const rso = parseHlxRSO(cdn.prod.host);
        if (rso) {
          hlxConfig.rso = rso;
        }
      }
    }
    if (isObject(code)) {
      hlxConfig.code = code;
    }
    if (isObject(content)) {
      hlxConfig.content = content;
    }
  } else {
    // Fallback: read fstab.yaml for content source
    try {
      const content = await getContentSource(hlxConfig, log);
      if (isObject(content)) {
        hlxConfig.content = content;
      }
    } catch (e) {
      log.error(`Error fetching fstab.yaml for ${owner}/${repo}: ${e.message}`);
    }
  }

  const code = {
    type: 'github',
    owner,
    repo,
    ref: 'main',
    url: gitHubURL,
  };

  return { hlxConfig, code };
}
