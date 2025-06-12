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

import {
  extractURLFromSlackInput,
  postErrorMessage,
  postSiteNotFoundMessage,
  sendMessageBlocks,
} from '../../../utils/slack/base.js';

const PHRASES = ['get site audits'];

/**
 * Formats the audit status list showing enabled and disabled audit types.
 *
 * @param {Array<Object>} auditResults - Array of audit result objects with auditType and isEnabled.
 * @returns {string} The formatted audit status list.
 */
export function formatAuditStatus(auditResults) {
  const enabledAudits = auditResults.filter((result) => result.isEnabled);
  const disabledAudits = auditResults.filter((result) => !result.isEnabled);

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

      const site = await Site.findByBaseURL(baseURL);

      if (!site) {
        await postSiteNotFoundMessage(say, baseURL);
        return;
      }

      const configuration = await Configuration.findLatest();
      const registeredAudits = configuration.getHandlers();
      const auditTypes = Object.keys(registeredAudits);

      if (!auditTypes.length) {
        await say(':warning: No audit types are configured in the system.');
        return;
      }

      // Check status for all audit types
      const auditResults = auditTypes.map((auditType) => {
        const isEnabled = configuration.isHandlerEnabledForSite(auditType, site);
        return {
          auditType,
          isEnabled,
        };
      });

      const enabledCount = auditResults.filter((result) => result.isEnabled).length;
      const disabledCount = auditResults.filter((result) => !result.isEnabled).length;

      const textSections = [{
        text: `
*Site Audit Status for ${site.getBaseURL()}*

📊 *Summary:* ${enabledCount} enabled, ${disabledCount} disabled (${auditTypes.length} total audit types)

${formatAuditStatus(auditResults)}
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
