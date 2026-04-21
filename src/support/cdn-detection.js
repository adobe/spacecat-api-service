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

import { promises as dns } from 'dns';

const AEM_CS_FASTLY_CNAME_PATTERNS = [
  'cdn.adobeaemcloud.com',
  'adobe-aem.map.fastly.net',
];
// Same Fastly A records as edge-routing-utils (keep lists in sync).
const AEM_CS_FASTLY_IPS = new Set([
  '151.101.195.10',
  '151.101.67.10',
  '151.101.3.10',
  '151.101.131.10',
]);

// Adobe Commerce Cloud (PaaS, Fastly) signatures — sourced from the official
// Commerce on Cloud Launch Checklist:
// https://experienceleague.adobe.com/en/docs/commerce-on-cloud/user-guide/launch/checklist
const COMMERCE_FASTLY_CNAME_PATTERNS = [
  'prod.magentocloud.map.fastly.net',
  'basic.magentocloud.map.fastly.net',
];
const COMMERCE_FASTLY_IPS = new Set([
  '151.101.1.124',
  '151.101.65.124',
  '151.101.129.124',
  '151.101.193.124',
]);
const COMMERCE_FASTLY_IPV6 = new Set([
  '2a04:4e42:200::380',
  '2a04:4e42:400::380',
  '2a04:4e42:600::380',
  '2a04:4e42::380',
]);

// ENODATA = record type doesn't exist; ENOTFOUND = domain doesn't exist (NXDOMAIN).
// Both are authoritative answers — safe to treat as "no records" and continue.
const DNS_NO_RECORD_CODES = new Set(['ENODATA', 'ENOTFOUND']);

function catchDnsLookup(err) {
  if (DNS_NO_RECORD_CODES.has(err.code)) {
    return [];
  }
  return null;
}

// Suffix match against a list of CNAME targets. Strips a single trailing dot
// (FQDN form) so 'prod.magentocloud.map.fastly.net.' matches as expected.
function cnameMatches(cnames, patterns) {
  return cnames.some((raw) => {
    const c = raw.endsWith('.') ? raw.slice(0, -1) : raw;
    return patterns.some((p) => c === p || c.endsWith(`.${p}`));
  });
}

/**
 * Checks whether a single host resolves to one of the supported CDNs.
 *
 * Evaluates both AEM CS Fastly and Commerce Fastly signatures at each DNS
 * record-type layer before advancing to the next layer: CNAME (AEM CS then
 * Commerce), then A (AEM CS then Commerce), then AAAA (Commerce only — AEM CS
 * does not publish IPv6 today). Short-circuits on the first match.
 *
 * Returns:
 *  - 'aem-cs-fastly'   when DNS matches known AEM CS Fastly CNAME / A records
 *  - 'commerce-fastly' when DNS matches known Commerce Fastly CNAME / A / AAAA records
 *  - 'other'           when DNS resolved but nothing matched
 *  - null              when a DNS lookup failed (inconclusive)
 *
 * @param {string} host - Hostname to check
 * @param {object} [log] - Logger instance
 * @returns {Promise<string|null>}
 */
async function checkHost(host, log) {
  const cnames = await dns.resolveCname(host).catch(catchDnsLookup);
  if (cnames === null) {
    log?.info(`[cdn-detection] DNS lookup failed for ${host} (CNAME)`);
    return null;
  }
  log?.info(`[cdn-detection] Detected CNAMES for domain ${host}: ${cnames}`);
  if (cnameMatches(cnames, AEM_CS_FASTLY_CNAME_PATTERNS)) {
    return 'aem-cs-fastly';
  }
  if (cnameMatches(cnames, COMMERCE_FASTLY_CNAME_PATTERNS)) {
    return 'commerce-fastly';
  }

  const ips = await dns.resolve4(host).catch(catchDnsLookup);
  if (ips === null) {
    log?.info(`[cdn-detection] DNS lookup failed for ${host} (A record)`);
    return null;
  }
  log?.info(`[cdn-detection] Detected IPs for domain ${host}: ${ips}`);
  if (ips.some((ip) => AEM_CS_FASTLY_IPS.has(ip))) {
    return 'aem-cs-fastly';
  }
  if (ips.some((ip) => COMMERCE_FASTLY_IPS.has(ip))) {
    return 'commerce-fastly';
  }

  const ipv6 = await dns.resolve6(host).catch(catchDnsLookup);
  if (ipv6 === null) {
    log?.info(`[cdn-detection] DNS lookup failed for ${host} (AAAA record)`);
    return null;
  }
  if (ipv6.length > 0) {
    log?.info(`[cdn-detection] Detected IPv6 for domain ${host}: ${ipv6}`);
  }
  if (ipv6.some((ip) => COMMERCE_FASTLY_IPV6.has(ip))) {
    return 'commerce-fastly';
  }

  return 'other';
}

/**
 * Detects the CDN for a domain by probing www.{domain} then {domain}.
 *
 * Returns:
 *  - 'aem-cs-fastly'   — DNS matched known AEM CS Fastly signatures
 *  - 'commerce-fastly' — DNS matched known Adobe Commerce Cloud (Fastly) signatures
 *  - 'other'           — DNS resolved for both hosts but neither matched
 *  - null              — at least one DNS lookup failed; result is inconclusive
 *
 * Never throws.
 *
 * @param {string} domain - bare domain (e.g. 'example.com')
 * @param {object} [log] - Logger instance
 * @returns {Promise<string|null>}
 */
export async function detectCdnForDomain(domain, log) {
  try {
    log?.info(`[cdn-detection] Detecting CDN for domain ${domain}`);

    const wwwResult = await checkHost(`www.${domain}`, log);
    if (wwwResult === 'aem-cs-fastly' || wwwResult === 'commerce-fastly') {
      return wwwResult;
    }

    const bareResult = await checkHost(domain, log);
    if (bareResult === 'aem-cs-fastly' || bareResult === 'commerce-fastly') {
      return bareResult;
    }

    if (wwwResult === null || bareResult === null) {
      return null;
    }

    return 'other';
    /* c8 ignore next 3 */
  } catch {
    return null;
  }
}
