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
import { tracingFetch as fetch, SPACECAT_USER_AGENT } from '@adobe/spacecat-shared-utils';

/* ============================================================================
 * Phase 1 — Adobe-managed CDN fast-path (DNS-only).
 *
 * Cheap, deterministic DNS check for AEM CS Fastly / Adobe Commerce Cloud
 * (Fastly). When this matches, we skip Phase 2 entirely.
 * ========================================================================== */

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
 * Checks whether a single host resolves to one of the Adobe-managed CDNs.
 *
 * Returns:
 *  - 'aem-cs-fastly'   — DNS matched known AEM CS Fastly CNAME / A records
 *  - 'commerce-fastly' — DNS matched known Commerce Fastly CNAME / A / AAAA records
 *  - 'other'           — DNS resolved cleanly but nothing matched
 *  - null              — at least one DNS lookup failed (inconclusive)
 *
 * @param {string} host - Hostname to check.
 * @param {object} [log] - Optional logger.
 * @returns {Promise<string|null>}
 */
async function checkHost(host, log) {
  const cnames = await dns.resolveCname(host).catch(catchDnsLookup);
  if (cnames === null) {
    log?.info?.(`[cdn-detection] DNS lookup failed for ${host} (CNAME)`);
    return null;
  }
  log?.info?.(`[cdn-detection] Detected CNAMES for domain ${host}: ${cnames}`);
  if (cnameMatches(cnames, AEM_CS_FASTLY_CNAME_PATTERNS)) {
    return 'aem-cs-fastly';
  }
  if (cnameMatches(cnames, COMMERCE_FASTLY_CNAME_PATTERNS)) {
    return 'commerce-fastly';
  }

  const ips = await dns.resolve4(host).catch(catchDnsLookup);
  if (ips === null) {
    log?.info?.(`[cdn-detection] DNS lookup failed for ${host} (A record)`);
    return null;
  }
  log?.info?.(`[cdn-detection] Detected IPs for domain ${host}: ${ips}`);
  if (ips.some((ip) => AEM_CS_FASTLY_IPS.has(ip))) {
    return 'aem-cs-fastly';
  }
  if (ips.some((ip) => COMMERCE_FASTLY_IPS.has(ip))) {
    return 'commerce-fastly';
  }

  const ipv6 = await dns.resolve6(host).catch(catchDnsLookup);
  if (ipv6 === null) {
    log?.info?.(`[cdn-detection] DNS lookup failed for ${host} (AAAA record)`);
    return null;
  }
  if (ipv6.length > 0) {
    log?.info?.(`[cdn-detection] Detected IPv6 for domain ${host}: ${ipv6}`);
  }
  if (ipv6.some((ip) => COMMERCE_FASTLY_IPV6.has(ip))) {
    return 'commerce-fastly';
  }

  return 'other';
}

/**
 * Phase 1 entry: probes www.{domain} then {domain} for Adobe-managed CDN signatures.
 * Returns the same three-state result as checkHost.
 */
async function detectAdobeManagedCdn(domain, log) {
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
}

/* ============================================================================
 * Phase 2 — Generic multi-signal CDN fingerprinting.
 *
 * Logic ported (intentionally duplicated) from spacecat-audit-worker:
 *   src/detect-cdn/cdn-detector.js
 *
 * Probes HTTP headers first; on miss, walks the CNAME chain (system resolver
 * then DoH), then maps a single A-record IP to its ASN via ipinfo.io, then
 * runs PTR keyword matching as a final tiebreaker.
 *
 * The detector returns descriptive labels (e.g. "Cloudflare", "Vercel"). The
 * LABEL_TO_LLMO_TOKEN adapter translates those labels into the LLMO byocdn-X
 * vocabulary the rest of the api-service / UI understands.
 * ========================================================================== */

/**
 * CDN identification by CNAME domain suffix (used when headers are missing).
 * Order matters: first match wins. Use lowercase domain fragments.
 */
