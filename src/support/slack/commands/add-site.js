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

import { extractBaseURLFromInput, postErrorMessage } from '../../../utils/slack/base.js';

import BaseCommand from './base.js';
import { sendAuditMessage } from '../../utils.js';

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

  const { dataAccess } = context;

  /**
   * Validates input and adds the site to db
   * Runs an initial audit for the added domain
   *
   * @param {string[]} args - The arguments provided to the command ([site]).
   * @param {Function} say - The function provided by the bot to send messages.
   * @returns {Promise} A promise that resolves when the operation is complete.
   */
  const handleExecution = async (args, say) => {
    try {
      const [siteDomainInput] = args;

      const baseURL = extractBaseURLFromInput(siteDomainInput, false);

      if (!baseURL) {
        await say(':warning: Please provide a valid site domain.');
        return;
      }

      const site = await dataAccess.getSiteByBaseURL(baseURL);

      if (site) {
        await say(`:x: '${baseURL}' was already added before. You can run _@spacecat get site ${baseURL}_`);
        return;
      }

      const newSite = await dataAccess.addSite({ baseURL });

      if (!newSite) {
        await say(':x: Problem adding the site. Please contact the admins.');
        return;
      }

      await sendAuditMessage(
        context.sqs,
        context.env.AUDIT_JOBS_QUEUE_URL,
        'lhs-mobile',
        {},
        newSite.getId(),
      );

      let message = `:white_check_mark: Successfully added new site '${baseURL}'.\n`;
      message += 'First PSI check is triggered! :adobe-run:\'\n';
      message += `In a minute, you can run _@spacecat get site ${baseURL}_`;

      await say(message);
    } catch (error) {
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
