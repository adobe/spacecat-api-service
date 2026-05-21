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

import { WebClient } from '@slack/web-api';

// Bound the Slack request so a slow/hung Slack API call can never delay webhook
// handling: the controller awaits postMessage before enqueue, and GitHub times
// out webhook delivery at ~10s (and redelivers). A sub-2s budget with no retries
// keeps the worst case well under that window even on a slow Slack edge, so a
// Slack incident cannot cause duplicate enqueues via GitHub redelivery.
const SLACK_REQUEST_TIMEOUT_MS = 2000;

/**
 * Creates a best-effort Slack client for review observability.
 *
 * Uses a dedicated chat:write-only bot token (NOT the broad elevatedSlackClient)
 * so a compromised webhook environment cannot post as the broad bot in product
 * channels; the blast radius on token compromise is limited to this one channel.
 *
 * postMessage NEVER throws: a Slack failure must not block or fail a webhook. It
 * returns the posted message `ts` (string) on success, or null on any failure or
 * when disabled (no token or no channel, or the client could not be built).
 *
 * @param {object} p
 * @param {string|undefined} p.token - bot token; absent => disabled
 * @param {string|undefined} p.channel - target channel id; absent => disabled
 * @param {object} p.log - logger with .warn
 * @returns {{ postMessage: function, enabled: boolean }}
 */
export function createObservabilitySlackClient({ token, channel, log }) {
  let client = null;
  if (token) {
    try {
      client = new WebClient(token, {
        timeout: SLACK_REQUEST_TIMEOUT_MS,
        retryConfig: { retries: 0 },
      });
    } catch (e) {
      // A constructor failure (e.g. a future token-format validation) must not
      // crash webhook handling for every delivery — degrade to disabled.
      log.warn('Observability Slack client init failed (non-fatal)', { error: e?.message ?? String(e) });
      client = null;
    }
  }

  const enabled = Boolean(client && channel);

  async function postMessage({ text, attachments }) {
    if (!enabled) {
      return null;
    }
    try {
      const result = await client.chat.postMessage({ channel, text, attachments });
      return result?.ts ?? null;
    } catch (e) {
      log.warn('Observability Slack post failed (non-fatal)', { error: e?.message ?? String(e) });
      return null;
    }
  }

  return { postMessage, enabled };
}
