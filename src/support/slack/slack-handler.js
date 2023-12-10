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

import { BOT_MENTION_REGEX } from '../../utils/slack/base.js';

/**
 * Creates a slack handler.
 * @param {object} commands - The commands.
 * @param {object} log - The logger.
 * @return {SlackHandler} The slack handler.
 * @constructor
 */
function SlackHandler(commands, log) {
  /**
   * Determines if the event is part of a thread.
   * @param {object} event - The Slack event.
   * @return {string} The thread timestamp (thread_ts).
   */
  const getThreadTimestamp = (event) => event.thread_ts || event.ts;

  const getMessageFromEvent = (event) => event.text?.replace(BOT_MENTION_REGEX, '').trim();

  /**
   * Wraps the Slack say function to respond in a thread.
   *
   * @param {Function} say - The original Slack say function.
   * @param {string} threadTs - The timestamp of the thread to respond in.
   * @returns {Function} A wrapped say function that sends messages in a thread.
   */
  const wrapSayForThread = (say, threadTs) => async (message) => {
    const messageOptions = typeof message === 'string' ? { text: message } : message;
    await say({
      ...messageOptions,
      thread_ts: threadTs,
    });
  };

  /**
   * Handles app_mention event.
   *
   * @param {object} event - The event.
   * @param {function} say - The say function.
   * @param {object} context - The slack bot context.
   * @return {Promise<void>}
   */
  const onAppMention = async ({ event, say, context }) => {
    const threadTs = getThreadTimestamp(event);
    const threadedSay = wrapSayForThread(say, threadTs);
    const message = getMessageFromEvent(event);
    const slackContext = {
      say: threadedSay,
      channelId: event.channel,
      threadTs,
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
