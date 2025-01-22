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

import {
  extractURLFromSlackInput,
  postErrorMessage,
} from '../../../utils/slack/base.js';

import { findDeliveryType, triggerAuditForSite } from '../../utils.js';

import BaseCommand from './base.js';

const PHRASES = ['onboard site'];

const AUDITS = [
  'backlinks',
  'cwv',
  'experimentation-opportunities',
  'internal-links',
  'metatags',
  'sitemap',
  'structured-data',
];

/**
 * Factory function to create the OnboardCommand object.
 *
 * @param {Object} context - The context object.
 * @returns {OnboardCommand} - The OnboardCommand object.
 * @constructor
 */
function OnboardCommand(context) {
  const baseCommand = BaseCommand({
    id: 'onboard-site',
    name: 'Obboard Site',
    description: 'Onboards a new site to Success Studio.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {site}`,
  });

  const { dataAccess, log } = context;
  const { Configuration, Site } = dataAccess;

  /**
   * Validates input and onboards the site to ESS
   * Runs initial audits for the onboarded base URL
   *
   * @param {string[]} args - The arguments provided to the command ([site]).
   * @param {Object} slackContext - The Slack context object.
   * @param {Function} slackContext.say - The Slack say function.
   * @returns {Promise} A promise that resolves when the operation is complete.
   */
  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;
    const { DEFAULT_ORGANIZATION_ID: defaultOrgId } = context.env;

    try {
      const [baseURLInput] = args;

      const baseURL = extractURLFromSlackInput(baseURLInput);

      if (!baseURL) {
        await say(':warning: Please provide a valid site base URL.');
        return;
      }

      // see if the site was added previously
      let site = await Site.findByBaseURL(baseURL);

      // if not, add the site to the star catalogue
      if (!site) {
        const deliveryType = await findDeliveryType(baseURL);
        const isLive = true;

        site = await Site.create({
          baseURL, deliveryType, isLive, organizationId: defaultOrgId,
        });
      }

      const configuration = await Configuration.findLatest();

      AUDITS.forEach((auditType) => {
        configuration.enableHandlerForSite(auditType, site);
      });

      await configuration.save();

      for (const auditType of AUDITS) {
        // eslint-disable-next-line no-await-in-loop
        await triggerAuditForSite(site, auditType, slackContext, context);
      }

      let message = `Success Studio onboard completed successfully for ${baseURL} :rocket:\n`;
      message += `Enabled and triggered following audits: ${AUDITS.join(', ')}`;

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

export default OnboardCommand;
/* c8 ignore end */
