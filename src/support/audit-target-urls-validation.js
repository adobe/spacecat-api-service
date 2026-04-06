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

/**
 * API validation for audit target URLs: parseable absolute URL, HTTPS only, and hostname
 * must match the site base URL hostname when that can be derived (same idea as ASO UI
 * siteDomain + https check, without the stricter paste/whitespace rules).
 */

/**
 * @param {string} baseURL
 * @returns {string|null}
 */
export function siteHostnameFromBaseURL(baseURL) {
  if (!baseURL || typeof baseURL !== 'string') {
    return null;
  }
  try {
    return new URL(baseURL).hostname;
  } catch {
    return null;
  }
}

/**
 * @param {string} trimmed
 * @param {string|null} siteHostname
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validateAuditTargetUrlString(trimmed, siteHostname) {
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: 'Invalid URL' };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, error: 'URL must use HTTPS' };
  }
  if (siteHostname && url.hostname !== siteHostname) {
    return {
      ok: false,
      error: `URL hostname must match the site domain (${siteHostname})`,
    };
  }
  return { ok: true };
}

/**
 * Validates config.auditTargetURLs after merge (manual list only).
 *
 * @param {unknown} auditTargetURLs
 * @param {string} siteBaseURL
 * @returns {{ ok: true, normalized?: object } | { ok: false, error: string }}
 */
export function validateAuditTargetURLsConfig(auditTargetURLs, siteBaseURL) {
  if (auditTargetURLs === undefined) {
    return { ok: true };
  }
  if (auditTargetURLs === null || typeof auditTargetURLs !== 'object' || Array.isArray(auditTargetURLs)) {
    return { ok: false, error: 'config.auditTargetURLs must be an object when provided' };
  }

  const siteHostname = siteHostnameFromBaseURL(siteBaseURL);
  const { manual, ...rest } = auditTargetURLs;

  if (manual === undefined) {
    return { ok: true };
  }
  if (!Array.isArray(manual)) {
    return { ok: false, error: 'config.auditTargetURLs.manual must be an array' };
  }

  const normalizedManual = [];
  for (let i = 0; i < manual.length; i += 1) {
    const entry = manual[i];
    if (!entry || typeof entry !== 'object' || typeof entry.url !== 'string') {
      return {
        ok: false,
        error: `config.auditTargetURLs.manual[${i}] must be an object with a string "url" property`,
      };
    }
    const trimmed = entry.url.trim();
    const result = validateAuditTargetUrlString(trimmed, siteHostname);
    if (!result.ok) {
      return { ok: false, error: `Invalid audit target URL at index ${i}: ${result.error}` };
    }
    normalizedManual.push({ url: trimmed });
  }

  return {
    ok: true,
    normalized: { ...rest, manual: normalizedManual },
  };
}

/**
 * When `configPatch` includes `auditTargetURLs`, validates `merged.auditTargetURLs` (HTTPS +
 * hostname vs site) and writes normalized `manual` entries back onto `merged`.
 *
 * We must consult `configPatch`, not only `merged`: after `{ ...existingConfig, ...patch }`,
 * `merged.auditTargetURLs` is still present if it existed on the site and the client only
 * changed other keys (e.g. `slack`). In that case we must not re-validate or reject legacy
 * data until the client explicitly sends `auditTargetURLs` again.
 *
 * @param {Record<string, unknown>} merged
 * @param {string} siteBaseURL
 * @param {Record<string, unknown>} configPatch
 * @param {(message: string) => unknown} badRequestFn
 * @returns {null | { error: unknown } | { normalized?: object }}
 *   `null` if the patch did not include `auditTargetURLs`; `{ error }` to return from the
 *   controller; `{ normalized }` or `{}` on success (caller assigns `normalized` to merged).
 */
export function auditTargetURLsPatchGuard(merged, siteBaseURL, configPatch, badRequestFn) {
  if (!Object.prototype.hasOwnProperty.call(configPatch, 'auditTargetURLs')) {
    return null;
  }
  const v = validateAuditTargetURLsConfig(merged.auditTargetURLs, siteBaseURL);
  if (!v.ok) return { error: badRequestFn(v.error) };
  return v.normalized !== undefined ? { normalized: v.normalized } : {};
}
