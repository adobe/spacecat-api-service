/*
 * Copyright 2023 Adobe. All rights reserved.
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
  getMessageFromEvent,
  getThreadTimestamp,
  wrapSayForThread,
} from '../../utils/slack/base.js';

/**
 * Creates a slack handler.
 * @param {object} commands - The commands.
 * @param {object} log - The logger.
 * @return {SlackHandler} The slack handler.
 * @constructor
 */
function SlackHandler(commands, log) {
  /**
   * Handles app_mention event.
   *
   * @param {object} event - The event.
   * @param {function} say - The say function.
   * @param {object} context - The slack bot context.
   * @param {object} client - The slack client.
   * @return {Promise<void>}
   */
  const onAppMention = async ({
    event, say, context, client,
  }) => {
    const threadTs = getThreadTimestamp(event);
    const threadedSay = wrapSayForThread(say, threadTs);
    const message = getMessageFromEvent(event);

    const slackContext = {
      say: threadedSay,
      channelId: event.channel,
      threadTs,
      client,
      user: event?.user,
      botToken: context.botToken || process.env.SLACK_BOT_TOKEN,
      files: event?.files || [],
    };

    log.info(`App_mention event received: ${JSON.stringify(event)} in thread ${threadTs} with context ${JSON.stringify(context)}`);

    const command = commands.find((cmd) => cmd.accepts(message));
    if (command) {
      await command.execute(message, slackContext, commands);
      return;
    }

    const helpCommand = commands.find((cmd) => cmd.phrases.includes('help'));
    if (helpCommand) {
      await helpCommand.execute(message, slackContext, commands);
      return;
    }

    await threadedSay('Sorry, I am misconfigured, no commands found.');
  };

  return {
    onAppMention,
  };
}

export default SlackHandler;