const CDN_DOMAIN_SIGNATURES = [
  { domains: ['cloudflare.com'], cdn: 'Cloudflare' },
  { domains: ['fastly.net'], cdn: 'Fastly' },
  { domains: ['cloudfront.net'], cdn: 'CloudFront' },
  { domains: ['akamai.net', 'akamaized.net', 'edgesuite.net', 'akamaitechnologies.com', 'akamaiedge.net'], cdn: 'Akamai' },
  { domains: ['azureedge.net', 'msecnd.net'], cdn: 'Azure Front Door / Azure CDN' },
  { domains: ['googleusercontent.com'], cdn: 'Google Cloud CDN' },
  { domains: ['alicdn.com', 'yundunwaf3.com'], cdn: 'Alibaba Cloud CDN' },
];

/**
 * CDN identification by ASN when CNAME chain doesn't match a known provider.
 */
const CDN_ASN_SIGNATURES = [
  { asns: [13335], cdn: 'Cloudflare' },
  { asns: [54113], cdn: 'Fastly' },
  { asns: [16509], cdn: 'CloudFront' },
  { asns: [20940, 16625, 21342], cdn: 'Akamai' },
  { asns: [8075], cdn: 'Azure Front Door / Azure CDN' },
  { asns: [15169], cdn: 'Google Cloud CDN' },
  { asns: [24429, 37963], cdn: 'Alibaba Cloud CDN' },
];

/**
 * Substring keywords matched against lowercased DNS names, header-derived text,
 * and PTR names. First matching pattern wins.
 */
const CDN_KEYWORD_SIGNATURES = [
  { patterns: ['clever-cloud', 'clever cloud'], cdn: 'Clever Cloud' },
  { patterns: ['cloudflare'], cdn: 'Cloudflare' },
  { patterns: ['incapsula', 'imperva'], cdn: 'Imperva' },
  { patterns: ['cloudfront'], cdn: 'CloudFront' },
  { patterns: ['akamai', 'akamaiedge', 'edgesuite', 'edgekey', 'akamaitechnologies'], cdn: 'Akamai' },
  { patterns: ['airee'], cdn: 'Airee' },
  { patterns: ['cachefly'], cdn: 'CacheFly' },
  { patterns: ['edgecast'], cdn: 'EdgeCast' },
  { patterns: ['maxcdn', 'netdna'], cdn: 'StackPath' },
  { patterns: ['beluga'], cdn: 'BelugaCDN' },
  { patterns: ['limelight', 'llnw'], cdn: 'Limelight' },
  { patterns: ['fastly'], cdn: 'Fastly' },
  { patterns: ['myracloud', 'myrasec'], cdn: 'Myra' },
  { patterns: ['msecnd'], cdn: 'Azure Front Door / Azure CDN' },
];

/**
 * Translates the descriptive label returned by the audit-worker-style detector
 * into the LLMO byocdn-X vocabulary stored on siteConfig.llmo.detectedCdn.
 *
 * Labels not present here fall back to 'other'. The Adobe-managed Fastly /
 * Commerce Fastly cases are handled by Phase 1 and never reach this map.
 */
const LABEL_TO_LLMO_TOKEN = {
  Cloudflare: 'byocdn-cloudflare',
  Fastly: 'byocdn-fastly',
  CloudFront: 'byocdn-cloudfront',
  Akamai: 'byocdn-akamai',
  Imperva: 'byocdn-imperva',
  'Azure Front Door / Azure CDN': 'byocdn-azure',
  'Azure Front Door': 'byocdn-frontdoor',
  'Azure CDN': 'byocdn-azure',
  'Google Cloud CDN': 'byocdn-google',
  Vercel: 'byocdn-vercel',
  Netlify: 'byocdn-netlify',
  KeyCDN: 'byocdn-keycdn',
  Limelight: 'byocdn-limelight',
  CDNetworks: 'byocdn-cdnetworks',
  'Bunny CDN': 'byocdn-bunny',
  StackPath: 'byocdn-stackpath',
  Sucuri: 'byocdn-sucuri',
  'Alibaba Cloud CDN': 'byocdn-alibaba',
  'Clever Cloud': 'byocdn-clever',
  Airee: 'byocdn-airee',
  CacheFly: 'byocdn-cachefly',
  EdgeCast: 'byocdn-edgecast',
  BelugaCDN: 'byocdn-beluga',
  Myra: 'byocdn-myra',
};

