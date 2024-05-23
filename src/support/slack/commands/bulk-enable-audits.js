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
import bulkUpdateSitesConfig from '../../../controllers/sites.js';

const PHRASES = ['bulk enable audits'];

function BulkEnableAuditsCommand(context) {
  const baseCommand = BaseCommand({
    id: 'bulk-enable-audits',
    name: 'Bulk Enable Audits',
    description: 'Enables audits for multiple sites.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {site1,site2,...} {auditType1,auditType2,...}`,
  });

  const { log } = context;

  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;

    try {
      const [baseURLsInput, auditTypesInput] = args;

      const baseURLs = baseURLsInput.split(',');
      const auditTypes = auditTypesInput.split(',');

      const enableAudits = true;

      const responses = await bulkUpdateSitesConfig({
        data: { baseURLs, enableAudits, auditTypes },
      });

      let message = 'Bulk update completed with the following responses:\n';
      responses.forEach((response) => {
        message += `- ${response.baseURL}: ${response.response.status}\n`;
      });

      await say(message);
    } catch (error) {
      log.error(error);
      await say(`Error during bulk update: ${error.message}`);
    }
  };

  baseCommand.init(context);

  return {
    ...baseCommand,
    handleExecution,
  };
}

export default BulkEnableAuditsCommand;
