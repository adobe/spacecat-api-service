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

import BaseCommand from './base.js';
import { postErrorMessage } from '../../../utils/slack/base.js';

const PHRASES = ['resolve user'];

/**
 * A factory function that creates an instance of the ResolveUserIdCommand.
 * This command resolves a userId by fetching the IMS admin profile.
 *
 * @param {object} context - The context object.
 * @returns {object} An instance of the ResolveUserIdCommand.
 */
function ResolveUserIdCommand(context) {
  const baseCommand = BaseCommand({
    id: 'resolve-user-id',
    name: 'Resolve User ID',
    description: 'Resolves a user ID by fetching the IMS admin profile',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {userId}`,
  });

  const { imsClient, log } = context;

  /**
   * Executes the ResolveUserIdCommand. Resolves a userId by fetching
   * the IMS admin profile and communicates the result back via Slack.
   *
   * @param {Array<string>} args - The arguments provided to the command.
   * @param {Object} slackContext - The Slack context object.
   * @param {Function} slackContext.say - The Slack say function.
   * @returns {Promise<void>} A promise that resolves when the operation is complete.
   */
  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;

    try {
      const [userId] = args;

      if (!userId) {
        await say(baseCommand.usage());
        return;
      }

      const profile = await imsClient.getImsAdminProfile(userId);

      const profileInfo = [
        `*User Profile for* \`${userId}\``,
        `*First Name:* ${profile.first_name || '-'}`,
        `*Last Name:* ${profile.last_name || '-'}`,
        `*Email:* ${profile.email || '-'}`,
      ].join('\n');

      await say(profileInfo);
    } catch (error) {
      log.error(`Failed to resolve user ID: ${error.message}`);
      await postErrorMessage(say, error);
    }
  };

  baseCommand.init(context);

  return {
    ...baseCommand,
    handleExecution,
  };
}

export default ResolveUserIdCommand;