function matchCdnByKeywords(text) {
  if (!text) {
    return null;
  }
  const lower = text.toLowerCase();
  for (const { patterns, cdn } of CDN_KEYWORD_SIGNATURES) {
    if (patterns.some((p) => lower.includes(p))) {
      return cdn;
    }
  }
  return null;
}

function detectCdnFromHeaders(headers) {
  /* c8 ignore next 3 -- defensive; always called with an object from headersFromResponse */
  if (!headers || typeof headers !== 'object') {
    return 'unknown';
  }

  const get = (name) => {
    const v = headers[name];
    return typeof v === 'string' ? v : '';
  };
  const has = (name) => get(name).length > 0;
  const match = (name, re) => re.test(get(name));
  const hasKey = (prefix) => Object.keys(headers).some((k) => k.toLowerCase().startsWith(prefix));

  if (has('cf-ray') || match('cf-cache-status', /./) || match('server', /cloudflare/i)) {
    return 'Cloudflare';
  }
  if (hasKey('x-akamai-') || has('akamai-origin-hop') || match('server', /akamaighost/i) || has('x-akamai-transformed')) {
    return 'Akamai';
  }
  if (has('x-served-by') || has('x-fastly-request-id') || has('fastly-ff') || has('fastly-debug-digest') || match('via', /fastly/i)) {
    return 'Fastly';
  }
  if (has('x-amz-cf-id') || has('x-amz-cf-pop') || match('via', /cloudfront/i)) {
    return 'CloudFront';
  }
  if (has('x-azure-ref')) {
    return 'Azure Front Door / Azure CDN';
  }
  if (has('x-ec-debug')) {
    return 'Azure CDN';
  }
  if (has('x-fd-healthprobe')) {
    return 'Azure Front Door';
  }
  if (match('via', /google/i) || hasKey('x-goog-')) {
    return 'Google Cloud CDN';
  }
  if (has('x-iinfo') || match('x-cdn', /incapsula|imperva/i)) {
    return 'Imperva';
  }
  if (has('x-vercel-id') || match('server', /vercel/i)) {
    return 'Vercel';
  }
  if (has('x-nf-request-id') || match('server', /netlify/i)) {
    return 'Netlify';
  }
  if (has('x-edge-location') || match('server', /keycdn/i)) {
    return 'KeyCDN';
  }
  if (has('x-llid') || has('x-llrid')) {
    return 'Limelight';
  }
  if (has('x-cdn-request-id')) {
    return 'CDNetworks';
  }
  if (hasKey('x-bunny-')) {
    return 'Bunny CDN';
  }
  if (match('server', /netdna/i)) {
    return 'StackPath';
  }
  if (has('x-sucuri-id')) {
    return 'Sucuri';
  }

  const keywordBlob = [
    get('server'),
    get('via'),
    get('x-cache'),
    get('x-cdn'),
    get('x-cdn-forward'),
    get('x-powered-by'),
  ]
    .filter(Boolean)
    .join(' ');
  const fromKeywords = matchCdnByKeywords(keywordBlob);
  if (fromKeywords) {
    return fromKeywords;
  }

  return 'unknown';
}

function headersFromResponse(response) {
  const headers = {};
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  const cdn = detectCdnFromHeaders(headers);
  if (response.body && typeof response.body.cancel === 'function') {
    response.body.cancel();
  }
  return { cdn };
}

/** Google Public DNS JSON API; used when the system resolver fails or times out. */
const DOH_GOOGLE_RESOLVE = 'https://dns.google/resolve';

