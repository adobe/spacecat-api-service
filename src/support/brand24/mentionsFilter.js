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
 * Drops Brand24 `/mentions` results that aren't usable as a "source" in
 * project-elmo-ui's Market Discovery dashboard: no working link (a missing
 * `source`, or one that isn't a real http(s) URL — e.g. X/Twitter's own
 * `"Tweet-ID: <id>"` value) or no resolvable domain (`host`). Both the
 * Sources tab (individual mentions) and the Domains tab (mentions grouped by
 * `host`) read this same response, so filtering it once here — instead of
 * client-side, per dashboard — keeps every consumer consistent and never
 * ships a broken-link/unattributable row over the wire at all.
 */

const HTTP_URL_RE = /^https?:\/\//i;
/**
 * Loose hostname check — catches obviously-broken domain strings (blank, whitespace, no TLD)
 * without over-engineering a full RFC 1035 validator: at least one `label.label` segment, made up
 * only of letters/digits/hyphens.
 */
const PLAUSIBLE_DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

function hasUsableSource(mention) {
  return typeof mention?.source === 'string' && HTTP_URL_RE.test(mention.source);
}

function hasUsableHost(mention) {
  return typeof mention?.host === 'string' && PLAUSIBLE_DOMAIN_RE.test(mention.host);
}

export function filterUsableMentions(results) {
  if (!Array.isArray(results)) {
    return results;
  }
  return results.filter((mention) => hasUsableSource(mention) && hasUsableHost(mention));
}
