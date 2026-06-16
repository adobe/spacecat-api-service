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

// GitHub destination registry + classifier. The web tier classifies each
// inbound webhook to a destination ("target") from the SIGNED body, so the
// worker can select per-destination credentials by a non-secret target_id.
// The GITHUB_DESTINATIONS registry carries webhook_secret INLINE in each entry
// (loaded at runtime from Vault into context.env; secret-bearing - do not log
// the value).

/**
 * Parse + validate the GITHUB_DESTINATIONS env var (the consolidated registry).
 * A keyed object by target_id; each entry is { match, webhook_secret,
 * reviewer_login } with snake_case keys. The webhook secret is INLINE in each
 * entry. Loaded at runtime from Vault into context.env (secret-bearing - do not
 * log the value).
 * @param {object} env - context.env
 * @returns {object|null} the keyed destinations object, or null when
 *   GITHUB_DESTINATIONS is unset (the handler treats unset as a misconfiguration
 *   and fails closed).
 * @throws {Error} when GITHUB_DESTINATIONS is set but structurally invalid.
 */
export function parseDestinations(env) {
  const raw = env?.GITHUB_DESTINATIONS;
  if (!raw) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`GITHUB_DESTINATIONS is not valid JSON: ${e.message}`);
  }
  // A keyed object (not the legacy ordered array). Reject arrays and
  // non-objects explicitly so a misformatted value fails loudly at parse.
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length === 0) {
    throw new Error('GITHUB_DESTINATIONS must be a non-empty JSON object keyed by target_id');
  }
  Object.entries(parsed).forEach(([targetId, entry]) => {
    // The key IS the worker's SQS target_id; enforce the worker's charset so a
    // bad id fails loudly at parse and stays a bounded value where it is logged.
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(targetId)) {
      throw new Error(`GITHUB_DESTINATIONS key "${targetId}" must match ^[a-z][a-z0-9-]{0,63}$ (it becomes the worker target_id)`);
    }
    if (!entry || typeof entry !== 'object') {
      throw new Error(`GITHUB_DESTINATIONS["${targetId}"] must be an object`);
    }
    const isDefault = entry.match?.default === true;
    const hasSlugs = Array.isArray(entry.match?.enterprise_slug)
      && entry.match.enterprise_slug.length > 0
      && entry.match.enterprise_slug.every((s) => typeof s === 'string' && s.length > 0);
    // match MUST be EXACTLY ONE of default:true or a non-empty enterprise_slug[]
    // of strings. Both or neither is rejected here (the registry-level
    // "exactly one default" check below catches the all-enterprise / no-default
    // case; this catches a single malformed entry).
    if (isDefault === hasSlugs) {
      throw new Error(`GITHUB_DESTINATIONS["${targetId}"].match must be exactly one of { default: true } or a non-empty enterprise_slug[] of strings`);
    }
    if (typeof entry.webhook_secret !== 'string' || !entry.webhook_secret) {
      throw new Error(`GITHUB_DESTINATIONS["${targetId}"] is missing a string "webhook_secret"`);
    }
    // reviewer_login is required on EVERY entry (no global fallback in the
    // consolidated registry). Accept plain users (MysticatBot), EMU users
    // (handle_shortcode), and App bots (slug[bot]).
    if (typeof entry.reviewer_login !== 'string'
      || entry.reviewer_login.length > 64
      || !/^[A-Za-z0-9][A-Za-z0-9_-]*(\[bot\])?$/.test(entry.reviewer_login)) {
      throw new Error(`GITHUB_DESTINATIONS["${targetId}"].reviewer_login must be a non-empty string matching ^[A-Za-z0-9][A-Za-z0-9_-]*(\\[bot\\])?$ and be at most 64 chars`);
    }
  });
  const defaults = Object.values(parsed).filter((e) => e.match?.default === true);
  if (defaults.length !== 1) {
    throw new Error(`GITHUB_DESTINATIONS must have exactly one match.default:true entry (found ${defaults.length})`);
  }
  // The ADR requires match rules to be mutually exclusive. Duplicate
  // enterprise_slug values across entries would cause classifyDestination's
  // .find to silently pick the first match, hiding the misconfiguration.
  const slugSeen = new Map();
  Object.entries(parsed).forEach(([targetId, entry]) => {
    (entry.match?.enterprise_slug || []).forEach((slug) => {
      if (slugSeen.has(slug)) {
        throw new Error(`GITHUB_DESTINATIONS has duplicate enterprise_slug "${slug}" (in "${targetId}" and "${slugSeen.get(slug)}")`);
      }
      slugSeen.set(slug, targetId);
    });
  });
  return parsed;
}

function hostOf(htmlUrl) {
  if (typeof htmlUrl !== 'string') {
    return null;
  }
  try {
    return new URL(htmlUrl).host;
  } catch {
    return null;
  }
}

/**
 * Extract the classification signals from the raw (signed) webhook body.
 * @param {string} rawBody
 * @returns {{host: (string|null), enterpriseSlug: (string|null)}|null} null when
 *   the body is not valid JSON.
 */
export function extractClassificationMetadata(rawBody) {
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const enterpriseSlug = typeof payload.enterprise?.slug === 'string' ? payload.enterprise.slug : null;
  return { host: hostOf(payload.repository?.html_url), enterpriseSlug };
}

/**
 * Classify webhook metadata to a destination, or signal skip. Match-type
 * priority (NOT array position): host pre-filter, then an enterprise_slug
 * match, then the single default entry.
 * @param {{host: (string|null), enterpriseSlug: (string|null)}} meta
 * @param {object} destinations - validated keyed registry from parseDestinations
 * @returns {object|{skip: true}} { target_id, webhook_secret, reviewer_login }
 *   of the matched destination, or { skip: true }. Only the fields the caller
 *   needs are returned (match is not leaked alongside the secret).
 */
export function classifyDestination(meta, destinations) {
  const { host, enterpriseSlug } = meta;
  // A positively-identified non-github.com host (e.g. a GHES host) has no
  // in-scope destination. A null/unknown host (ping / no repository) falls
  // through to the github.com catch-all (the default entry).
  if (host !== null && host !== 'github.com') {
    return { skip: true };
  }
  const entries = Object.entries(destinations);
  // Enterprise entries are evaluated BEFORE the default (match-type priority).
  if (enterpriseSlug) {
    const enterprise = entries.find(([, entry]) => Array.isArray(entry.match?.enterprise_slug)
      && entry.match.enterprise_slug.includes(enterpriseSlug));
    if (enterprise) {
      const [targetId, entry] = enterprise;
      return {
        target_id: targetId,
        webhook_secret: entry.webhook_secret,
        reviewer_login: entry.reviewer_login,
      };
    }
  }
  const fallback = entries.find(([, entry]) => entry.match?.default === true);
  if (fallback) {
    const [targetId, entry] = fallback;
    return {
      target_id: targetId,
      webhook_secret: entry.webhook_secret,
      reviewer_login: entry.reviewer_login,
    };
  }
  return { skip: true };
}