async function dohQuery(name, typeNum, opts = {}) {
  const { timeout = 5000, log } = opts;
  const url = `${DOH_GOOGLE_RESOLVE}?name=${encodeURIComponent(name)}&type=${typeNum}`;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/dns-json' },
    });
    clearTimeout(id);
    if (!response.ok) {
      return { Answer: [] };
    }
    const data = await response.json();
    return data && Array.isArray(data.Answer) ? data : { Answer: [] };
  } catch (err) {
    clearTimeout(id);
    log?.warn?.('[cdn-detection] DoH query failed', { name, type: typeNum, message: err?.message });
    return { Answer: [] };
  }
}

function normalizeDohName(data) {
  /* c8 ignore next 3 -- defensive; callers only pass string values from DoH Answer.data */
  if (typeof data !== 'string') {
    return '';
  }
  return data.replace(/\.$/, '').trim();
}

async function getCnameChainDoh(hostname, log) {
  const chain = [];
  let current = hostname.replace(/\.$/, '');
  const maxHops = 10;

  /* eslint-disable no-await-in-loop -- Each CNAME hop depends on the previous answer. */
  for (let hop = 0; hop < maxHops; hop += 1) {
    chain.push(current);
    const { Answer = [] } = await dohQuery(current, 5, { timeout: 5000, log });
    const cname = Answer.find((a) => a.type === 5);
    if (!cname?.data) {
      break;
    }
    current = normalizeDohName(cname.data);
    if (!current) {
      break;
    }
  }
  /* eslint-enable no-await-in-loop */

  return chain;
}

async function getOneIpDoh(hostname, log) {
  const { Answer = [] } = await dohQuery(hostname, 1, { timeout: 5000, log });
  const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/;
  for (const a of Answer) {
    if (a.type === 1 && typeof a.data === 'string' && ipv4.test(a.data)) {
      return a.data;
    }
  }
  return null;
}

async function getCnameChain(hostname, log) {
  const chain = [];
  let current = hostname.replace(/\.$/, '');
  const maxHops = 10;

  /* eslint-disable no-await-in-loop -- Each CNAME hop depends on the previous answer. */
  for (let hop = 0; hop < maxHops; hop += 1) {
    chain.push(current);
    try {
      const results = await dns.resolveCname(current);
      if (!results || results.length === 0) {
        break;
      }
      const next = results[0].replace(/\.$/, '');
      if (next === current) {
        break;
      }
      current = next;
    } catch (err) {
      if (err?.code === 'ENODATA' || err?.code === 'ENOTFOUND') {
        break;
      }
      log?.warn?.('[cdn-detection] CNAME resolve error', { hostname: current, code: err?.code });
      break;
    }
  }
  /* eslint-enable no-await-in-loop */

  return chain;
}

async function getOneIp(hostname, log) {
  try {
    const addresses = await dns.resolve4(hostname);
    return addresses && addresses.length > 0 ? addresses[0] : null;
  } catch (err) {
    log?.warn?.('[cdn-detection] resolve4 error', { hostname, code: err?.code });
    return null;
  }
}

async function getPtrHostnames(ip, log) {
  try {
    const hosts = await dns.reverse(ip);
    return Array.isArray(hosts) && hosts.length > 0 ? hosts : [];
  } catch (err) {
    log?.warn?.('[cdn-detection] reverse DNS failed', { ip, code: err?.code });
    return [];
  }
}

