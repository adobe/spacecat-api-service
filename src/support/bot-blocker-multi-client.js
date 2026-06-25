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

import {
  detectBotBlocker, analyzeBotProtection, SPACECAT_USER_AGENT,
} from '@adobe/spacecat-shared-utils';

const PROBE_TIMEOUT_MS = 10000;

/**
 * Probes a URL with Node's native fetch (undici) and classifies the response.
 *
 * undici is the HTTP client used by CWV liveness, preflight, site-detection, and the
 * import-worker. Cloudflare Bot Management fingerprints the client (TLS/HTTP, JA3/JA4),
 * so a site can allow the @adobe/fetch client while blocking undici (and headless
 * Chrome). We send the same User-Agent the @adobe/fetch probe uses so the ONLY
 * difference between the two probes is the client itself.
 *
 * A request we cannot complete (timeout/network) is reported as inconclusive
 * (crawlable, low confidence) rather than blocked — we only assert a block when the
 * response actually classifies as one.
 *
 * @param {string} baseUrl - URL to probe.
 * @param {Object} headers - Optional extra headers (e.g. site scraper headers).
 * @param {Object} log - Logger.
 * @returns {Promise<Object>} analyzeBotProtection result { crawlable, type, confidence }.
 */
async function probeWithUndici(baseUrl, headers, log, fetchFn) {
  try {
    const response = await fetchFn(baseUrl, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'User-Agent': SPACECAT_USER_AGENT, ...headers },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const headersObj = Object.fromEntries(response.headers);
    let html = '';
    try {
      html = await response.text();
    } catch {
      html = '';
    }
    return analyzeBotProtection({ status: response.status, headers: headersObj, html });
  } catch (err) {
    log?.debug?.(`[bot-blocker] undici probe inconclusive for ${baseUrl}: ${err.message}`);
    return { crawlable: true, type: 'unknown', confidence: 0.3 };
  }
}

/**
 * Multi-client bot-blocker detection.
 *
 * Probes the site with BOTH the @adobe/fetch client (via the shared
 * {@link detectBotBlocker}) and Node's native fetch (undici), because Cloudflare Bot
 * Management blocks on the HTTP client fingerprint: a site can allow @adobe/fetch while
 * blocking undici — the client CWV/preflight/imports use — and headless Chrome (the
 * scraper). A single-client probe therefore yields false "crawlable: Yes" verdicts
 * (SITES-47217 / datacom.com).
 *
 * The return value keeps the shared {@link detectBotBlocker} shape (so existing
 * consumers — the onboarding waitlist reason, the controller response — keep working),
 * but `crawlable` is the AGGREGATE across clients (false if ANY representative client
 * is blocked) and a `perClient` breakdown is added. The top-level `type`/`confidence`
 * describe the blocking client so downstream messaging is accurate.
 *
 * NOTE: headless Chrome is intentionally NOT probed here — api-service has no browser.
 * The scraper-backed headless confirmation is tracked as a follow-up; until then a
 * "crawlable: true" verdict means "the lightweight HTTP clients were allowed", not
 * "headless scraping will succeed".
 *
 * @param {Object} opts
 * @param {string} opts.baseUrl - URL to check.
 * @param {Object} [opts.headers] - Optional extra headers forwarded to both probes.
 * @param {Object} [log=console] - Logger.
 * @returns {Promise<Object>} detectBotBlocker-shaped result + `perClient`.
 */
export async function detectBotBlockerMultiClient(
  { baseUrl, headers = {} } = {},
  { log = console, detectBotBlockerFn = detectBotBlocker, fetchFn = fetch } = {},
) {
  const [adobe, undici] = await Promise.all([
    detectBotBlockerFn({ baseUrl, headers }),
    probeWithUndici(baseUrl, headers, log, fetchFn),
  ]);

  const perClient = {
    'adobe-fetch': { crawlable: adobe.crawlable, type: adobe.type, confidence: adobe.confidence },
    undici: { crawlable: undici.crawlable, type: undici.type, confidence: undici.confidence },
  };

  const crawlable = adobe.crawlable && undici.crawlable;

  // Surface the blocking client's classification at the top level. Prefer the
  // @adobe/fetch block (it carries allowlist IPs/UA from the shared probe); fall back
  // to the undici block when @adobe/fetch was allowed but undici was not.
  let blocker = adobe;
  if (adobe.crawlable && !undici.crawlable) {
    blocker = undici;
  }

  return {
    ...adobe,
    crawlable,
    type: blocker.type,
    confidence: blocker.confidence,
    ...(blocker.reason ? { reason: blocker.reason } : {}),
    perClient,
  };
}
