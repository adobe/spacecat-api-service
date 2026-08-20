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

import { siteIdentityFromUrlString, stripWWW } from '@adobe/spacecat-shared-utils';

/**
 * URL-scope matching for the Semrush elements read paths (LLMO-7138).
 *
 * A "scope" is a `{host, pathPrefix}` pair naming a section of the web:
 * a whole registered domain (`intuit.com`), one subdomain
 * (`quickbooks.intuit.com`), or a subtree of a domain (`nba.com/kings`).
 * Sites can be anchored at any of these granularities (`sites.base_url`
 * preserves subdomains and paths), while the Semrush cited-domains element
 * reports only registered (eTLD+1) domains — so the drilldown filter has to
 * reconcile a coarse requested key with a potentially finer site anchor.
 *
 * All matching here is case-insensitive: hosts are lowercased by the URL
 * parser, and path prefixes/pathnames are lowercased on extraction (site
 * base URLs are stored lowercased; Semrush `source` URLs may not be).
 *
 * @typedef {object} UrlScope
 * @property {string} host - lowercased, `www.`-stripped hostname.
 * @property {string} pathPrefix - lowercased path with a leading `/` and no
 *   trailing slash, or `''` when the scope covers the whole host.
 */

/**
 * Splits a scope value — a bare host (`quickbooks.intuit.com`), a host+path
 * (`nba.com/kings`), or a full URL — into a {@link UrlScope}. Delegates the
 * tolerant host/path parsing to `siteIdentityFromUrlString` (which lowercases
 * the host, strips a single trailing slash, and returns null for empty or
 * unparseable input), then strips a leading `www.` — the elements fold has
 * always treated `www` and the apex as the same site.
 *
 * @param {string|null|undefined} value
 * @returns {UrlScope|null} the parsed scope, or null when there is none.
 */
export function splitScope(value) {
  const identity = siteIdentityFromUrlString(value);
  if (!identity) {
    return null;
  }
  const slash = identity.indexOf('/');
  const host = stripWWW(slash === -1 ? identity : identity.slice(0, slash));
  if (host === '') {
    return null;
  }
  // Trailing slashes (siteIdentityFromUrlString strips only one) would break
  // the segment-boundary match, so drop them all; a bare '/' degrades to a
  // whole-host scope.
  const pathPrefix = slash === -1 ? '' : identity.slice(slash).toLowerCase().replace(/\/+$/, '');
  return { host, pathPrefix };
}

/**
 * Extracts the `{host, pathname}` of a row's source URL for scope matching:
 * host lowercased and `www.`-stripped, pathname lowercased with trailing
 * slashes trimmed (so `/kings/` and `/kings` agree; the root becomes `''`,
 * mirroring a whole-host scope's `pathPrefix`). Returns null for unparseable
 * values (defensive — Semrush `source` is always a URL).
 *
 * @param {string} url
 * @returns {{host: string, pathname: string}|null}
 */
export function parseCandidateUrl(url) {
  try {
    const parsed = new URL(url);
    const host = stripWWW(parsed.hostname).toLowerCase();
    const pathname = parsed.pathname.toLowerCase().replace(/\/+$/, '');
    return { host, pathname };
  } catch {
    return null;
  }
}

/**
 * True when `candidateHost` is `scopeHost` itself or a subdomain of it.
 *
 * This is the deliberate eTLD+1 fold: the cited-domains element (98b91d00)
 * reports REGISTERED domains (`cambridge.org`), while Stats-per-URL `source`
 * hosts are often subdomains (`dictionary.cambridge.org`) — an exact-host
 * match would drop most (or all) of a domain's URLs. Verified live
 * (2026-07-10): `cambridge.org` → 46 URLs, all under
 * `dictionary.cambridge.org`; exact match would have returned 0. The
 * leading-dot guard prevents `notopenai.com` from matching `openai.com`.
 *
 * @param {string} candidateHost
 * @param {string} scopeHost
 * @returns {boolean}
 */
export function hostMatches(candidateHost, scopeHost) {
  return candidateHost === scopeHost || candidateHost.endsWith(`.${scopeHost}`);
}

/**
 * Segment-boundary path-prefix match: `/kings` matches `/kings` and
 * `/kings/roster`, but not `/kingsx`. An empty prefix (whole-host scope)
 * matches every pathname.
 *
 * @param {string} pathname
 * @param {string} pathPrefix
 * @returns {boolean}
 */
export function isWithinPathPrefix(pathname, pathPrefix) {
  return pathPrefix === '' || pathname === pathPrefix || pathname.startsWith(`${pathPrefix}/`);
}

/**
 * True when a candidate `{host, pathname}` falls inside `scope`: host equal
 * to or a subdomain of the scope host, and pathname within the scope's path
 * prefix.
 *
 * @param {UrlScope} scope
 * @param {{host: string, pathname: string}} candidate
 * @returns {boolean}
 */
export function scopeContains(scope, candidate) {
  return hostMatches(candidate.host, scope.host)
    && isWithinPathPrefix(candidate.pathname, scope.pathPrefix);
}

/**
 * True when `requestedScope` is a strictly broader ancestor of `siteScope`:
 * `intuit.com` is a proper ancestor of `quickbooks.intuit.com`, and `nba.com`
 * of `nba.com/kings` — but a scope is never an ancestor of itself, of a
 * sibling, or of a broader scope.
 *
 * @param {UrlScope} requestedScope
 * @param {UrlScope} siteScope
 * @returns {boolean}
 */
export function isProperAncestor(requestedScope, siteScope) {
  const equal = requestedScope.host === siteScope.host
    && requestedScope.pathPrefix === siteScope.pathPrefix;
  return !equal
    && hostMatches(siteScope.host, requestedScope.host)
    && isWithinPathPrefix(siteScope.pathPrefix, requestedScope.pathPrefix);
}

/**
 * Builds the per-row predicate for one drilldown request, given the site's
 * own scope (from its `base_url`; null when the brand has no primary site or
 * the value is unparseable). The requested-vs-site relationship is resolved
 * once here, not per row — only the candidate varies inside the row loop:
 *
 *  - When the requested scope is a proper ancestor of the site scope
 *    (drilling `intuit.com` for a `quickbooks.intuit.com` site, or `nba.com`
 *    for `nba.com/kings`), rows inside the site's own subtree are EXCLUDED —
 *    the fold covers everything else under the requested domain, and the
 *    site's own URLs are addressable by requesting the site scope itself.
 *  - Otherwise plain containment: the eTLD+1 fold for host-only scopes,
 *    narrowed by the path prefix when the requested scope carries one. A
 *    request for the site's own scope therefore returns exactly the site's
 *    subtree; with no site scope every request behaves as a plain fold.
 *
 * @param {UrlScope} requestedScope - non-null; callers skip filtering when
 *   there is no requested scope.
 * @param {UrlScope|null} siteScope
 * @returns {(candidate: {host: string, pathname: string}) => boolean}
 */
export function createScopeMatcher(requestedScope, siteScope) {
  const excludeScope = siteScope && isProperAncestor(requestedScope, siteScope) ? siteScope : null;
  return (candidate) => scopeContains(requestedScope, candidate)
    && !(excludeScope && scopeContains(excludeScope, candidate));
}
