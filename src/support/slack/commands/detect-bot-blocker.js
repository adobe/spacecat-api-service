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

import { detectBotBlocker, isValidUrl } from '@adobe/spacecat-shared-utils';

import BaseCommand from './base.js';
import { extractURLFromSlackInput, postErrorMessage } from '../../../utils/slack/base.js';

const COMMAND_ID = 'detect-bot-blocker';
const PHRASES = ['detect bot-blocker', 'detect bot blocker', 'check bot blocker'];

function DetectBotBlockerCommand(context) {
  const baseCommand = BaseCommand({
    id: COMMAND_ID,
    name: 'Detect Bot Blocker',
    description: 'Detects bot blocker technology on a website (Cloudflare, Imperva, HTTP/2 blocks).',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {baseURL}`,
  });

  const { log } = context;

  const formatResult = (result) => {
    const { crawlable, type, confidence } = result;
    const confidencePercent = (confidence * 100).toFixed(0);
    const crawlableEmoji = crawlable ? ':white_check_mark:' : ':no_entry:';

    let confidenceEmoji = ':question:';
    if (confidence >= 0.95) {
      confidenceEmoji = ':muscle:';
    } else if (confidence >= 0.5) {
      confidenceEmoji = ':thinking_face:';
    }

    let typeLabel = type;
    if (type === 'cloudflare') typeLabel = 'Cloudflare';
    else if (type === 'imperva') typeLabel = 'Imperva/Incapsula';
    else if (type === 'http2-block') typeLabel = 'HTTP/2 Stream Error';
    else if (type === 'none') typeLabel = 'No Blocker Detected';
    else if (type === 'unknown') typeLabel = 'Unknown';

    return `${crawlableEmoji} *Crawlable:* ${crawlable ? 'Yes' : 'No'}\n`
      + `:shield: *Blocker Type:* ${typeLabel}\n`
      + `${confidenceEmoji} *Confidence:* ${confidencePercent}%`;
  };

  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;

    if (!args.length) {
      await say(baseCommand.usage());
      return;
    }

    const baseURL = extractURLFromSlackInput(args[0]);
    if (!isValidUrl(baseURL)) {
      await say(':warning: Please provide a valid URL.');
      await say(baseCommand.usage());
      return;
    }

    await say(`:mag: Checking bot blocker for \`${baseURL}\`...`);

    try {
      const result = await detectBotBlocker({ baseUrl: baseURL });
      const formattedResult = formatResult(result);

      await say(`:robot_face: *Bot Blocker Detection Results for* \`${baseURL}\`\n\n${formattedResult}`);
    } catch (error) {
      log.error(`detect-bot-blocker command: failed for URL ${baseURL}`, error);
      await postErrorMessage(say, error);
    }
  };

  return {
    ...baseCommand,
    handleExecution,
  };
}

export default DetectBotBlockerCommand;
