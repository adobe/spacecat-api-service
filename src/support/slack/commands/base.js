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

import { isObject } from '@adobe/spacecat-shared-utils';

/**
 * Base command factory function.
 * Creates a base command object with specified options.
 *
 * @param {Object} options - The options for the command.
 * @param {string} options.id - The unique identifier of the command.
 * @param {string} options.description - The description of the command.
 * @param {string} options.name - The display name of the command.
 * @param {string} [options.usageText] - The usage instructions for the command.
 * @param {string[]} [options.phrases=[]] - The phrases that trigger the command.
 *
 * @returns {Object} The base command object.
 */
function BaseCommand({
  id,
  description,
  name,
  usageText,
  phrases = [],
}) {
  const extractArguments = (message) => {
    const triggeringPhrase = phrases.find((phrase) => message.startsWith(phrase));

    if (triggeringPhrase) {
      const argsStartIndex = triggeringPhrase.length;
      const argsString = message.slice(argsStartIndex).trim();

      return argsString.split(' ');
    }

    return [];
  };

  /**
   * Determines if a message should be accepted by this command.
   *
   * @param {string} message - The incoming message.
   * @returns {boolean} true if the message starts with one of the phrases, false otherwise.
   */
  const accepts = (message) => phrases.filter((phrase) => message.startsWith(phrase))
    .some((phrase) => (message.length > phrase.length ? message.slice(phrase.length, phrase.length + 1) === ' ' : true));

  /**
   * Stub for the command's execution function.
   * Throws an error by default. This method should be overridden by a specific command.
   *
   * @param {string} message - The incoming message.
   * @param {Object} slackContext - The Slack context object.
   * @param {Function} slackContext.say - The Slack say function.
   * @param {string} slackContext.channelId - The Slack channel ID.
   * @param {string} slackContext.threadTs - The Slack thread timestamp.
   * @param {Array[Object]} commands - List of commands existing.
   * @throws {Error} Always thrown, since this method must be overridden.
   */
  async function execute(message, slackContext, commands) {
    const args = extractArguments(message);

    return this.handleExecution(args, slackContext, commands);
  }

  /**
   * Stub for the command's execution handler function.
   * @param {Array<string>} args - The arguments provided to the command.
   * @param {Object} slackContext - The Slack context object.
   * @param {Function} slackContext.say - The Slack say function.
   * @param {string} slackContext.channelId - The Slack channel ID.
   * @param {string} slackContext.threadTs - The Slack thread timestamp.
   * @param {Array[Object]} commands - List of commands existing.
   * @return {Promise<void>} A promise that resolves when the operation is complete.
   */
  // eslint-disable-next-line no-unused-vars
  const handleExecution = async (args, slackContext, commands) => {
    throw new Error('Execute method must be overridden by a specific command.');
  };

  /**
   * Returns the usage instructions for the command.
   * If a usage property was provided, it returns that. Otherwise,
   * it returns a string with all the command phrases.
   *
   * @returns {string} The usage instructions.
   */
  const usage = () => {
    if (usageText) {
      return `Usage: _${usageText}_`;
    }
    return `Usage: _${phrases.join(', ')}_`;
  };

  /**
   * No-op initialization function.
   * This is a placeholder for command-specific initialization code.
   * It should be overridden by a specific command if necessary.
   *
   * @param {Object} context - The context object.
   */
  const init = (context) => {
    if (!isObject(context)) {
      throw new Error('Context object is required');
    }
  };

  return {
    id,
    description,
    name,
    phrases,
    accepts,
    execute,
    handleExecution,
    usage,
    init,
  };
}

export default BaseCommand;
