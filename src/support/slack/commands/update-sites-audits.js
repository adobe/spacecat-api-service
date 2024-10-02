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
import { isValidUrl } from '@adobe/spacecat-shared-utils';
import BaseCommand from './base.js';
import { extractURLFromSlackInput } from '../../../utils/slack/base.js';
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

  const validateInput = ({ baseURLs, enableAudits, auditTypes }) => {
    if (!Array.isArray(baseURLs) || baseURLs.length === 0) {
      throw new Error('Base URLs are required');
    }

    for (const baseURL of baseURLs) {
      if (baseURL.length === 0) {
        throw new Error('Invalid URL format');
      }
      if (!isValidUrl(baseURL)) {
        throw new Error(`Invalid URL format: ${baseURL}`);
      }
    }

    if (!Array.isArray(auditTypes) || auditTypes.length === 0) {
      throw new Error('Audit types are required');
    }

    if (enableAudits.length === 0) {
      throw new Error('enable/disable value is required');
    }

    if (['enable', 'disable'].includes(enableAudits) === false) {
      throw new Error(`Invalid enable/disable value: ${enableAudits}`);
    }
  };

  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;
    const [enableAuditsInput, baseURLsInput, auditTypesInput] = args;

    const enableAudits = enableAuditsInput.toLowerCase();
    const baseURLs = baseURLsInput.length > 0 ? baseURLsInput.split(',') : [];
    const auditTypes = auditTypesInput.length > 0 ? auditTypesInput.split(',') : [];

    try {
      validateInput({ baseURLs, enableAudits, auditTypes });
    } catch (error) {
      await say(error.message || 'An error occurred during the request');
      return;
    }

    try {
      let needToUpdateConfiguration = false;
      const configuration = await dataAccess.getConfiguration();

      const responses = await Promise.all(
        baseURLs
          .map(async (baseURL) => {
            const site = await dataAccess.getSiteByBaseURL(extractURLFromSlackInput(baseURL));

            if (!site) {
              return { payload: `Cannot update site with baseURL: ${baseURL}, site not found` };
            }

            needToUpdateConfiguration = true;
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

      if (needToUpdateConfiguration === true) {
        await dataAccess.updateConfiguration(ConfigurationDto.toJSON(configuration));
      }

      const message = `Bulk update completed with the following responses:\n${responses
        .map((response) => response.payload)
        .join('\n')}\n`;

      await say(message);
    } catch (error) {
      log.error(error);
      await say(`:nuclear-warning: Failed to enable audits for all provided sites: ${error.message}`);
    }
  };

  baseCommand.init(context);

  return {
    ...baseCommand,
    handleExecution,
  };
};
