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

// Timeout per agent fetch — aggressive enough to catch stalls without blocking the UI.
export const BOT_PROBE_TIMEOUT_MS = 10000;

// The two user-facing LLM crawlers most likely to be blocked by UA-based WAF rules.
export const LLM_BOT_AGENTS = [
  { name: 'ChatGPT-User', userAgent: 'ChatGPT-User/1.0' },
  { name: 'Perplexity-User', userAgent: 'Perplexity-User/1.0' },
];

// Hard-block HTTP status codes — same set as the edge-optimize WAF probe.
export const HARD_BLOCK_STATUS_CODES = new Set([401, 403, 406, 429, 503]);

// Vendor-specific identifiers that only appear in WAF-generated challenge pages.
export const BOT_CHALLENGE_KEYWORDS = [
  'cf-chl-widget',
  'completing the challenge',
  '_incapsula_resource',
  'errors.edgesuite.net',
  'errors.edgekey.net',
];

/**
 * Classifies a direct (non-proxied) fetch response for a single LLM bot agent.
 *
 * Detection logic:
 *   - Hard block: status in HARD_BLOCK_STATUS_CODES → blocked: true
 *   - CF challenge: cf-mitigated: challenge header    → blocked: true
 *   - Soft block: 2xx HTML with WAF challenge keywords → blocked: true
 *   - Clean pass: 2xx with real content               → blocked: false
 *   - Other (e.g. redirect): treated as not blocked   → blocked: false
 *
 * @param {Response} response - Fetch response from the direct call.
 * @param {string} agentName - Agent display name for logging (e.g. 'ChatGPT-User').
 * @param {object} log - Logger with an `info` method.
 * @returns {Promise<{blocked: boolean, statusCode: number}>}
 */
export async function classifyBotAgentResponse(response, agentName, log) {
  const { status } = response;

  if (HARD_BLOCK_STATUS_CODES.has(status)) {
    log.info(`[llm-bot-probe] Hard block for ${agentName}: HTTP ${status}`);
    return { blocked: true, statusCode: status };
  }

  if (response.headers.get('cf-mitigated') === 'challenge') {
    log.info(`[llm-bot-probe] CF challenge for ${agentName} (cf-mitigated: challenge)`);
    return { blocked: true, statusCode: status };
  }

  if (status >= 200 && status < 300) {
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
      const text = await response.text();
      const isSoftBlock = BOT_CHALLENGE_KEYWORDS.some((kw) => text.toLowerCase().includes(kw));
      if (isSoftBlock) {
        log.info(`[llm-bot-probe] Soft block (challenge page) for ${agentName}: HTTP ${status}`);
        return { blocked: true, statusCode: status };
      }
    }
    log.info(`[llm-bot-probe] Clean pass for ${agentName}: HTTP ${status}`);
    return { blocked: false, statusCode: status };
  }

  log.info(`[llm-bot-probe] Unexpected status for ${agentName}: HTTP ${status}`);
  return { blocked: false, statusCode: status };
}
