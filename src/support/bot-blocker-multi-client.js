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
// Bound the body read the same way the shared detectBotBlocker does: skip the body
// when Content-Length is large, and race the read against a short timeout so a slow
// (or unbounded chunked) response can never hang or balloon memory.
const BODY_READ_MAX_BYTES = 65536; // 64 KB — challenge markers appear in the first KB
const BODY_READ_TIMEOUT_MS = 3000;

// Browser-realistic headers for the diagnostic `undici-browser` probe. Some bot rules
// key on request *headers* — the UA string, a missing Accept-Language, absent Client
// Hints — rather than the TLS/HTTP fingerprint (a missing Accept-Language alone has been
// observed to trigger a 403). This probe reuses the undici transport but presents a real
// Chrome header set, so contrasting it with the plain `undici` probe reveals whether a
// block is header/UA-based (cheaply remediable) vs client-fingerprint-based. It does NOT
// emulate Chrome's TLS/JA3 and runs no JS, so it cannot predict headless-scraper success
// on TLS-fingerprint or JS-challenge sites — it is diagnostic only (see the aggregate
// note in detectBotBlockerMultiClient).
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'sec-ch-ua': '"Chromium";v="125", "Not.A/Brand";v="24", "Google Chrome";v="125"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
};

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
 * @param {Function} fetchFn - fetch implementation (injectable for tests).
 * @param {string} [label='undici'] - Probe label used in the inconclusive-probe log line.
 * @returns {Promise<Object>} analyzeBotProtection result { crawlable, type, confidence }.
 */
async function probeWithUndici(baseUrl, headers, log, fetchFn, label = 'undici') {
  try {
    const response = await fetchFn(baseUrl, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'User-Agent': SPACECAT_USER_AGENT, ...headers },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const headersObj = Object.fromEntries(response.headers);
    let html = '';
    const contentLength = parseInt(headersObj['content-length'] || '0', 10);
    // Only read the body when a bounded Content-Length is advertised. A chunked or
    // absent Content-Length (parsed as 0) is skipped, so an unbounded chunked response
    // can never balloon memory — status + headers still drive the verdict in that case.
    if (contentLength > 0 && contentLength <= BODY_READ_MAX_BYTES) {
      try {
        let timer;
        html = await Promise.race([
          response.text().finally(() => clearTimeout(timer)),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('body-read-timeout')), BODY_READ_TIMEOUT_MS);
          }),
        ]);
      } catch {
        html = '';
      }
    }
    return analyzeBotProtection({ status: response.status, headers: headersObj, html });
  } catch (err) {
    log?.debug?.(`[bot-blocker] ${label} probe inconclusive for ${baseUrl}: ${err.message}`);
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
 * A third `undici-browser` probe (undici transport + browser-realistic headers) is also
 * run. It is DIAGNOSTIC ONLY and deliberately excluded from the `crawlable` aggregate:
 * the aggregate must reflect the fate of the *real audit clients* (@adobe/fetch, undici),
 * whereas the browser probe answers a different question — "is this block header/UA-based
 * (cheaply remediable) or client-fingerprint-based?". Contrast `perClient.undici` (bot UA)
 * with `perClient['undici-browser']` (Chrome headers): if the former is blocked and the
 * latter passes, the block is header/UA-driven; if both are blocked, it's deeper
 * (fingerprint/JS) and needs the IP-allowlist / headless path.
 *
 * The return value keeps the shared {@link detectBotBlocker} shape (so existing
 * consumers — the onboarding waitlist reason, the controller response — keep working),
 * but `crawlable` is the AGGREGATE across the real clients (false if @adobe/fetch OR
 * undici is blocked) and a `perClient` breakdown is added. The top-level `type`/`confidence`
 * describe the blocking client so downstream messaging is accurate.
 *
 * NOTE: headless Chrome is intentionally NOT probed here — api-service has no browser, and
 * the `undici-browser` probe only mimics headers, not Chrome's TLS/JA3 or JS execution.
 * The scraper-backed headless verdict is tracked as a follow-up (surface the scraper's own
 * `o_bot_protection` fact); until then a "crawlable: true" verdict means "the lightweight
 * HTTP clients were allowed", not "headless scraping will succeed".
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
  const [adobe, undici, undiciBrowser] = await Promise.all([
    // Match probeWithUndici's behaviour: a probe failure (timeout/DNS/network) is
    // inconclusive, not a block — so neither probe can reject the whole call.
    Promise.resolve()
      .then(() => detectBotBlockerFn({ baseUrl, headers }))
      .catch((err) => {
        log?.debug?.(`[bot-blocker] @adobe/fetch probe inconclusive for ${baseUrl}: ${err.message}`);
        return { crawlable: true, type: 'unknown', confidence: 0.3 };
      }),
    probeWithUndici(baseUrl, headers, log, fetchFn),
    // Diagnostic probe: same undici transport, browser-realistic headers. Site headers
    // are applied first so the browser identity (UA/Accept-Language/Client Hints) wins.
    probeWithUndici(baseUrl, { ...headers, ...BROWSER_HEADERS }, log, fetchFn, 'undici-browser'),
  ]);

  const perClient = {
    'adobe-fetch': { crawlable: adobe.crawlable, type: adobe.type, confidence: adobe.confidence },
    undici: { crawlable: undici.crawlable, type: undici.type, confidence: undici.confidence },
    // Diagnostic only — NOT part of the `crawlable` aggregate below.
    'undici-browser': {
      crawlable: undiciBrowser.crawlable,
      type: undiciBrowser.type,
      confidence: undiciBrowser.confidence,
    },
  };

  // Aggregate over the REAL audit clients only; the browser probe is diagnostic.
  const crawlable = adobe.crawlable && undici.crawlable;

  // Surface the blocking client's classification at the top level. Prefer the
  // @adobe/fetch block (it carries allowlist IPs/UA from the shared probe); fall back
  // to the undici block when @adobe/fetch was allowed but undici was not.
  let blocker = adobe;
  if (adobe.crawlable && !undici.crawlable) {
    blocker = undici;
  }

  // Forward only the fields consumers rely on — no blanket spread, so a future field
  // added to a probe result can't leak onto the response with wrong-client provenance.
  // `reason` always reflects the blocking client; allowlist hints come from the
  // @adobe/fetch probe (the shared detectBotBlocker is what surfaces them).
  return {
    crawlable,
    type: blocker.type,
    confidence: blocker.confidence,
    reason: blocker.reason || undefined,
    userAgent: adobe.userAgent,
    // Normalize to the inclusive name, falling back to the legacy field for older
    // shared-util shapes (member access of the legacy name is fine; only declaring it
    // as a key is disallowed).
    ipsToAllowlist: adobe.ipsToAllowlist || adobe.ipsToWhitelist,
    perClient,
  };
}
