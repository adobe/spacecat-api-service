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

import { promises as dns } from 'dns';
import { isObject, isValidUrl, tracingFetch as fetch } from '@adobe/spacecat-shared-utils';
import { calculateForwardedHost } from '@adobe/spacecat-shared-tokowaka-client';
import { CDN_TYPES } from '../controllers/llmo/llmo-utils.js';
import {
  AEM_CS_FASTLY_CNAME_PATTERNS,
  AEM_CS_FASTLY_IPS,
  detectAemCsFastlyWafSimpleProxy,
  EDGE_OPTIMIZE_USER_AGENT,
  UA_ROUTING_HEADER,
} from './cdn-detection.js';

// Per-CDN strategies for edge optimize routing.
export const EDGE_OPTIMIZE_CDN_STRATEGIES = {
  [CDN_TYPES.AEM_CS_FASTLY]: {
    buildUrl: (cdnConfig, domain) => {
      const base = cdnConfig.cdnRoutingUrl.trim().replace(/\/+$/, '');
      return `${base}/${domain}/edgeoptimize`;
    },
    buildBody: (enabled) => ({ enabled }),
    method: 'POST',
  },
};

export const SUPPORTED_EDGE_ROUTING_CDN_TYPES = Object.keys(EDGE_OPTIMIZE_CDN_STRATEGIES);

// Import worker job type for edge optimize enabled detection.
// The import worker handler iterates all opted-in sites and stamps edgeOptimizeConfig.enabled
// when Tokowaka confirms the site is serving edge-optimized content.
export const OPTIMIZE_AT_EDGE_ENABLED_MARKING_TYPE = 'optimize-at-edge-enabled-marking';

// Delay (seconds) before triggering the edge-optimize enabled marking job after CDN routing update.
// Gives the CDN API time to propagate before Tokowaka detects the change.
export const EDGE_OPTIMIZE_MARKING_DELAY_SECONDS = 300;

const PROBE_TIMEOUT_MS = 5000;
const CDN_CALL_TIMEOUT_MS = 5000;

/**
 * Strips the leading "www." from a URL's hostname.
 *
 * @param {string} url - The URL to parse (with or without scheme).
 * @param {object} log - Logger.
 * @returns {string} Lowercased hostname without "www." prefix.
 * @throws {Error} If the URL is unparseable.
 */
export function getHostnameWithoutWww(url, log) {
  try {
    const urlObj = new URL(url.startsWith('http') ? url : `https://${url}`);
    let hostname = urlObj.hostname.toLowerCase();
    if (hostname.startsWith('www.')) {
      hostname = hostname.slice(4);
    }
    return hostname;
  } catch (error) {
    log.error(`Error getting hostname from URL ${url}: ${error.message}`);
    throw new Error(`Error getting hostname from URL ${url}: ${error.message}`);
  }
}

/**
 * Whether a hostname has any DNS record (CNAME, A, or AAAA) — i.e. it actually resolves.
 * Never throws: a failed lookup (NXDOMAIN, SERVFAIL, timeout, …) is treated as "does not resolve"
 * and returns false, mirroring the tolerant DNS handling used elsewhere in this module.
 *
 * @param {string} host - Hostname to resolve (e.g. 'www.example.com').
 * @param {object} [log] - Logger.
 * @returns {Promise<boolean>} True if any record type resolves, false otherwise.
 */
export async function hostResolves(host, log) {
  const [cnames, ipv4, ipv6] = await Promise.all([
    dns.resolveCname(host).catch(() => []),
    dns.resolve4(host).catch(() => []),
    dns.resolve6(host).catch(() => []),
  ]);
  const resolves = cnames.length > 0 || ipv4.length > 0 || ipv6.length > 0;
  log?.info(`[edge-routing-utils] DNS check for ${host}: ${resolves ? 'resolves' : 'no records'}`);
  return resolves;
}

/**
 * Resolves the canonical origin host for a site's base URL, adding a DNS-follow step on top of
 * calculateForwardedHost.
 *
 * calculateForwardedHost normalizes a bare apex (example.com) to its www host (www.example.com),
 * matching how audits/crawls resolve the origin. But some sites are served only from the apex and
 * have no www record — forcing www there points the worker at a host that does not exist (the
 * gentingsingapore.com onboarding failure). So when the www host was synthesized from a bare apex,
 * it is only used if it actually resolves in DNS; otherwise we fall back to the apex. Hosts that
 * are already www or a subdomain are returned unchanged (calculateForwardedHost leaves them as-is,
 * so no lookup is needed).
 *
 * @param {string} baseURL - Site base URL (must include scheme).
 * @param {object} log - Logger.
 * @returns {Promise<string>} The canonical origin host.
 * @throws {Error} If the base URL is unparseable (propagated from calculateForwardedHost).
 */
