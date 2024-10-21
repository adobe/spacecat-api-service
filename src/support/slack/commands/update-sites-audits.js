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
import BaseCommand from './base.js';
import { extractURLFromSlackInput } from '../../../utils/slack/base.js';
import { ConfigurationDto } from '../../../dto/configuration.js';

const PHRASES = ['audits'];
const ERROR_MESSAGE_PREFIX = ':nuclear-warning: ';

export default (context) => {
  const baseCommand = BaseCommand({
    id: 'sites--audits',
    name: 'Update Sites Audits Configuration',
    description: 'Enables or disables audit functionality for multiple sites.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {enable/disable} {site1,site2,...} {auditType1,auditType2,...}`,
  });

  const { log, dataAccess } = context;

  const validateInput = ({ baseURLs, enableAudits, auditTypes }) => {
    if (!Array.isArray(baseURLs) || baseURLs.length === 0) {
      throw new Error('Sites URLs are required.');
    }

    if (auditTypes.length === 0) {
      throw new Error('The audit types parameter must be a list of valid audits, separated by commas.');
    }

    if (enableAudits.length === 0) {
      throw new Error('The "enableAudits" parameter is required and must be set to "enable" or "disable".');
    }

    if (['enable', 'disable'].includes(enableAudits) === false) {
      throw new Error('The "enableAudits" parameter is required and must be set to "enable" or "disable".');
    }
  };

  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;
    const [enableAuditsInput, baseURLsInput, auditTypesInput] = args;

    const enableAudits = enableAuditsInput.toLowerCase();
    const baseURLs = baseURLsInput.length > 0 ? baseURLsInput.split(',') : [];
    if (baseURLs) {
      baseURLs.map((baseURL) => extractURLFromSlackInput(baseURL));
    }
    const auditTypes = auditTypesInput.length > 0 ? auditTypesInput.split(',') : [];

    try {
      validateInput({ baseURLs, enableAudits, auditTypes });
    } catch (error) {
      await say(`${ERROR_MESSAGE_PREFIX}${error.message}`);
      return;
    }

    try {
      let hasUpdates = false;
      const configuration = await dataAccess.getConfiguration();

      const responses = await Promise.all(
        baseURLs
          .map(async (baseURL) => {
            const site = await dataAccess.getSiteByBaseURL(extractURLFromSlackInput(baseURL));

            if (!site) {
              return { payload: `Cannot update site with baseURL: ${baseURL}, site not found` };
            }

            hasUpdates = true;
            for (const auditType of auditTypes) {
              if (enableAudits === 'enable') {
                configuration.enableHandlerForSite(auditType, site);
              } else {
                configuration.disableHandlerForSite(auditType, site);
              }
            }

            return { payload: `${site.getBaseURL()}: successfully updated` };
          }),
      );

      if (hasUpdates === true) {
        await dataAccess.updateConfiguration(ConfigurationDto.toJSON(configuration));
      }

      const message = `Bulk update completed with the following responses:\n${responses
        .map((response) => response.payload)
        .join('\n')}\n`;

      await say(message);
    } catch (error) {
      log.error(error);
      // In the Slack command case, we shared the internal error with the user
      await say(`${ERROR_MESSAGE_PREFIX}An error occurred while trying to enable or disable audits: ${error.message}`);
    }
  };

  baseCommand.init(context);

  return {
    ...baseCommand,
    handleExecution,
  };
};
