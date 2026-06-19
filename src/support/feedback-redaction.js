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
 * @fileoverview Defence-in-depth redaction for captured human-review feedback
 * (SITES-43974, §11.3 / NFR-05). Two concerns:
 *
 *  1. Secret-pattern scrub over `previous_fix`, `edited_fix`, and
 *     `detail_markdown` before the row is persisted. Even if a customer's code
 *     accidentally contains a credential, it never lands in the corpus.
 *  2. Allowlist-ish HTML sanitisation of `detail_markdown` — script / style /
 *     iframe / event-handler / dangerous-URI stripping.
 *
 * The scrub never fails the row: the ESE has already submitted their verdict;
 * we redact and continue (don't lose the signal).
 */

/**
 * Secret patterns. Each match is replaced inline with `[[REDACTED:<label>]]`.
 * Ordered most-specific first so a broad pattern can't shadow a precise one.
 * @type {Array<{ label: string, re: RegExp }>}
 */
export const SECRET_PATTERNS = [
  { label: 'pem_private_key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g },
  { label: 'aws_access_key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { label: 'github_pat', re: /\bghp_[A-Za-z0-9]{20,}\b/g },
  { label: 'gitlab_pat', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { label: 'slack_token', re: /\bxox[bpars]-[A-Za-z0-9-]{10,}\b/g },
  { label: 'llm_api_key', re: /\bsk-(?:lf-)?[A-Za-z0-9]{16,}\b/g },
  { label: 'bearer_token', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/g },
  { label: 'jwt', re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
  { label: 'basic_auth_url', re: /\bhttps?:\/\/[^/:@\s]+:[^/@\s]+@/g },
  { label: 'adobe_internal_host', re: /\b[A-Za-z0-9-]+\.(?:corp\.adobe\.com|ethos[A-Za-z0-9-]*\.dev\.adobeaemcloud\.com)\b/g },
  { label: 'adobe_email', re: /\b[A-Za-z0-9._%+-]+@adobe\.com\b/g },
];

/**
 * Strip dangerous HTML from a markdown string (NFR-05). Removes
 * script/style/iframe blocks, inline event-handler attributes, and
 * javascript:/data: URI schemes. Conservative — leaves ordinary markdown intact.
 *
 * @param {string} markdown
 * @returns {string} sanitised markdown
 */
export function sanitizeMarkdown(markdown) {
  if (typeof markdown !== 'string') {
    return markdown;
  }
  return markdown
    // drop whole script/style/iframe elements (with or without a closing tag)
    .replace(/<\s*(script|style|iframe)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|style|iframe)\b[^>]*>/gi, '')
    // strip inline event-handler attributes: onclick=, onerror=, ...
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    // neutralise dangerous URI schemes
    .replace(/javascript:/gi, '')
    .replace(/data:(?=text\/html|application)/gi, '');
}

/**
 * Scrub secret patterns from a single string.
 *
 * @param {string} value
 * @param {Record<string, number>} hits - accumulator: pattern label -> count.
 * @returns {string} the scrubbed string
 */
function scrubString(value, hits) {
  let out = value;
  for (const { label, re } of SECRET_PATTERNS) {
    out = out.replace(re, () => {
      hits[label] = (hits[label] || 0) + 1;
      return `[[REDACTED:${label}]]`;
    });
  }
  return out;
}

/**
 * Recursively scrub secret patterns from a string / object / array value
 * (e.g. a `previous_fix` jsonb patch). Returns a new value; the input is not
 * mutated. Non-string leaves (numbers, booleans, null) pass through untouched.
 *
 * @param {*} value
 * @param {Record<string, number>} hits - accumulator: pattern label -> count.
 * @returns {*} scrubbed copy of value
 */
export function scrubDeep(value, hits) {
  if (typeof value === 'string') {
    return scrubString(value, hits);
  }
  if (Array.isArray(value)) {
    return value.map((v) => scrubDeep(v, hits));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).reduce((acc, [k, v]) => {
      acc[k] = scrubDeep(v, hits);
      return acc;
    }, {});
  }
  return value;
}

/**
 * Redact a captured feedback payload: secret-scrub all three customer-derived
 * fields and HTML-sanitise the markdown. Returns the cleaned fields plus a
 * per-pattern hit map for metrics (`feedback_capture.scrub_hit_total`).
 *
 * @param {object} input
 * @param {string} [input.detailMarkdown]
 * @param {*} [input.previousFix]
 * @param {*} [input.editedFix]
 * @returns {{ detailMarkdown: (string|undefined), previousFix: *, editedFix: *,
 *   scrubHits: Record<string, number> }}
 */
export function redactFeedbackContent({ detailMarkdown, previousFix, editedFix } = {}) {
  const scrubHits = {};

  let cleanMarkdown = detailMarkdown;
  if (typeof detailMarkdown === 'string') {
    cleanMarkdown = scrubString(sanitizeMarkdown(detailMarkdown), scrubHits);
  }

  return {
    detailMarkdown: cleanMarkdown,
    previousFix: previousFix === undefined ? undefined : scrubDeep(previousFix, scrubHits),
    editedFix: editedFix === undefined ? undefined : scrubDeep(editedFix, scrubHits),
    scrubHits,
  };
}
