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

import { isObject, isValidUrl, tracingFetch as fetch } from '@adobe/spacecat-shared-utils';
import { calculateForwardedHost } from '@adobe/spacecat-shared-tokowaka-client';

// Supported CDN / log source types. Aligned with auth-service (cdn-logs-infrastructure/common.js).
export const LOG_SOURCES = {
  BYOCDN_FASTLY: 'byocdn-fastly',
  BYOCDN_AKAMAI: 'byocdn-akamai',
  BYOCDN_CLOUDFRONT: 'byocdn-cloudfront',
  BYOCDN_CLOUDFLARE: 'byocdn-cloudflare',
  BYOCDN_IMPERVA: 'byocdn-imperva',
  BYOCDN_OTHER: 'byocdn-other',
  AMS_CLOUDFRONT: 'ams-cloudfront',
  AMS_FRONTDOOR: 'ams-frontdoor',
  AEM_CS_FASTLY: 'aem-cs-fastly',
  COMMERCE_FASTLY: 'commerce-fastly',
};

// Per-CDN strategies for edge optimize routing.
export const EDGE_OPTIMIZE_CDN_STRATEGIES = {
  [LOG_SOURCES.AEM_CS_FASTLY]: {
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
 * - 2xx: returns the forwarded host derived from the probe URL.
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
 * Error thrown when the CDN routing API returns a non-successful response.
 * Carries an HTTP `status` code so callers can map it to the appropriate HTTP response.
 */
export class CdnApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'CdnApiError';
    this.status = status;
  }
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
 * @throws {CdnApiError} On a non-2xx CDN API response.
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
    if (cdnResponse.status === 401 || cdnResponse.status === 403) {
      throw new CdnApiError('User is not authorized to update CDN routing', cdnResponse.status);
    }
    throw new CdnApiError(`Upstream call failed with status ${cdnResponse.status}`, cdnResponse.status);
  }
}