export async function resolveCanonicalHost(baseURL, log) {
  const candidate = calculateForwardedHost(baseURL, log);
  const originalHost = new URL(baseURL).hostname.toLowerCase();

  // calculateForwardedHost only rewrites a bare apex into www.<apex>. When it returns the original
  // host unchanged (already www, or a subdomain) the candidate is authoritative — skip the lookup.
  if (candidate.toLowerCase() === originalHost) {
    return candidate;
  }

  // candidate is a www host synthesized from a bare apex — only trust it if it resolves.
  if (await hostResolves(candidate, log)) {
    return candidate;
  }

  log.info(
    `[edge-routing-utils] Synthesized host ${candidate} has no DNS records; `
    + `falling back to apex ${originalHost}`,
  );
  return originalHost;
}

/**
 * Returns true when a site baseURL contains a non-root pathname (e.g. https://example.com/docs).
 *
 * @param {string} baseURL - The site base URL.
 * @returns {boolean} True if the URL has pathname, false otherwise (including unparseable URLs).
 */
export function hasSubpath(baseURL) {
  if (!isValidUrl(baseURL)) {
    return false;
  }
  const { pathname } = new URL(baseURL);
  return pathname !== '/';
}

/**
 * Probes the site URL and resolves the canonical domain for CDN API calls.
 *
 * - 2xx with x-edgeoptimize-request-id header: returns the forwarded host derived from the probe
 *   URL.
 * - 2xx without x-edgeoptimize-request-id: throws (default UA routing not yet active).
 * - 301 to the same root domain: returns the forwarded host from the Location header.
 * - 301 to a different root domain: throws.
 * - Any other status: throws.
 * - Network/timeout error: propagates the thrown error.
 *
 * @param {string} siteUrl - The URL to probe (must include scheme).
 * @param {object} log - Logger.
 * @returns {Promise<string>} The resolved domain string.
 * @throws {Error} On unexpected probe response or domain mismatch.
 */
export async function probeSiteAndResolveDomain(siteUrl, log) {
  const probeResponse = await fetch(siteUrl, {
    method: 'GET',
    headers: { 'User-Agent': EDGE_OPTIMIZE_USER_AGENT },
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });

  if (probeResponse.ok) {
    if (!probeResponse.headers.has(UA_ROUTING_HEADER)) {
      throw new Error(
        `Site ${siteUrl} returned ${probeResponse.status} but is missing the `
        + `${UA_ROUTING_HEADER} response header — default UA routing is not yet active`,
      );
    }
    return calculateForwardedHost(siteUrl, log);
  }

  if (probeResponse.status === 301) {
    const locationValue = probeResponse.headers.get('location');
    const probeHostname = getHostnameWithoutWww(siteUrl, log);
    const locationHostname = getHostnameWithoutWww(locationValue, log);

    if (probeHostname !== locationHostname) {
      throw new Error(
        `Site ${siteUrl} returned 301 to ${locationValue}; domain `
        + `(${locationHostname}) does not match probe domain (${probeHostname})`,
      );
    }

    log.info(`[edge-routing-utils] Probe returned 301; using Location domain ${locationValue}`);
    return calculateForwardedHost(locationValue, log);
  }

  throw new Error(
    `Site ${siteUrl} did not return 2xx or 301 for`
    + ` User-Agent AdobeEdgeOptimize-Test (got ${probeResponse.status})`,
  );
}

/**
 * Parses EDGE_OPTIMIZE_ROUTING_CONFIG and returns the config entry for the given CDN type.
 *
 * @param {string} configJson - Raw JSON string from the environment variable.
 * @param {string} cdnTypeNormalized - The normalised CDN type key.
 * @returns {object} The CDN config entry (e.g. { cdnRoutingUrl: '...' }).
 * @throws {SyntaxError} If the JSON is malformed.
 * @throws {Error} If the entry is missing or has an invalid cdnRoutingUrl.
 */
