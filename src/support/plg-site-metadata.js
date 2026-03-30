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

import { parse } from 'node-html-parser';
import { tracingFetch } from '@adobe/spacecat-shared-utils';

export const PLG_META_TITLE_MAX = 512;
export const PLG_META_DESCRIPTION_MAX = 1024;
export const PLG_HTML_FETCH_MAX_BYTES = 524288;

/**
 * @param {string|null|undefined} raw
 * @param {number} maxLen
 * @returns {string|null}
 */
export function normalizeMetaField(raw, maxLen) {
  if (raw == null || typeof raw !== 'string') return null;
  const stripped = raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!stripped) return null;
  return stripped.length > maxLen ? stripped.slice(0, maxLen) : stripped;
}

/**
 * @param {string} html
 * @returns {{ title: string|null, description: string|null }}
 */
export function extractSiteMetadataFromHtml(html) {
  if (!html || typeof html !== 'string') {
    return { title: null, description: null };
  }
  try {
    const root = parse(html, { lowerCaseTagName: true });
    const titleEl = root.querySelector('title');
    let title = titleEl?.text?.trim().replace(/\s+/g, ' ') || null;
    const ogTitle = root.querySelector('meta[property="og:title"]')?.getAttribute('content');
    if (!title && ogTitle) {
      title = ogTitle.trim().replace(/\s+/g, ' ');
    }
    let description = root.querySelector('meta[name="description"]')?.getAttribute('content') || null;
    const ogDesc = root.querySelector('meta[property="og:description"]')?.getAttribute('content');
    if (!description && ogDesc) {
      description = ogDesc.trim();
    } else if (description) {
      description = description.trim();
    }
    return {
      title: normalizeMetaField(title, PLG_META_TITLE_MAX),
      description: normalizeMetaField(description, PLG_META_DESCRIPTION_MAX),
    };
  } catch {
    return { title: null, description: null };
  }
}

/**
 * @param {{ getBaseURL: function, getConfig?: function }} site
 * @returns {string}
 */
export function getPlgMetadataFetchUrl(site) {
  const siteConfig = typeof site.getConfig === 'function' ? site.getConfig() : null;
  const fetchCfg = siteConfig && typeof siteConfig.getFetchConfig === 'function'
    ? siteConfig.getFetchConfig()
    : {};
  const override = fetchCfg?.overrideBaseURL;
  if (override && typeof override === 'string') return override;
  return site.getBaseURL();
}

/**
 * @param {string} pageUrl
 * @param {{ warn: function }} log
 * @returns {Promise<string|null>}
 */
export async function fetchPlgHomepageHtml(pageUrl, log) {
  try {
    const response = await tracingFetch(pageUrl, {
      timeout: 8000,
      headers: { Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
    });
    if (!response.ok) return null;
    const buf = await response.arrayBuffer();
    const slice = buf.byteLength > PLG_HTML_FETCH_MAX_BYTES
      ? buf.slice(0, PLG_HTML_FETCH_MAX_BYTES)
      : buf;
    return new TextDecoder('utf-8', { fatal: false }).decode(slice);
  } catch (e) {
    log?.warn?.(`PLG homepage fetch for metadata failed: ${e.message}`);
    return null;
  }
}

/**
 * Optional Helix / sheet JSON: array of { domain, siteTitle, siteDescription }
 * or { items: [...] }. Domain match is case-insensitive.
 *
 * @param {object} env
 * @param {string} domain
 * @param {{ warn: function }} log
 * @returns {Promise<{ siteTitle: string|null, siteDescription: string|null }|null>}
 */
export async function loadPlgSiteMetadataOverrides(env, domain, log) {
  const url = env?.PLG_SITE_METADATA_SHEET_URL;
  if (!url || typeof url !== 'string') return null;
  try {
    const response = await tracingFetch(url, { timeout: 8000 });
    if (!response.ok) return null;
    const data = await response.json();
    const rows = Array.isArray(data) ? data : data?.items;
    if (!Array.isArray(rows)) return null;
    const norm = domain.trim().toLowerCase();
    const row = rows.find((r) => String(r?.domain ?? '').trim().toLowerCase() === norm);
    if (!row) return null;
    const siteTitle = row.siteTitle ?? row.site_title ?? null;
    const siteDescription = row.siteDescription ?? row.site_description ?? null;
    return {
      siteTitle: typeof siteTitle === 'string' ? siteTitle.trim() || null : null,
      siteDescription: typeof siteDescription === 'string' ? siteDescription.trim() || null : null,
    };
  } catch (e) {
    log?.warn?.(`PLG_SITE_METADATA_SHEET_URL fetch failed: ${e.message}`);
    return null;
  }
}

/**
 * @param {object} params
 * @param {object} params.onboarding — setSiteTitle / setSiteDescription / save
 * @param {object} params.site — getBaseURL / getConfig
 * @param {string} params.domain
 * @param {object} params.env
 * @param {{ warn: function }} params.log
 */
export async function enrichPlgOnboardingWithSiteMetadata({
  onboarding, site, domain, env, log,
}) {
  try {
    const helix = await loadPlgSiteMetadataOverrides(env, domain, log);
    let title = normalizeMetaField(helix?.siteTitle ?? null, PLG_META_TITLE_MAX);
    let description = normalizeMetaField(helix?.siteDescription ?? null, PLG_META_DESCRIPTION_MAX);

    if (!title || !description) {
      const pageUrl = getPlgMetadataFetchUrl(site);
      const html = await fetchPlgHomepageHtml(pageUrl, log);
      const extracted = html
        ? extractSiteMetadataFromHtml(html)
        : { title: null, description: null };
      if (!title) title = extracted.title;
      if (!description) description = extracted.description;
    }

    let didSet = false;
    if (title) {
      onboarding.setSiteTitle(title);
      didSet = true;
    }
    if (description) {
      onboarding.setSiteDescription(description);
      didSet = true;
    }
    if (didSet) await onboarding.save();
  } catch (e) {
    log.warn(`PLG site metadata enrichment failed: ${e.message}`);
  }
}
