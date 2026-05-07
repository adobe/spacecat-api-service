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

// EDS host pattern: ref--repo--owner.aem.live (or hlx.live)
export const EDS_HOST_PATTERN = /^([\w-]+)--([\w-]+)--([\w-]+)\.(aem\.live|hlx\.live)$/i;

// AEM CS author URL pattern: https://author-p{programId}-e{environmentId}[-suffix].adobeaemcloud.com
export const AEM_CS_AUTHOR_URL_PATTERN = /^https?:\/\/author-p(\d+)-e(\d+)(?:-[^.]+)?\.adobeaemcloud\.(?:com|net)/i;

// RFC 1123 hostname: labels of 1-63 alphanumeric/hyphen chars, separated by dots, max 253 chars
const HOSTNAME_RE = /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

/**
 * Validates that a domain is a syntactically valid hostname (RFC 1123).
 * @param {string} domain - The domain to validate.
 * @returns {boolean} true if valid hostname, false otherwise.
 */
export function isValidHostname(domain) {
  return HOSTNAME_RE.test(domain);
}

/**
 * Validates that a domain is not a private/internal address to prevent SSRF.
 * @param {string} domain - The domain to validate.
 * @returns {boolean} true if safe, false if potentially dangerous.
 */
export function isSafeDomain(domain) {
  const blocked = [
    /^localhost$/i,
    /^127\./,
    /^10\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./,
    /^169\.254\./,
    /^0\./,
    /^\[::1\]/,
    /\.local$/i,
    /\.internal$/i,
    /\.private\./i,
  ];
  return !blocked.some((pattern) => pattern.test(domain));
}
