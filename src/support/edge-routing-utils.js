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

const EDGE_OPTIMIZE_USER_AGENT = 'AdobeEdgeOptimize-Test AdobeEdgeOptimize/1.0';
const UA_ROUTING_HEADER = 'x-edgeoptimize-request-id';
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

// Default Tokowaka worker base URL for WAF connectivity probes.
// The probe sends a normal proxy request through Tokowaka (with x-forwarded-host)
// so the origin fetch happens from Fastly edge IPs with the AdobeEdgeOptimize UA.
const TOKOWAKA_PROXY_BASE_URL_DEFAULT = 'https://live.edgeoptimize.net';

const WAF_PROBE_TIMEOUT_MS = 15000;

// Soft-block detection: bot-challenge pages are typically tiny HTML with these keywords.
const BOT_CHALLENGE_BODY_MAX_BYTES = 2048;
const BOT_CHALLENGE_KEYWORDS = [
  'challenge', 'captcha', 'bot manager', 'access denied', 'blocked', 'cloudflare',
];

// HTTP status codes that indicate a hard WAF/bot-manager block.
const HARD_BLOCK_STATUS_CODES = new Set([403, 406, 429]);

/**
 * Classifies the Tokowaka proxy response to determine WAF/bot-manager blocking.
 *
 * @param {object} response - The fetch Response from Tokowaka.
 * @param {string} targetHost - The probed hostname (for logging).
 * @param {object} log - Logger.
 * @returns {Promise<object>} Classification result with { reachable, blocked, statusCode }.
 */
async function classifyProbeResponse(response, targetHost, log) {
  const { status } = response;

  // Hard block: WAF explicitly rejects the request.
  if (HARD_BLOCK_STATUS_CODES.has(status)) {
    log.info(`[waf-probe] Hard block for ${targetHost}: HTTP ${status}`);
    return { reachable: false, blocked: true, statusCode: status };
  }

  // 2xx — check for soft blocks (bot-challenge pages disguised as 200 OK).
  if (status >= 200 && status < 300) {
    const contentType = response.headers.get('content-type') || '';

    if (contentType.includes('text/html')) {
      const contentLengthHeader = response.headers.get('content-length');
      const contentLengthNum = contentLengthHeader ? parseInt(contentLengthHeader, 10) : null;

      // Large HTML response — real content, not a challenge page.
      if (contentLengthNum !== null && contentLengthNum > BOT_CHALLENGE_BODY_MAX_BYTES) {
        log.info(`[waf-probe] Clean pass for ${targetHost}: HTTP ${status} (large content-length)`);
        return { reachable: true, blocked: false, statusCode: status };
      }

      // Read body snippet for keyword matching.
      const text = await response.text();
      if (text.length <= BOT_CHALLENGE_BODY_MAX_BYTES) {
        const lower = text.toLowerCase();
        const isSoftBlock = BOT_CHALLENGE_KEYWORDS.some((kw) => lower.includes(kw));
        if (isSoftBlock) {
          log.info(`[waf-probe] Soft block (challenge page) for ${targetHost}: HTTP ${status}`);
          return { reachable: false, blocked: true, statusCode: status };
        }
      }
    }

    log.info(`[waf-probe] Clean pass for ${targetHost}: HTTP ${status}`);
    return { reachable: true, blocked: false, statusCode: status };
  }

  // Other non-2xx (404, 500, 502, etc.) — not a WAF block, but not reachable either.
  log.info(`[waf-probe] Unexpected status for ${targetHost}: HTTP ${status}`);
  return { reachable: false, blocked: false, statusCode: status };
}

