/*
 * Copyright 2024 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { Blocks, Message } from 'slack-block-builder';
import { BUTTON_LABELS } from '../../../controllers/hooks.js';

export function extractURLFromSlackMessage(inputString) {
  // Regular expression to match URLs
  const start = inputString.indexOf('https');
  const end = inputString.indexOf('|', inputString.indexOf('<'));

  return inputString.substring(start, end);
}

export function composeReply(opts) {
  const {
    blocks,
    username,
    isFnF,
    approved,
  } = opts;

  const reaction = approved
    ? `Added by @${username} \`${isFnF ? BUTTON_LABELS.APPROVE_FRIENDS_FAMILY : BUTTON_LABELS.APPROVE_CUSTOMER}\` :checked:`
    : `Ignored by @${username} :cross-x:`;

  const message = Message()
    .blocks(
      Blocks.Section()
        .blockId(blocks[0]?.block_id)
        .text(blocks[0]?.text?.text),
      Blocks.Section().text(reaction),
    )
    .buildToObject();

  return {
    ...message,
    text: blocks[0]?.text?.text,
    replace_original: true,
  };
}

/**
 * Formats bot protection details for Slack notifications
 * @param {Object} options - Options
 * @param {string} options.siteUrl - Site URL
 * @param {Object} options.botProtection - Bot protection details
 * @returns {string} Formatted Slack message
 */
export function formatBotProtectionSlackMessage({
  siteUrl,
  botProtection,
}) {
  const isBlocked = botProtection.crawlable === false;
  const emoji = isBlocked ? ':warning:' : ':information_source:';
  const title = isBlocked ? 'Bot Protection Detected' : 'Bot Protection Infrastructure Detected';

  let message = `${emoji} *${title}*\n\n`
    + `*Site:* ${siteUrl}\n`
    + `*Protection Type:* ${botProtection.type}\n`
    + `*Confidence:* ${(botProtection.confidence * 100).toFixed(0)}%\n`;

  if (isBlocked) {
    message += '\n'
      + '*Status:*\n'
      + '• Initial detection suggests bot protection is active\n'
      + '• Onboarding will proceed with browser-based scraping\n'
      + '• Additional details may be provided if bot protection is encountered during scraping\n';
  } else {
    // Site is accessible - just informational
    message += '\n'
      + '*Status:*\n'
      + '• Bot protection infrastructure is present\n'
      + '• SpaceCat can currently access the site\n'
      + '• No action needed at this time\n';
  }

  return message;
}
