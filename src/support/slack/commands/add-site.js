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
  extractURLFromSlackInput,
  postErrorMessage,
} from '../../../utils/slack/base.js';

import { findDeliveryType, triggerAuditForSite } from '../../utils.js';

import BaseCommand from './base.js';

const PHRASES = ['add site'];

/**
 * Factory function to create the AddSiteCommand object.
 *
 * @param {Object} context - The context object.
 * @returns {AddSiteCommand} - The AddSiteCommand object.
 * @constructor
 */
function AddSiteCommand(context) {
  const baseCommand = BaseCommand({
    id: 'add-site',
    name: 'Add Site',
    description: 'Adds a new site to track.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {site}`,
  });

  const { dataAccess, log } = context;

  /**
   * Validates input and adds the site to db
   * Runs an initial audit for the added base URL
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
        await say(':warning: Please provide a valid site base URL.');
        return;
      }

      const site = await dataAccess.getSiteByBaseURL(baseURL);

      if (site) {
        await say(`:x: '${baseURL}' was already added before. You can run _@spacecat get site ${baseURL}_`);
        return;
      }

      const deliveryType = await findDeliveryType(baseURL);

      const newSite = await dataAccess.addSite({ baseURL, deliveryType });

      if (!newSite) {
        await say(':x: Problem adding the site. Please contact the admins.');
        return;
      }

      const auditType = 'lhs-mobile';
      const auditConfig = newSite.getAuditConfig();

      let message = `:white_check_mark: *Successfully added new site '${baseURL}*'.\n`;

      // we still check for auditConfig.auditsDisabled() here as the default audit config may change
      if (!auditConfig.auditsDisabled() && !auditConfig.getAuditTypeConfig(auditType)?.disabled()) {
        await triggerAuditForSite(newSite, auditType, slackContext, context);
        message += 'First PSI check is triggered! :adobe-run:\'\n';
        message += `In a minute, you can run _@spacecat get site ${baseURL}_`;
      } else {
        message += 'Audits are disabled for this site.';
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

export default AddSiteCommand;
