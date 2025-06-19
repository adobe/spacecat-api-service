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

import { isValidUrl } from '@adobe/spacecat-shared-utils';
import BaseCommand from './base.js';
import {
  extractURLFromSlackInput,
  postErrorMessage,
  postSiteNotFoundMessage,
  sendMessageBlocks,
} from '../../../utils/slack/base.js';

const PHRASES = ['get site-audits'];

/**
 * Formats the audit status list showing enabled and disabled audit types.
 *
 * @param {Array<Object>} enabledAudits - Array of enabled audit result objects with auditType.
 * @param {Array<Object>} disabledAudits - Array of disabled audit result objects with auditType.
 * @returns {string} The formatted audit status list.
 */
export function formatAuditStatus(enabledAudits, disabledAudits) {
  let output = '';

  if (enabledAudits.length > 0) {
    output += '*Enabled Audits:* ✅\n';
    enabledAudits.forEach(({ auditType }) => {
      output += `• ${auditType}\n`;
    });
  }

  if (disabledAudits.length > 0) {
    if (output) output += '\n';
    output += '*Disabled Audits:* ❌\n';
    disabledAudits.forEach(({ auditType }) => {
      output += `• ${auditType}\n`;
    });
  }

  return output;
}

/**
 * A factory function that creates an instance of the GetSiteAuditsCommand.
 *
 * @param {object} context - The context object.
 * @returns {GetSiteAuditsCommand} An instance of the GetSiteAuditsCommand.
 * @constructor
 */
function GetSiteAuditsCommand(context) {
  const baseCommand = BaseCommand({
    id: 'get-site-audits',
    name: 'Get all audits for a site',
    description: 'Retrieves all audit types (enabled and disabled) for a site by a given base URL',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {baseURL};`,
  });

  const { dataAccess, log } = context;
  const { Configuration, Site } = dataAccess;

  /**
   * Executes the GetSiteAuditsCommand. Retrieves the audit status for a site by
   * a given base URL and communicates the status back via the provided say function.
   * If an error occurs during execution, an error message is sent back.
   *
   * @param {Array<string>} args - The arguments provided to the command.
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
        await say(baseCommand.usage());
        return;
      }

      if (!isValidUrl(baseURL)) {
        await say(':warning: Please provide a valid URL.');
        return;
      }

      const site = await Site.findByBaseURL(baseURL);

      if (!site) {
        await postSiteNotFoundMessage(say, baseURL);
        return;
      }

      const configuration = await Configuration.findLatest();

      // Use the existing configuration methods to get enabled and disabled audits
      const enabledAuditTypes = configuration.getEnabledAuditsForSite(site);
      const disabledAuditTypes = configuration.getDisabledAuditsForSite(site);

      const enabledCount = enabledAuditTypes.length;
      const disabledCount = disabledAuditTypes.length;
      const totalCount = enabledCount + disabledCount;

      if (totalCount === 0) {
        await say(':warning: No audit types are configured in the system.');
        return;
      }

      // Convert arrays of strings to arrays of objects for formatting
      const enabledAudits = enabledAuditTypes.map((auditType) => ({ auditType, isEnabled: true }));
      const disabledAudits = disabledAuditTypes
        .map((auditType) => ({ auditType, isEnabled: false }));

      const textSections = [{
        text: `
*Site Audit Status for ${site.getBaseURL()}*

📊 *Summary:* ${enabledCount} enabled, ${disabledCount} disabled (${totalCount} total audit types)

${formatAuditStatus(enabledAudits, disabledAudits)}
  `,
      }];

      await sendMessageBlocks(say, textSections, [], { unfurl_links: false });
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

export default GetSiteAuditsCommand;
