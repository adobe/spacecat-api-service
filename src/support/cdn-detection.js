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

const AEM_CS_FASTLY_CNAME = 'cdn.adobeaemcloud.com';
const AEM_CS_FASTLY_IPS = new Set([
  '146.75.123.10',
  '151.101.195.10',
  '151.101.67.10',
  '151.101.3.10',
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

/**
 * Checks whether a single host resolves to AEM CS Fastly via CNAME or A records.
 *
 * Returns:
 *  - 'aem-cs-fastly' when DNS matches known Fastly CNAME / IPs
 *  - 'other'          when DNS resolved but nothing matched
 *  - null             when a DNS lookup failed (inconclusive)
 *
 * @param {string} host - Hostname to check
 * @returns {Promise<string|null>}
 */
async function checkHost(host) {
  const cnames = await dns.resolveCname(host).catch(catchDnsLookup);
  if (cnames === null) {
    return null;
  }
  if (cnames.some((c) => c.includes(AEM_CS_FASTLY_CNAME))) {
    return 'aem-cs-fastly';
  }

  const ips = await dns.resolve4(host).catch(catchDnsLookup);
  if (ips === null) {
    return null;
  }
  if (ips.some((ip) => AEM_CS_FASTLY_IPS.has(ip))) {
    return 'aem-cs-fastly';
  }

  return 'other';
}

/**
 * Detects the CDN for a domain by probing www.{domain} then {domain}.
 *
 * Returns:
 *  - 'aem-cs-fastly' — DNS matched known AEM CS Fastly signatures
 *  - 'other'          — DNS resolved for both hosts but neither matched
 *  - null             — at least one DNS lookup failed; result is inconclusive
 *
 * Never throws.
 *
 * @param {string} domain - bare domain (e.g. 'example.com')
 * @returns {Promise<string|null>}
 */
export async function detectCdnForDomain(domain) {
  try {
    const wwwResult = await checkHost(`www.${domain}`);
    if (wwwResult === 'aem-cs-fastly') {
      return 'aem-cs-fastly';
    }

    const bareResult = await checkHost(domain);
    if (bareResult === 'aem-cs-fastly') {
      return 'aem-cs-fastly';
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
