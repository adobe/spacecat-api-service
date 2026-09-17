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
 * Allowlist for Slack file downloads (VULN-39365, defence in depth).
 *
 * Slack file objects carry a `url_private` that the service fetches with the bot token in an
 * `Authorization: Bearer` header. Because the file object originates in the request payload,
 * anyone who can reach a Slack handler with a forged payload can point `url_private` at a host
 * they control and harvest the token from the outbound request.
 *
 * `slackSignatureWrapper` is the primary fix — it stops forged payloads reaching a handler at
 * all. This module is the second layer: even with a valid signature (a compromised workspace, a
 * malicious insider, or a future code path that reintroduces an unauthenticated entry point),
 * the bot token is only ever sent to Slack-owned hosts.
 *
 * Note this must be an ALLOWLIST. `src/support/url-safety.js#isSafeDomain` is a denylist of
 * private/internal ranges; an attacker-controlled *public* host passes it unharmed, so it is
 * not a substitute here.
 */

// Slack serves file downloads from files.slack.com, and *.slack.com more broadly
// (e.g. <workspace>.slack.com). Anything else is rejected.
const ALLOWED_SLACK_FILE_HOSTS = new Set(['slack.com', 'files.slack.com']);
const ALLOWED_SLACK_HOST_SUFFIX = '.slack.com';

/**
 * True when the URL is an https URL served by a Slack-owned host, and therefore a safe
 * destination for a request carrying the bot token.
 *
 * Uses the WHATWG URL parser so that userinfo tricks (`https://files.slack.com@evil.test/`),
 * encoded hosts and alternate IP notations are normalised before the host is compared — the
 * parser assigns `hostname` from the real authority, not the userinfo prefix.
 *
 * @param {string} url - the candidate URL (typically a Slack file's `url_private`).
 * @returns {boolean} true when the URL may be fetched with the bot token attached.
 */
export function isSlackFileUrl(url) {
  if (typeof url !== 'string' || url.length === 0) {
    return false;
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  // Plaintext http would expose the bearer token on the wire.
  if (parsed.protocol !== 'https:') {
    return false;
  }

  const hostname = parsed.hostname.toLowerCase();
  return ALLOWED_SLACK_FILE_HOSTS.has(hostname) || hostname.endsWith(ALLOWED_SLACK_HOST_SUFFIX);
}

/**
 * Throws unless the URL is a Slack-owned https URL. Call this immediately before any fetch that
 * attaches the Slack bot token.
 *
 * The rejected URL is deliberately NOT interpolated into the error message: the message reaches
 * Slack and the logs, and the URL is attacker-controlled.
 *
 * @param {string} url - the candidate URL.
 * @throws {Error} when the URL is not a Slack-owned https URL.
 */
export function assertSlackFileUrl(url) {
  if (!isSlackFileUrl(url)) {
    throw new Error('Refusing to download file: URL is not a Slack-hosted https URL.');
  }
}
