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
import { formatAllowlistMessage, SPACECAT_BOT_USER_AGENT } from '@adobe/spacecat-shared-utils';
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
 * @param {string} [options.botIps] - Comma-separated bot IPs from environment (SPACECAT_BOT_IPS)
 * @returns {string} Formatted Slack message
 */
export function formatBotProtectionSlackMessage({
  siteUrl,
  botProtection,
  botIps,
}) {
  let allowlistInfo;
  try {
    allowlistInfo = formatAllowlistMessage(botIps);
  } catch (error) {
    // If IPs not configured, use generic message
    allowlistInfo = {
      ips: ['IP addresses not configured'],
      userAgent: SPACECAT_BOT_USER_AGENT,
    };
  }

  const ipList = allowlistInfo.ips.map((ip) => `• \`${ip}\``).join('\n');
  const isAllowed = botProtection.type && botProtection.type.includes('-allowed');

  let message = `:${isAllowed ? 'information_source' : 'warning'}: *Bot Protection${isAllowed ? ' Infrastructure' : ''} Detected*\n\n`
    + `*Site:* ${siteUrl}\n`
    + `*Protection Type:* ${botProtection.type}\n`
    + `*Confidence:* ${(botProtection.confidence * 100).toFixed(0)}%\n`;

  if (botProtection.reason) {
    message += `*Reason:* ${botProtection.reason}\n`;
  }

  if (isAllowed) {
    // Site is currently accessible - provide informational message
    message += '\n'
      + '*Current Status:*\n'
      + '• SpaceCat can currently access the site\n'
      + '• Bot protection infrastructure is present but allowing requests\n'
      + '• This suggests AWS Lambda IPs may be allowlisted\n'
      + '\n'
      + '*Important Notes:*\n'
      + '• If audits fail or return incorrect results, verify allowlist configuration\n'
      + '• Ensure allowlist is permanent and covers all required IPs\n'
      + '• Some protection types may still affect specific audit types\n'
      + '\n'
      + '*If you need to update allowlist:*\n'
      + '\n'
      + '*User-Agent to allowlist:*\n'
      + `\`${allowlistInfo.userAgent}\`\n`
      + '\n'
      + '*IPs to allowlist:*\n'
      + `${ipList}\n`;
  } else {
    // Site is blocked - provide allowlist information
    message += '\n'
      + '*Detection Details:*\n'
      + '• Simple HTTP requests are being blocked\n'
      + '• Our browser-based scraper may be able to bypass basic protection\n'
      + '• Advanced protection may still block automated access\n'
      + '\n'
      + '*Recommended Action:*\n'
      + `Allowlist SpaceCat in your ${botProtection.type} configuration for best results:\n`
      + '\n'
      + '*User-Agent to allowlist:*\n'
      + `\`${allowlistInfo.userAgent}\`\n`
      + '\n'
      + '*IPs to allowlist:*\n'
      + `${ipList}\n`
      + '\n'
      + '_If audits fail, allowlisting will be required for the site to be monitored._';
  }

  return message;
}
