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

/**
 * Creates a best-effort Slack client for review observability.
 *
 * Uses a dedicated chat:write-only bot token (NOT the broad elevatedSlackClient).
 * postMessage NEVER throws: a Slack failure must not block or fail a webhook.
 * It returns the posted message `ts` (string) on success, or null on any failure,
 * when unconfigured, or when no channel is given.
 *
 * @param {object} p
 * @param {string|undefined} p.token - bot token; absent => Slack disabled
 * @param {object} p.log - logger with .warn
 * @returns {{ postMessage: function, enabled: boolean }}
 */
export function createObservabilitySlackClient({ token, log }) {
  const client = token ? new WebClient(token) : null;

  async function postMessage({ channel, text, attachments }) {
    if (!client || !channel) {
      return null;
    }
    try {
      const result = await client.chat.postMessage({ channel, text, attachments });
      return result?.ts ?? null;
    } catch (e) {
      log.warn('Observability Slack post failed (non-fatal)', { error: e.message });
      return null;
    }
  }

  return { postMessage, enabled: Boolean(client) };
}
