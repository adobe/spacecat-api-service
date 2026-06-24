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

import { hasText } from '@adobe/spacecat-shared-utils';

/**
 * Derives the bare hostname from a URL or host string, tolerating a missing
 * scheme (bare hostnames). Returns null for empty/unparseable input.
 *
 * Single source of truth for brand → Semrush project domain derivation. Both
 * the direct brand-create path (`brandDomainFromPayload` in the brands
 * controller) and the deferred-activation path (the serenity activate flow)
 * call it, so a draft brand resolves to the same domain at activation as it
 * would at create — keeping the two paths from diverging (e.g. one gaining
 * `www.` stripping or punycode normalization without the other).
 *
 * @param {string} value - a URL or bare hostname
 * @returns {string|null} the hostname, or null when absent/unparseable
 */
export function hostnameFromUrlString(value) {
  if (!hasText(value)) {
    return null;
  }
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    return url.hostname || null;
  } catch {
    return null;
  }
}

/**
 * True when `hostname` is a routable PUBLIC domain name — i.e. NOT a loopback,
 * link-local, private, single-label, IP-literal, or reserved-TLD host.
 *
 * Guards the side-effect Site-creation paths (e.g. `ensureMarketSite`): a market
 * domain becomes a SpaceCat Site `base_url`, and downstream workers fetch/scrape
 * Sites — so an attacker-influenced internal hostname (`localhost`,
 * `169.254.169.254`, an RFC1918 address, `*.internal`) would be an SSRF primitive.
 * `Site.create`'s `isValidUrl` only checks the scheme, so this is the host gate.
 * Conservative by design: it rejects only clearly-non-public hosts and never a
 * legitimate registrable domain (e.g. `example.com`, `www.acme.co.uk`).
 *
 * @param {string} hostname - a bare hostname (as returned by hostnameFromUrlString)
 * @returns {boolean} true when the host is a public domain name
 */
export function isPublicHostname(hostname) {
  if (!hasText(hostname)) {
    return false;
  }
  const host = hostname.toLowerCase().trim().replace(/\.$/, '');
  // localhost (and any *.localhost) is never public.
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return false;
  }
  // IPv6 literal (a hostname containing ':') — we mirror domains, not IPs.
  if (host.includes(':')) {
    return false;
  }
  // IPv4 literal — rejects loopback/link-local/RFC1918 numeric addresses outright.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return false;
  }
  // Must be a dotted domain. A bare single label ("intranet", "metadata") is
  // never a public site.
  if (!host.includes('.')) {
    return false;
  }
  // Reserved / internal-use TLDs (RFC 6761 + the common `.internal`/`.local`).
  if (/\.(local|internal|localdomain|intranet|home|corp|lan|test|invalid|example|localhost)$/.test(host)) {
    return false;
  }
  return true;
}
