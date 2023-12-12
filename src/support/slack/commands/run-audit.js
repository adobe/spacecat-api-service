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

import { extractURLFromSlackInput, postErrorMessage } from '../../../utils/slack/base.js';

import { triggerAuditForSite } from '../../utils.js';

const PHRASES = ['run audit'];

/**
 * Factory function to create the RunAuditCommand object.
 *
 * @param {Object} context - The context object.
 * @returns {RunAuditCommand} The RunAuditCommand object.
 * @constructor
 */
function RunAuditCommand(context) {
  const baseCommand = BaseCommand({
    id: 'run-audit',
    name: 'Run Audit',
    description: 'Run audit for a previously added site',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {site}`,
  });

  const { dataAccess, log } = context;

  /**
   * Validates input, fetches the site
   * and triggers a new audit for the given site
   *
   * @param {string[]} args - The arguments provided to the command ([site]).
   * @param {Object} slackContext - The Slack context object.
   * @param {Function} slackContext.say - The Slack say function.
   * @returns {Promise} A promise that resolves when the operation is complete.
   */
  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;

    try {
      const [baseURLInput] = args;

      const baseURL = extractURLFromSlackInput(baseURLInput);

      if (!baseURL) {
        await say(':warning: Please provide a valid site url.');
        return;
      }

      const site = await dataAccess.getSiteByBaseURL(baseURL);

      if (!site) {
        await say(`:x: '${baseURL}' was not added previously. You can run '@spacecat add site ${baseURL}`);
        return;
      }

      await triggerAuditForSite(site, 'lhs-mobile', slackContext, context);

      let message = `:white_check_mark: Audit check is triggered for ${baseURL}\n`;
      message += `:adobe-run: In a minute, you can run @spacecat get site ${baseURL}`;

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

export default RunAuditCommand;
