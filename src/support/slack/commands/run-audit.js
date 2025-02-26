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
const LHS_MOBILE = 'lhs-mobile';

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
    description: 'Run audit for a previously added site. Runs lhs-mobile by default if no audit type parameter is provided.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {site} [auditType (optional)]`,
  });

  const { dataAccess, log } = context;
  const { Configuration, Site } = dataAccess;

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
      const [baseURLInput, auditTypeInput] = args;

      const baseURL = extractURLFromSlackInput(baseURLInput);

      if (!baseURL) {
        await say(':warning: Please provide a valid site url.');
        return;
      }

      const site = await Site.findByBaseURL(baseURL);

      if (!site) {
        await say(`:x: '${baseURL}' was not added previously. You can run '@spacecat add site ${baseURL}`);
        return;
      }

      const auditType = auditTypeInput || LHS_MOBILE;
      const configuration = await Configuration.findLatest();

      if (!configuration.isHandlerEnabledForSite(auditType, site)) {
        await say(`:x: Will not audit site '${baseURL}' because audits of type '${auditType}' are disabled for this site.`);
        return;
      }

      await triggerAuditForSite(site, auditType, slackContext, context);

      let message = `:white_check_mark: ${auditType} audit check is triggered for ${baseURL}\n`;
      if (auditType === LHS_MOBILE) {
        message += `:adobe-run: In a minute, you can run @spacecat get site ${baseURL}`;
      }

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
