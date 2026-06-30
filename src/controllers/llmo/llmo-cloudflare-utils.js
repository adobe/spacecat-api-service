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

import { getDomain } from 'tldts';

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
 * The registrable domain ("apex") of a hostname, resolved via the Public Suffix List (tldts), so
 * multi-part TLDs are handled correctly: "www.shop.example.com" -> "example.com",
 * "shop.example.co.uk" -> "example.co.uk", "example.com" -> "example.com". Returns null when the
 * host has no registrable domain under the PSL (e.g. "localhost", a bare TLD, or an IP address).
 */
export const registrableDomain = (host) => getDomain(host);

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

/**
 * The host glob of a route pattern: scheme stripped, path removed, lowercased, with any leading
 * "*." wildcard label preserved (e.g. "https://*.example.com/a/*" -> "*.example.com",
 * "example.com/*" -> "example.com"). Unlike routePatternHost, this keeps the wildcard so callers
 * can reason about which hostnames the route actually matches.
 */
export const routePatternHostGlob = (pattern) => pattern
  .replace(/^https?:\/\//i, '')
  .split('/')[0]
  .toLowerCase();

/**
 * Whether two strings containing `*` wildcards can match a common string — i.e. their match-sets
 * intersect. Each `*` matches zero or more of any character, matching Cloudflare's route-pattern
 * operator ("The only supported operator is the wildcard (*), which matches zero or more of any
 * character"). Memoized O(|a|·|b|) two-pattern intersection.
 */
export const globsIntersect = (a, b) => {
  const memo = new Map();
  const visit = (i, j) => {
    const key = i * (b.length + 1) + j;
    if (memo.has(key)) {
      return memo.get(key);
    }
    let res;
    if (i === a.length && j === b.length) {
      res = true;
    } else if (i < a.length && a[i] === '*') {
      // `*` matches the empty string (advance a) or one more character also produced by b.
      res = visit(i + 1, j) || (j < b.length && visit(i, j + 1));
    } else if (j < b.length && b[j] === '*') {
      res = visit(i, j + 1) || (i < a.length && visit(i + 1, j));
    } else if (i < a.length && j < b.length && a[i] === b[j]) {
      res = visit(i + 1, j + 1);
    } else {
      res = false;
    }
    memo.set(key, res);
    return res;
  };
  return visit(0, 0);
};

/**
 * Whether the HOST globs of two Cloudflare route patterns can match a common hostname — i.e. the
 * two routes could serve the same host (regardless of path). Only the host portion is compared
 * (the path is intentionally ignored): a route sharing the host affects that host's routing for
 * the paths it covers, and we treat any host overlap as a conflict. A Cloudflare hostname wildcard
 * never crosses the `/` into the path, so taking the host segment and glob-intersecting is exact.
 *
 * This is the generic form — no special-casing of wildcard position:
 *  - `*.example.com` (literal dot) forces a subdomain, so it never matches the apex `example.com`;
 *  - the broader `*example.com` (bare `*`) also matches the apex and look-alikes;
 *  - `*.example.com` matches a concrete subdomain like `a.example.com`.
 */
export const routePatternsOverlap = (patternA, patternB) => globsIntersect(
  routePatternHostGlob(patternA),
  routePatternHostGlob(patternB),
);