async function getAsnForIp(ip, options = {}) {
  const { timeout = 10000, log } = options;
  const url = `https://ipinfo.io/${ip}/json`;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(id);
    if (!response.ok) {
      return null;
    }
    const data = await response.json();
    const org = data?.org;
    if (typeof org !== 'string') {
      return null;
    }
    const m = org.match(/^AS(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  } catch (err) {
    clearTimeout(id);
    log?.warn?.('[cdn-detection] ASN lookup failed', { ip, message: err?.message });
    return null;
  }
}

function matchCdnByCname(cnameChain) {
  /* c8 ignore next 3 -- defensive; callers always pass a non-empty chain */
  if (!Array.isArray(cnameChain) || cnameChain.length === 0) {
    return null;
  }
  for (const { domains, cdn } of CDN_DOMAIN_SIGNATURES) {
    for (const hostname of cnameChain) {
      const lower = hostname.toLowerCase();
      if (domains.some((d) => lower.includes(d))) {
        return cdn;
      }
    }
  }
  return null;
}

function matchCdnByAsn(asn) {
  /* c8 ignore next 3 -- defensive; caller passes parseInt output filtered for null */
  if (typeof asn !== 'number' || Number.isNaN(asn)) {
    return null;
  }
  for (const { asns, cdn } of CDN_ASN_SIGNATURES) {
    if (asns.includes(asn)) {
      return cdn;
    }
  }
  return null;
}

async function detectCdnFromDnsFallback(url, options = {}) {
  const { log } = options;
  let hostname;
  /* c8 ignore start -- defensive; callers only pass an already-validated URL string */
  try {
    hostname = new URL(url).hostname;
  } catch {
    return { cdn: 'unknown' };
  }
  /* c8 ignore stop */

  const cnameChainSystem = await getCnameChain(hostname, log);
  let cdnFromCname = matchCdnByCname(cnameChainSystem);
  if (cdnFromCname) {
    log?.info?.('[cdn-detection] Phase 2: detected by CNAME', { cdn: cdnFromCname, hostname });
    return { cdn: cdnFromCname };
  }
  const cdnFromChainKw = matchCdnByKeywords(cnameChainSystem.join(' '));
  if (cdnFromChainKw) {
    log?.info?.('[cdn-detection] Phase 2: detected by DNS name keywords', { cdn: cdnFromChainKw, hostname });
    return { cdn: cdnFromChainKw };
  }

  const cnameChainDoh = await getCnameChainDoh(hostname, log);
  cdnFromCname = matchCdnByCname(cnameChainDoh);
  if (cdnFromCname) {
    log?.info?.('[cdn-detection] Phase 2: detected by CNAME (DoH)', { cdn: cdnFromCname, hostname });
    return { cdn: cdnFromCname };
  }
  const cdnFromDohKw = matchCdnByKeywords(cnameChainDoh.join(' '));
  if (cdnFromDohKw) {
    log?.info?.('[cdn-detection] Phase 2: detected by DNS name keywords (DoH)', { cdn: cdnFromDohKw, hostname });
    return { cdn: cdnFromDohKw };
  }

  const ip = (await getOneIp(hostname, log)) || (await getOneIpDoh(hostname, log));
  if (ip) {
    const asn = await getAsnForIp(ip, { timeout: 10000, log });
    const cdnFromAsn = asn !== null ? matchCdnByAsn(asn) : null;
    if (cdnFromAsn) {
      log?.info?.('[cdn-detection] Phase 2: detected by ASN', { cdn: cdnFromAsn, asn });
      return { cdn: cdnFromAsn };
    }
    const ptrHostnames = await getPtrHostnames(ip, log);
    for (const ptr of ptrHostnames) {
      const fromPtrKw = matchCdnByKeywords(ptr);
      if (fromPtrKw) {
        log?.info?.('[cdn-detection] Phase 2: detected by PTR keywords', { cdn: fromPtrKw, ip, ptr });
        return { cdn: fromPtrKw };
      }
      const fromPtrCname = matchCdnByCname([ptr]);
      if (fromPtrCname) {
        log?.info?.('[cdn-detection] Phase 2: detected by PTR CNAME signature', { cdn: fromPtrCname, ip, ptr });
        return { cdn: fromPtrCname };
      }
    }
  }

  return { cdn: 'unknown' };
}

async function detectCdnFromUrl(url, options = {}) {
  const {
    timeout = 10000,
    fallbackTimeout = 15000,
    userAgent = SPACECAT_USER_AGENT,
    log,
  } = options;

  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  const fetchOptions = {
    redirect: 'follow',
    headers: { 'User-Agent': userAgent },
    signal: controller.signal,
  };

  let result;
  try {
    const response = await fetch(url, { ...fetchOptions, method: 'HEAD' });
    clearTimeout(id);
    result = headersFromResponse(response);
  } catch (headError) {
    clearTimeout(id);
    const headMessage = headError?.message || String(headError);
    log?.warn?.(`[cdn-detection] Phase 2 HEAD failed (${headMessage}), retrying GET: ${url}`);

    const getController = new AbortController();
    const getTimeoutId = setTimeout(() => getController.abort(), timeout);
    try {
      const response = await fetch(url, { ...fetchOptions, method: 'GET', signal: getController.signal });
      clearTimeout(getTimeoutId);
      result = headersFromResponse(response);
    } catch (getError) {
      clearTimeout(getTimeoutId);
      const message = getError?.message || String(getError);
      result = { cdn: 'unknown', error: message };
    }
  }

  if (result.cdn === 'unknown') {
    const fallback = await Promise.race([
      detectCdnFromDnsFallback(url, { log }),
      new Promise((resolve) => {
        setTimeout(() => resolve({ cdn: 'unknown' }), fallbackTimeout);
      }),
    ]);
    if (fallback.cdn !== 'unknown') {
      return { cdn: fallback.cdn, error: result.error };
    }
  }

  return result;
}

/**
 * Phase 2 entry: returns the LLMO byocdn-X token for a detected CDN, or null.
 */
async function detectGenericCdnToken(url, log) {
  const { cdn } = await detectCdnFromUrl(url, { log });
  if (cdn === 'unknown') {
    return null;
  }
  const token = LABEL_TO_LLMO_TOKEN[cdn];
  if (token) {
    return token;
  }
  /* c8 ignore next 3 -- defensive; every label the detector can return is in LABEL_TO_LLMO_TOKEN */
  log?.warn?.('[cdn-detection] Phase 2 returned unmapped label', { cdn });
  return null;
}

/* ============================================================================
 * Public entry point.
 * ========================================================================== */

/**
 * Detects the CDN for a given hostname or URL.
 *
 * Two-phase detection:
 *   Phase 1 — DNS-only check for Adobe-managed CDNs (AEM CS Fastly,
 *             Adobe Commerce Cloud Fastly). Cheap and authoritative when matched.
 *   Phase 2 — When Phase 1 doesn't match, runs a multi-signal probe ported from
 *             spacecat-audit-worker (HTTP headers → CNAME chain → DoH → ASN →
 *             PTR keywords). Result is mapped from a descriptive label to the
 *             LLMO byocdn-X token via LABEL_TO_LLMO_TOKEN.
 *
 * Returns:
 *   - 'aem-cs-fastly' | 'commerce-fastly'  — Phase 1 hit
 *   - 'byocdn-<provider>'                  — Phase 2 hit (mapped via adapter)
 *   - 'other'                               — both phases ran cleanly, nothing matched
 *   - null                                  — at least one signal failed (inconclusive)
 *
 * Never throws.
 *
 * @param {string} input - bare hostname (e.g. 'example.com') or full URL.
 * @param {object} [log] - Optional logger.
 * @returns {Promise<string|null>}
 */
export async function detectCdnForDomain(input, log) {
  try {
    const trimmed = (input || '').trim();
    if (!trimmed) {
      return null;
    }

    const hasScheme = /^https?:\/\//i.test(trimmed);
    let hostname;
    let url;
    try {
      const parsed = new URL(hasScheme ? trimmed : `https://${trimmed}`);
      hostname = parsed.hostname;
      url = parsed.toString();
    } catch {
      return null;
    }
    /* c8 ignore next 3 -- defensive; URL parser guarantees a non-empty hostname when it succeeds */
    if (!hostname) {
      return null;
    }

    const bareDomain = hostname.replace(/^www\./i, '');
    log?.info?.(`[cdn-detection] Detecting CDN for domain ${bareDomain}`);

    const phase1 = await detectAdobeManagedCdn(bareDomain, log);
    if (phase1 === 'aem-cs-fastly' || phase1 === 'commerce-fastly') {
      return phase1;
    }

    const phase2Token = await detectGenericCdnToken(url, log);
    if (phase2Token) {
      return phase2Token;
    }

    if (phase1 === null) {
      return null;
    }
    return 'other';
    /* c8 ignore next 4 */
  } catch (err) {
    log?.warn?.('[cdn-detection] Unexpected error', { message: err?.message });
    return null;
  }
}
