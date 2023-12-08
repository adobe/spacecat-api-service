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
 * @param {object} log - The logger.
 * @return {SlackHandler} The slack handler.
 * @constructor
 */
function SlackHandler(log) {
  /**
   * Determines if the event is part of a thread.
   * @param {object} event - The Slack event.
   * @return {string} The thread timestamp (thread_ts).
   */
  const getThreadTimestamp = (event) => event.thread_ts || event.ts;

  const getMessageFromEvent = (event) => event.text.replace(BOT_MENTION_REGEX, '').trim();

  /**
   * Responds to a message in the appropriate thread.
   * @param {function} say - The say function from Bolt.
   * @param {string} threadTs - The thread timestamp.
   * @param {string} message - The message to send.
   */
  const respondInThread = async (say, threadTs, message) => {
    await say({
      thread_ts: threadTs,
      text: message,
    });
  };

  /**
   * Handles app_mention event.
   * @param {object} event - The event.
   * @param {function} say - The say function.
   * @param {object} context - The slack bot context.
   * @return {Promise<void>}
   */
  const onAppMention = async ({ event, say, context }) => {
    const threadTs = getThreadTimestamp(event);
    const message = getMessageFromEvent(event);

    log.info(JSON.stringify(message));

    const responseMessage = `Hello, <@${event.user}>!`;

    await respondInThread(say, threadTs, responseMessage);

    log.info(`App_mention event received: ${JSON.stringify(event)} in thread ${threadTs} with context ${JSON.stringify(context)}`);
  };

  return {
    onAppMention,
  };
}

export default SlackHandler;
