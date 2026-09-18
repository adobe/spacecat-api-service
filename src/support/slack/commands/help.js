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

import BaseCommand from './base.js';

/**
 * The phrases that trigger the HelpCommand.
 * @type {string[]}
 */
const PHRASES = ['help', 'what can you do'];

/**
 * The bot's introduction message.
 * @type {string}
 */
const INTRO_MESSAGE = `
Greetings, I am SpaceCat, an emerging Slack bot. Within my limited abilities, I can aid you in unraveling the mysteries of orbital mechanics for Edge Delivery Sites. As a fledgling bot, my skills are raw and undeveloped. Embrace the darkness with me as we venture into the abyss of space. Ad astra pro terra!\n\n*Here are the commands I understand:*
`;

/**
 * Slack rejects a chat.postMessage whose `blocks` array exceeds 50 entries, or whose section
 * `text` exceeds 3000 characters, with an `invalid_blocks` API error - so the whole message is
 * dropped. Emitting one section block per command overflowed the 50-block limit once the command
 * list grew past ~49, silently breaking the help reply. Packing several commands per section block
 * keeps the message well within both limits.
 * @type {number}
 */
const SLACK_SECTION_TEXT_LIMIT = 3000;

/**
 * Creates a HelpCommand instance.
 *
 * @param {Object} context - The context object.
 * @returns {Object} The created HelpCommand instance.
 */
function HelpCommand(context) {
  const baseCommand = BaseCommand({
    id: 'help',
    name: 'Help',
    description: 'Displays a help message',
    phrases: PHRASES,
  });

  /**
   * Executes the help command.
   * Sends a help message to the user.
   *
   * @param {Array} args - The arguments passed to the command.
   * @param {Object} slackContext - The Slack context object.
   * @param {Function} slackContext.say - The Slack say function.
   * @param {Array} commands - The list of commands the bot can execute.
   * @returns {Promise<void>} A Promise that resolves when the command is executed.
   */
  const handleExecution = async (args, slackContext, commands) => {
    const { say } = slackContext;

    const blocks = [{
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: INTRO_MESSAGE,
      },
    }];

    // Pack command descriptions into as few section blocks as possible, keeping each section's
    // text under Slack's 3000-char limit, so the message stays within the 50-block cap regardless
    // of how many commands are registered (see SLACK_SECTION_TEXT_LIMIT).
    let section = '';
    const flushSection = () => {
      if (section.length > 0) {
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: section } });
        section = '';
      }
    };

    for (const command of commands) {
      const entry = `*${command.name}*\n${command.usage()}\n${command.description}\n\n`;
      if (section.length > 0 && section.length + entry.length > SLACK_SECTION_TEXT_LIMIT) {
        flushSection();
      }
      section += entry;
    }
    flushSection();

    await say({ blocks });
  };

  baseCommand.init(context);

  return {
    ...baseCommand,
    handleExecution,
  };
}

export default HelpCommand;
