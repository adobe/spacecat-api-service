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

/**
 * Validates that a domain is not a private/internal address to prevent SSRF.
 *
 * Lives in `src/support/` (not under a controller) so it can be shared by lower-level probes
 * such as `detect-auth-wall.js` without a layer inversion. `plg-onboarding/validation.js`
 * re-exports it for the onboarding callers that already import it from there.
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

/**
 * Reduces a URL to a bounded, markup-safe string for use in a user-facing "reason" field that
 * is persisted to the DB and forwarded to Slack (mrkdwn).
 *
 * The host is expected to already be validated public by isSafeDomain, but the path, query and
 * fragment remain attacker-controlled. We therefore keep only `scheme://host/path` and drop the
 * query + fragment entirely (the primary injection surface). The WHATWG URL parser already
 * percent-encodes `<`, `>` and backtick in the path; we additionally strip the residual Slack
 * mrkdwn formatting characters and any control chars, then cap the length. The result is safe
 * to persist and to interpolate into a Slack message without breaking out of the reason string.
 *
 * @param {string} url - the URL to reduce (typically a probe's resolved finalUrl).
 * @returns {string} a safe display string, or '' when the URL cannot be parsed.
 */
export function sanitizeUrlForReason(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`
      .replace(/[<>|`*_~\r\n\t]/g, '')
      .slice(0, 256);
  } catch {
    return '';
  }
}
