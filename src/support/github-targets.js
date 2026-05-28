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
// Secrets are NOT in this registry: webhookSecretEnvVar names the env var that
// carries the secret (injected from the deploy secret store).

/**
 * Parse + validate the GITHUB_TARGETS env var.
 * @param {object} env - context.env
 * @returns {Array|null} ordered target array, or null when GITHUB_TARGETS is
 *   unset (legacy single-secret mode).
 * @throws {Error} when GITHUB_TARGETS is set but structurally invalid.
 */
export function parseTargets(env) {
  const raw = env?.GITHUB_TARGETS;
  if (!raw) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`GITHUB_TARGETS is not valid JSON: ${e.message}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('GITHUB_TARGETS must be a non-empty JSON array');
  }
  const ids = new Set();
  parsed.forEach((t, i) => {
    if (!t || typeof t.id !== 'string' || !t.id) {
      throw new Error(`GITHUB_TARGETS[${i}] is missing a string "id"`);
    }
    if (ids.has(t.id)) {
      throw new Error(`GITHUB_TARGETS has duplicate id "${t.id}"`);
    }
    ids.add(t.id);
    if (typeof t.appSlug !== 'string' || !t.appSlug) {
      throw new Error(`GITHUB_TARGETS["${t.id}"] is missing a string "appSlug"`);
    }
    if (typeof t.webhookSecretEnvVar !== 'string' || !t.webhookSecretEnvVar) {
      throw new Error(`GITHUB_TARGETS["${t.id}"] is missing a string "webhookSecretEnvVar"`);
    }
    const isDefault = t.match?.default === true;
    const hasSlugs = Array.isArray(t.match?.enterpriseSlug)
      && t.match.enterpriseSlug.length > 0
      && t.match.enterpriseSlug.every((s) => typeof s === 'string' && s.length > 0);
    if (!isDefault && !hasSlugs) {
      throw new Error(`GITHUB_TARGETS["${t.id}"] needs match.default:true or a non-empty match.enterpriseSlug[] of strings`);
    }
    if (isDefault && i !== parsed.length - 1) {
      throw new Error(`GITHUB_TARGETS default entry "${t.id}" must be last`);
    }
  });
  const defaults = parsed.filter((t) => t.match?.default === true);
  if (defaults.length !== 1) {
    throw new Error(`GITHUB_TARGETS must have exactly one match.default:true entry (found ${defaults.length})`);
  }
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
 * Classify webhook metadata to a target, or signal skip.
 * @param {{host: (string|null), enterpriseSlug: (string|null)}} meta
 * @param {Array} targets - validated registry (default entry last)
 * @returns {object|{skip: true}} the matched target, or { skip: true }
 */
export function classify(meta, targets) {
  const { host, enterpriseSlug } = meta;
  // A positively-identified non-github.com host (e.g. a GHES host) has no
  // in-scope target. A null/unknown host (ping / no repository) falls through
  // to the github.com catch-all.
  if (host !== null && host !== 'github.com') {
    return { skip: true };
  }
  // Registry is validated default-last (parseTargets), so a slug-specific entry
  // is always evaluated before the catch-all default in this find loop.
  const match = targets.find((t) => t.match?.default === true
    || (enterpriseSlug
        && Array.isArray(t.match?.enterpriseSlug)
        && t.match.enterpriseSlug.includes(enterpriseSlug)));
  return match || { skip: true };
}
