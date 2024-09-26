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
import { extractURLFromSlackInput, postErrorMessage } from '../../../utils/slack/base.js';
import { ConfigurationDto } from '../../../dto/configuration.js';

const PHRASES = ['audits'];

export default (context) => {
  const baseCommand = BaseCommand({
    id: 'sites--audits',
    name: 'Update Sites Audits',
    description: 'Enables or disables audits for multiple sites.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {enable/disable} {site1,site2,...} {auditType1,auditType2,...}`,
  });

  const { log, dataAccess } = context;

  const isValidEnableDisable = (input) => {
    const normalizedInput = input.toLowerCase();
    return ['enable', 'disable'].includes(normalizedInput);
  };

  // Utility function to update a single site based on the audits
  const updateSiteAudits = async (enableAudits, site, auditTypes, configuration) => {
    try {
      auditTypes.forEach((auditType) => {
        enableAudits
          ? configuration.enableHandlerForSite(auditType, site)
          : configuration.disableHandlerForSite(auditType, site);
      });
      return { payload: `${site.getBaseURL()}: successfully updated` };
    } catch (error) {
      return { payload: `Error updating ${site.getBaseURL()}: ${error.message}` };
    }
  };

  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;

    try {
      const [enableDisableInput, baseURLsInput, auditTypesInput] = args;

      if (!isValidEnableDisable(enableDisableInput)) {
        await say(`Invalid enable/disable command: ${enableDisableInput}`);
        return;
      }

      const baseURLs = baseURLsInput.split(',');
      const auditTypes = auditTypesInput.split(',');

      const enableAudits = enableDisableInput.toLowerCase() === 'enable';
      const configuration = await dataAccess.getConfiguration();

      const siteResponses = await Promise.all(
        baseURLs.map(async (baseURLInput) => {
          const baseURL = extractURLFromSlackInput(baseURLInput);
          const site = await dataAccess.getSiteByBaseURL(baseURL);

          if (!site) {
            return { payload: `Cannot update site with baseURL: ${baseURL}, site not found` };
          }

          return await updateSiteAudits(enableAudits, site, auditTypes, configuration);
        }),
      );

      await dataAccess.updateConfiguration(ConfigurationDto.toJSON(configuration));

      const message = `Bulk update completed with the following responses:\n${siteResponses
        .map((response) => response.payload)
        .join('\n')}\n`;

      await say(message);
    } catch (error) {
      log.error(error);
      await postErrorMessage(say, `Error during bulk update: ${error.message}`);
    }
  };

  baseCommand.init(context);

  return {
    ...baseCommand,
    handleExecution,
  };
};