/**
 * Detects whether a WAF or Bot Manager is blocking AdobeEdgeOptimize/1.0 traffic
 * for the given site by sending a normal proxy request through the Tokowaka edge worker.
 *
 * The probe calls live.edgeoptimize.net with x-forwarded-host set to the customer
 * domain. Tokowaka proxies to the customer origin from Fastly edge IPs using its
 * standard AdobeEdgeOptimize/1.0 user-agent. The response is then classified here.
 *
 * Four outcomes:
 * - **Hard block**: HTTP 403, 406, or 429 → `{ reachable: false, blocked: true }`
 * - **Soft block**: 2xx with tiny bot-challenge HTML body → `{ reachable: false, blocked: true }`
 * - **Pass**: 2xx with real content → `{ reachable: true, blocked: false }`
 * - **Network/timeout error**: `{ reachable: false, blocked: null, reason: 'timeout'|'error' }`
 *
 * This function never throws — all errors are captured into the return value.
 *
 * @param {string} siteBaseUrl - The site's base URL (with or without scheme).
 * @param {object} log - Logger.
 * @param {string} [tokowakaProxyBaseUrl] - Override for the Tokowaka worker base URL.
 *   Defaults to the production URL. Populated from TOKOWAKA_PROXY_BASE_URL env var.
 * @returns {Promise<object>} WAF probe result.
 */
export async function probeWafConnectivity(
  siteBaseUrl,
  log,
  tokowakaProxyBaseUrl = TOKOWAKA_PROXY_BASE_URL_DEFAULT,
) {
  const normalizedUrl = siteBaseUrl.startsWith('http') ? siteBaseUrl : `https://${siteBaseUrl}`;
  const { host: targetHost, href: probedUrl } = new URL(normalizedUrl);

  const probeResult = {
    probedUrl,
  };

  log.info(`[waf-probe] Probing ${targetHost} via Tokowaka proxy at ${tokowakaProxyBaseUrl}`);

  try {
    const response = await fetch(tokowakaProxyBaseUrl, {
      method: 'GET',
      headers: {
        'x-forwarded-host': targetHost,
      },
      signal: AbortSignal.timeout(WAF_PROBE_TIMEOUT_MS),
    });

    const classification = await classifyProbeResponse(response, targetHost, log);
    return { ...probeResult, ...classification };
  } catch (error) {
    const isTimeout = error.name === 'TimeoutError' || error.name === 'AbortError';
    const reason = isTimeout ? 'timeout' : 'error';
    log.warn(`[waf-probe] ${reason} probing ${targetHost} via Tokowaka: ${error.message}`);
    return {
      ...probeResult, reachable: false, blocked: null, reason,
    };
  }
}

const AEM_CS_FASTLY_CNAME_PATTERNS = [
  'cdn.adobeaemcloud.com',
  'adobe-aem.map.fastly.net',
];
const AEM_CS_FASTLY_IPS = new Set([
  '151.101.195.10',
  '151.101.67.10',
  '151.101.3.10',
  '151.101.131.10',
]);

async function checkHost(host, log) {
  const cnames = await dns.resolveCname(host).catch(() => []);
  log?.info(`[edge-routing-utils] Detected CNAMES for domain ${host}: ${cnames}`);
  if (cnames.some((c) => AEM_CS_FASTLY_CNAME_PATTERNS.some((pattern) => c.includes(pattern)))) {
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
 * Detects whether a domain is using AEM Cloud Service Managed CDN (Fastly)
 * by checking DNS CNAME and A records.
 *
 * Returns 'aem-cs-fastly' if the domain resolves to the known CS Fastly
 * CNAME or IP addresses, otherwise returns null.
 *
 * Never throws — DNS failures are treated as undetected.
 *
 * @param {string} domain - Hostname to check (e.g. 'example.com')
 * @returns {Promise<string|null>} CDN identifier or null
 */
export async function detectCdnForDomain(domain, log) {
  try {
    log?.info(`[edge-routing-utils] Detecting CDN for domain ${domain}`);
    return await checkHost(domain, log);
  } catch (err) {
    // DNS errors are treated as undetected — never break callers
    log?.error('detectCdnForDomain error', err);
  }
  return null;
}
