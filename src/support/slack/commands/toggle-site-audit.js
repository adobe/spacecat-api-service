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
import { isString } from '@adobe/spacecat-shared-utils';
import BaseCommand from './base.js';
import { extractURLFromSlackInput } from '../../../utils/slack/base.js';

const PHRASE = 'audit';
const SUCCESS_MESSAGE_PREFIX = ':white_check_mark: ';
const ERROR_MESSAGE_PREFIX = ':x: ';

export default (context) => {
  const baseCommand = BaseCommand({
    id: 'configurations-sites--toggle-site-audit',
    name: 'Enable/Disable the Site Audit',
    description: 'Enables or disables an audit functionality for a site.',
    phrases: [PHRASE],
    usageText: `${PHRASE} {enable/disable} {site} {auditType}`,
  });

  const { log, dataAccess } = context;
  const { Configuration, Site } = dataAccess;

  const validateInput = (enableAudit, baseURL, auditType) => {
    if (isString(enableAudit) === false || ['enable', 'disable'].includes(enableAudit) === false) {
      throw new Error('The "enableAudit" parameter is required and must be set to "enable" or "disable".');
    }

    if (isString(baseURL) === false || baseURL.length === 0) {
      throw new Error('The site URL is missing or in the wrong format.');
    }

    if (isString(auditType) === false || auditType.length === 0) {
      throw new Error('The audit type parameter is required.');
    }
  };

  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;
    const [enableAuditInput, baseURLInput, auditTypeInput] = args;

    const enableAudit = enableAuditInput.toLowerCase();
    const baseURL = extractURLFromSlackInput(baseURLInput);
    const auditType = auditTypeInput.toLowerCase();

    try {
      validateInput(enableAudit, baseURL, auditType);
    } catch (error) {
      await say(`${ERROR_MESSAGE_PREFIX}${error.message}`);
      return;
    }

    try {
      const configuration = await Configuration.findLatest();
      const site = await Site.findByBaseURL(baseURL);

      if (site === null) {
        await say(`${ERROR_MESSAGE_PREFIX}Cannot update site with baseURL: "${baseURL}", site not found.`);
        return;
      }

      const registeredAudits = configuration.getHandlers();
      if (!registeredAudits[auditType]) {
        await say(`${ERROR_MESSAGE_PREFIX}The "${auditType}" is not present in the configuration.\nList of allowed`
            + ` audits:\n${Object.keys(registeredAudits).join('\n')}.`);
        return;
      }

      let successMessage;
      if (enableAudit === 'enable') {
        configuration.enableHandlerForSite(auditType, site);
        successMessage = `${SUCCESS_MESSAGE_PREFIX}The audit "${auditType}" has been *enabled* for the "${site.getBaseURL()}".`;
      } else {
        configuration.disableHandlerForSite(auditType, site);
        successMessage = `${SUCCESS_MESSAGE_PREFIX}The audit "${auditType}" has been *disabled* for the "${site.getBaseURL()}".`;
      }

      await configuration.save();
      await say(successMessage);
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
