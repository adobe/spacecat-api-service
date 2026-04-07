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
async function checkHost(host) {
  const cnames = await dns.resolveCname(host).catch(() => []);
  if (cnames.some((c) => c.includes(AEM_CS_FASTLY_CNAME))) {
    return 'aem-cs-fastly';
  }

  const ips = await dns.resolve4(host).catch(() => []);
  if (ips.some((ip) => AEM_CS_FASTLY_IPS.has(ip))) {
    return 'aem-cs-fastly';
  }

  return null;
}

export async function detectCdnForDomain(domain) {
  try {
    return await checkHost(`www.${domain}`) ?? await checkHost(domain);
  } catch {
    // DNS errors are treated as undetected — never break callers
  }
  return null;
}
