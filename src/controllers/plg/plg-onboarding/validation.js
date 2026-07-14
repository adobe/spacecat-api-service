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

import { isIP } from 'node:net';
import PlgOnboardingModel from '@adobe/spacecat-shared-data-access/src/models/plg-onboarding/plg-onboarding.model.js';

// EDS host pattern: ref--repo--owner.aem.live (or hlx.live)
export const EDS_HOST_PATTERN = /^([\w-]+)--([\w-]+)--([\w-]+)\.(aem\.live|hlx\.live)$/i;

// AEM CS publish host pattern: publish-p{programId}-e{environmentId}.adobeaemcloud.com
export const AEM_CS_PUBLISH_HOST_PATTERN = /^publish-p(\d+)-e(\d+)\.adobeaemcloud\.(com|net)$/i;

// AEM CS author URL pattern: https://author-p{programId}-e{environmentId}[-suffix].adobeaemcloud.com
export const AEM_CS_AUTHOR_URL_PATTERN = /^https?:\/\/author-p(\d+)-e(\d+)(?:-[^.]+)?\.adobeaemcloud\.(?:com|net)/i;

// Strip http:// or https:// scheme so callers can pass either scheme-prefixed input or a bare
// hostname/path. Only the scheme is removed — port, userinfo, query, and fragment are NOT
// stripped and will be rejected by the domain validator downstream.
const stripScheme = (s) => s.replace(/^https?:\/\//i, '');

/**
 * Prepare a raw user-supplied domain for validation and persistence: strip scheme, then
 * lowercase via PlgOnboarding.normalizeDomain so callers can pass mixed-case input.
 * The shared schema requires lowercase, so callers must normalize before validating
 * or saving — otherwise the data-access layer would reject the write.
 * @param {string} raw - The raw user-supplied domain.
 * @returns {string} normalized domain.
 */
export const prepareDomain = (raw) => PlgOnboardingModel.normalizeDomain(stripScheme(raw));

/**
 * Delegates to the shared PlgOnboarding.isValidDomain validator so this service, the
 * data-access schema (plg-onboarding.schema.js), and any future consumer share a single
 * implementation. Do NOT import DOMAIN_PATTERN directly — it is incomplete on its own
 * (no length cap, no all-numeric/short-form-IP rejection, no control-char check).
 * @param {string} domain - The domain to validate.
 * @returns {boolean} true if valid, false otherwise.
 */
export const isValidDomain = (domain) => PlgOnboardingModel.isValidDomain(domain);

/**
 * Validates that a domain is not a private/internal address to prevent SSRF.
 *
 * IMPORTANT ordering contract: callers MUST invoke prepareDomain() and isValidDomain() BEFORE
 * this function. The hostname is extracted via `split('/')[0]`, so if a raw scheme-prefixed
 * input like "https://10.0.0.1" reaches this function, the split yields "https:" and the
 * private-IP blocklist is bypassed. isValidDomain() rejects any scheme-prefixed input, which
 * is what makes this contract safe.
 *
 * Defense in depth: the raw input is first canonicalized via the WHATWG URL parser so that
 * hex/decimal/octal IP forms (e.g. 0xa9.254.169.254 → 169.254.169.254 AWS IMDS) and
 * IPv6 forms are normalized before denylist matching. The shared isValidDomain already
 * rejects these via its alphabetic-TLD requirement, but canonicalizing here closes the
 * gap if a future caller composes a bypass that survives validation.
 *
 * @param {string} domain - The domain to validate (may include a path, e.g. "nba.com/kings").
 * @returns {boolean} true if safe, false if potentially dangerous.
 */
export function isSafeDomain(domain) {
  const rawHostname = domain.split('/')[0];
  let hostname;
  try {
    hostname = new URL(`https://${rawHostname}`).hostname;
  } catch {
    return false;
  }
  // net.isIP returns 4 (IPv4), 6 (IPv6), or 0 (not an IP). new URL serializes IPv6
  // hostnames WITH brackets (`[fd00::1]`), which makes a naive isIP(hostname) check
  // return 0 and silently misses every IPv6 private/loopback/link-local/IPv4-mapped
  // form. Unwrap the brackets before the isIP test so the backstop catches IPv6
  // literals (RFC 4193 ULA, RFC 4291 link-local, IPv4-mapped IMDS, etc.) too.
  const ipLiteral = hostname.replace(/^\[|\]$/g, '');
  if (isIP(ipLiteral)) {
    return false;
  }
  const blocked = [
    /^localhost$/i,
    /\.localhost$/i,
    /^127\./,
    /^10\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./,
    /^169\.254\./,
    /^0\./,
    // RFC 6761 reserves .localhost for loopback; runtime resolution is platform-dependent
    // (Linux glibc/systemd hardcode it; macOS does not), so the static gate is required.
    /^\[::1\]/,
    /\.local$/i,
    /\.internal$/i,
    /\.private\./i,
  ];
  return !blocked.some((pattern) => pattern.test(hostname));
}
