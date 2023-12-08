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

/**
 * Creates a slack handler.
 * @param {object} log - The logger.
 * @return {SlackHandler} The slack handler.
 * @constructor
 */
function SlackHandler(log) {
  /**
   * Handles app_mention event.
   * @param {object} event - The event.
   * @param {function} say - The say function.
   * @param {object} context - The slack bot context.
   * @return {Promise<void>}
   */
  const onAppMention = async ({ event, say, context }) => {
    await say(`Hello, <@${event.user}>!`);
    log.info(`app_mention event received from user ${event.user} with context ${JSON.stringify(context)}`);
  };

  return {
    onAppMention,
  };
}

export default SlackHandler;
