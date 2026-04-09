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
 * must match the site base URL hostname when that can be derived.
 */

/** Upper bound for manual audit target URLs per site (align with ASO UI). */
export const MAX_MANUAL_AUDIT_TARGET_URLS = 500;

/** Upper bound for moneyPages audit target URLs per site. */
export const MAX_MONEY_PAGES_AUDIT_TARGET_URLS = 500;

/** Known sources and their maximum URL counts. */
const AUDIT_TARGET_URL_SOURCE_LIMITS = {
  manual: MAX_MANUAL_AUDIT_TARGET_URLS,
  moneyPages: MAX_MONEY_PAGES_AUDIT_TARGET_URLS,
};

/**
 * Compare hostnames as equal if they match after lowercasing and stripping one leading `www.`.
 *
 * @param {string} hostname
 * @returns {string}
 */
export function normalizeHostnameForAuditTargetMatch(hostname) {
  const lower = hostname.toLowerCase();
  return lower.startsWith('www.') ? lower.slice(4) : lower;
}

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
  if (
    siteHostname
    && normalizeHostnameForAuditTargetMatch(url.hostname)
      !== normalizeHostnameForAuditTargetMatch(siteHostname)
  ) {
    return {
      ok: false,
      error: `URL hostname must match the site domain (${siteHostname}, with or without www.)`,
    };
  }
  return { ok: true };
}

/**
 * Validates config.auditTargetURLs after merge (all known sources).
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
  const normalizedSources = {};
  let anySourcePresent = false;

  for (const [sourceName, maxCount] of Object.entries(AUDIT_TARGET_URL_SOURCE_LIMITS)) {
    const list = auditTargetURLs[sourceName];
    if (list !== undefined) {
      anySourcePresent = true;
      if (!Array.isArray(list)) {
        return { ok: false, error: `config.auditTargetURLs.${sourceName} must be an array` };
      }
      if (list.length > maxCount) {
        return {
          ok: false,
          error: `config.auditTargetURLs.${sourceName} cannot contain more than ${maxCount} URLs`,
        };
      }
      const normalized = [];
      for (let i = 0; i < list.length; i += 1) {
        const entry = list[i];
        if (!entry || typeof entry !== 'object' || typeof entry.url !== 'string') {
          return {
            ok: false,
            error: `config.auditTargetURLs.${sourceName}[${i}] must be an object with a string "url" property`,
          };
        }
        const trimmed = entry.url.trim();
        const result = validateAuditTargetUrlString(trimmed, siteHostname);
        if (!result.ok) {
          return { ok: false, error: `Invalid audit target URL at index ${i}: ${result.error}` };
        }
        normalized.push({ url: trimmed });
      }
      normalizedSources[sourceName] = normalized;
    }
  }

  if (!anySourcePresent) {
    return { ok: true };
  }

  // Preserve any keys not in AUDIT_TARGET_URL_SOURCE_LIMITS (passed through, stripped by schema)
  const knownKeys = Object.keys(AUDIT_TARGET_URL_SOURCE_LIMITS);
  const rest = Object.fromEntries(
    Object.entries(auditTargetURLs).filter(([k]) => !knownKeys.includes(k)),
  );

  return { ok: true, normalized: { ...rest, ...normalizedSources } };
}

/**
 * When `configPatch` includes `auditTargetURLs`, validates only the sources the client
 * explicitly sent (`configPatch.auditTargetURLs`) against HTTPS + hostname rules, then
 * merges the normalized results over the already-deep-merged `merged.auditTargetURLs`
 * so that unpatched sources (e.g. existing `moneyPages` when only `manual` was sent)
 * are preserved without being re-validated against the current site hostname.
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
  // Validate only the sources the client sent, not pre-existing ones folded in by deep-merge.
  const v = validateAuditTargetURLsConfig(configPatch.auditTargetURLs, siteBaseURL);
  if (!v.ok) {
    return { error: badRequestFn(v.error) };
  }
  // Merge validated+normalized patch sources over the existing merged sources so unpatched
  // sources are preserved in the value returned to the caller.
  return v.normalized !== undefined
    ? { normalized: { ...merged.auditTargetURLs, ...v.normalized } }
    : {};
}
