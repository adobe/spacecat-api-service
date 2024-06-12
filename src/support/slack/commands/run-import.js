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

// todo: prototype - untested
/* c8 ignore start */

import { hasText } from '@adobe/spacecat-shared-utils';

import BaseCommand from './base.js';

import { postErrorMessage } from '../../../utils/slack/base.js';

const PHRASES = ['run import'];

/**
 * Factory function to create the RunImportCommand object.
 *
 * @param {Object} context - The context object.
 * @returns {RunImportCommand} The RunImportCommand object.
 * @constructor
 */
function RunImportCommand(context) {
  const baseCommand = BaseCommand({
    id: 'run-import',
    name: 'Run Import',
    description: 'Runs the specified import type for the site identified with its id.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {importType} {siteId}`,
  });

  const { dataAccess, log } = context;

  /**
   * Validates input and triggers the experimentation candidates for the given URL.
   *
   * @param {string[]} args - The arguments provided to the command ([site]).
   * @param {Object} slackContext - The Slack context object.
   * @param {Function} slackContext.say - The Slack say function.
   * @returns {Promise} A promise that resolves when the operation is complete.
   */
  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;

    try {
      const [importType, siteId] = args;

      if (!hasText(importType)) {
        await say(':warning: Please provide a valid import type.');
        return;
      }

      if (!hasText(siteId)) {
        await say(':warning: Please provide a valid import type.');
        return;
      }

      const config = await dataAccess.getConfiguration();
      const queueName = config.getQueues().imports;

      // await triggerImportRun(config, importType, slackContext, context);

      let message = `:adobe-run: Triggered import run of type ${importType} for site ${siteId}\n`;
      message += `Stand by for results. I will post them here when they are ready. (${queueName})`;

      await say(message);
    } catch (error) {
      log.error(error);
      await postErrorMessage(say, error);
    }
  };

  baseCommand.init(context);

  return {
    ...baseCommand,
    handleExecution,
  };
}

export default RunImportCommand;
/* c8 ignore end */
