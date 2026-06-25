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
 * Pure, controller-independent helpers for the LLMO Cloudflare onboarding endpoints
 * (see llmo-cloudflare.js). Kept here so the controller stays minimal and these can be
 * unit-tested in isolation.
 */

const WORKER_NAME_PREFIX = 'edge-optimize-router';
const CF_MAX_SCRIPT_NAME_LEN = 63; // Cloudflare worker script name max length

/**
 * Derives the Edge Optimize worker name from a site's base URL: the canonical host (leading
 * "www." removed) with every run of non-alphanumeric characters collapsed to a single hyphen,
 * prefixed and length-capped, e.g. https://www.example.com -> edge-optimize-router-example-com.
 * Cloudflare worker names must match ^[a-z0-9][a-z0-9-]{0,62}$ (no dots), which this guarantees.
 * @returns {string|null} the worker name, or null when the host yields no usable slug
 */
export const deriveWorkerName = (baseURL) => {
  const host = new URL(baseURL).hostname.replace(/^www\./i, '');
  const slug = host.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) {
    return null;
  }
  return `${WORKER_NAME_PREFIX}-${slug}`.slice(0, CF_MAX_SCRIPT_NAME_LEN).replace(/-+$/g, '');
};

/**
 * Whether `host` belongs to the onboarded site's domain: it must equal the site's canonical
 * host (base URL host minus leading "www.") or be a subdomain of it. Prevents pointing the
 * worker / a route at a host unrelated to the site being onboarded.
 */
export const hostInSiteDomain = (host, baseURL) => {
  const siteHost = new URL(baseURL).hostname.replace(/^www\./i, '').toLowerCase();
  const h = host.toLowerCase();
  return h === siteHost || h.endsWith(`.${siteHost}`);
};

/**
 * Extracts the host from a Cloudflare route pattern (e.g. "*.example.com/path*" -> "example.com",
 * "https://www.example.com/*" -> "www.example.com"), stripping any scheme and leading wildcard.
 */
export const routePatternHost = (pattern) => pattern
  .replace(/^https?:\/\//i, '')
  .split('/')[0]
  .replace(/^\*\.?/, '');