export function parseEdgeRoutingConfig(configJson, cdnTypeNormalized) {
  const routingConfig = JSON.parse(configJson);
  const cdnConfig = routingConfig[cdnTypeNormalized];
  if (!isObject(cdnConfig) || !isValidUrl(cdnConfig.cdnRoutingUrl)) {
    throw new Error(
      `EDGE_OPTIMIZE_ROUTING_CONFIG missing entry or invalid URL for cdnType: ${cdnTypeNormalized}`,
    );
  }
  return cdnConfig;
}

/**
 * Calls the CDN routing API with the given strategy and SP token.
 *
 * @param {object} strategy - The CDN strategy ({ buildUrl, buildBody, method }).
 * @param {object} cdnConfig - The CDN config entry from parseEdgeRoutingConfig.
 * @param {string} domain - The resolved canonical domain.
 * @param {string} spToken - The Service Principal access token.
 * @param {boolean} routingEnabled - Whether to enable or disable CDN routing.
 * @param {object} log - Logger.
 * @returns {Promise<void>} Resolves on success.
 * @throws {Error} On network/timeout failure.
 */
export async function callCdnRoutingApi(
  strategy,
  cdnConfig,
  domain,
  spToken,
  routingEnabled,
  log,
) {
  const cdnUrl = strategy.buildUrl(cdnConfig, domain);
  const cdnBody = strategy.buildBody(routingEnabled);
  log.info(`[edge-routing-utils] Calling CDN API at ${cdnUrl} with enabled: ${routingEnabled}`);

  const cdnResponse = await fetch(cdnUrl, {
    method: strategy.method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${spToken}`,
    },
    body: JSON.stringify(cdnBody),
    signal: AbortSignal.timeout(CDN_CALL_TIMEOUT_MS),
  });

  if (!cdnResponse.ok) {
    const body = await cdnResponse.text();
    log.error(`[edge-routing-utils] CDN API failed for domain ${domain}: ${cdnResponse.status} ${body}`);
    throw new Error(`Upstream call failed with status ${cdnResponse.status}`, cdnResponse.status);
  }
}

// Suffix-anchored match: a CNAME hostname is considered AEM-CS-Fastly only
// when it equals one of the known patterns or terminates with `.<pattern>`.
// Plain `includes()` would mis-classify e.g. `evil.cdn.adobeaemcloud.com.attacker.com`.
function cnameMatches(cnames, patterns) {
  return cnames.some((raw) => {
    const c = (raw || '').toLowerCase().replace(/\.$/, '');
    return patterns.some((p) => c === p || c.endsWith(`.${p}`));
  });
}

async function checkHost(host, log) {
  const cnames = await dns.resolveCname(host).catch(() => []);
  log?.info(`[edge-routing-utils] Detected CNAMES for domain ${host}: ${cnames}`);
  if (cnameMatches(cnames, AEM_CS_FASTLY_CNAME_PATTERNS)) {
    return CDN_TYPES.AEM_CS_FASTLY;
  }
  const ips = await dns.resolve4(host).catch(() => []);
  log?.info(`[edge-routing-utils] Detected IPs for domain ${host}: ${ips}`);
  if (ips.some((ip) => AEM_CS_FASTLY_IPS.has(ip))) {
    return CDN_TYPES.AEM_CS_FASTLY;
  }
  return null;
}

/**
 * Detects whether a domain is using AEM Cloud Service Managed CDN (Fastly),
 * including sites where a WAF or reverse proxy hides the Fastly CNAME (Case 0).
 *
 * Tries a cheap DNS check first (CNAME + A records). If DNS does not confirm
 * AEM CS Fastly — e.g. because a WAF CNAME is visible instead — falls back to
 * the full CDN detector which runs Phase 1.5 HTTP probes for the WAF proxy case.
 *
 * Returns 'aem-cs-fastly' or null. Never throws.
 *
 * @param {string} domain - Hostname to check (e.g. 'example.com')
 * @returns {Promise<string|null>} 'aem-cs-fastly' or null
 */
export async function detectAemCsFastlyForDomain(domain, log) {
  try {
    log?.info(`[edge-routing-utils] Detecting AEM-CS Fastly for domain ${domain}`);
    const dnsResult = await checkHost(domain, log);
    if (dnsResult) {
      return dnsResult;
    }
    // DNS missed — a WAF or reverse proxy may be hiding AEM CS Fastly.
    // Run Phase 1.5 HTTP probes directly (no Phase 2 — we only care about AEM CS).
    return await detectAemCsFastlyWafSimpleProxy(domain, log);
  } catch (err) {
    log?.error('detectAemCsFastlyForDomain error', err);
  }
  return null;
}
