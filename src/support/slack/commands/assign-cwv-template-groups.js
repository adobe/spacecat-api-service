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
import { Audit } from '@adobe/spacecat-shared-data-access';
import { isString } from '@adobe/spacecat-shared-utils';
import { Config } from '@adobe/spacecat-shared-data-access/src/models/site/config.js';
import BaseCommand from './base.js';
import { extractURLFromSlackInput } from '../../../utils/slack/base.js';

const PHRASE = 'assign cwv template groups';
const SUCCESS_MESSAGE_PREFIX = ':white_check_mark: ';
const ERROR_MESSAGE_PREFIX = ':x: ';

export default (context) => {
  const baseCommand = BaseCommand({
    id: 'configurations-sites--assign-cwv-template-groups',
    name: 'Assign Template-Based Page Groups',
    description: 'Automatically groups pages by URL pattern based on the latest CWV audit. Falls back to manual grouping if needed.',
    phrases: [PHRASE],
    usageText: `${PHRASE} {site}`,
  });

  const { log, dataAccess } = context;
  const { Site } = dataAccess;

  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;
    const [baseURLInput] = args;

    try {
      const baseURL = extractURLFromSlackInput(baseURLInput);

      if (isString(baseURL) === false || baseURL.length === 0) {
        await say(`${ERROR_MESSAGE_PREFIX}The site URL is missing or in the wrong format.`);
        return;
      }

      const site = await Site.findByBaseURL(baseURL);
      if (!site) {
        await say(`${ERROR_MESSAGE_PREFIX}Site with baseURL "${baseURL}" not found.`);
        return;
      }

      const siteConfig = site.getConfig();
      await say(`${SUCCESS_MESSAGE_PREFIX}${JSON.stringify(siteConfig, null, 2)}`);

      const groupedURLs = [{ pattern: 'test' }];
      const currentGroupedURLs = siteConfig.getGroupedURLs(Audit.AUDIT_TYPES.CWV) || [];
      let patchedGroupedURLs = [];
      if (groupedURLs.length !== 0) {
        patchedGroupedURLs = Object.values(
          [...currentGroupedURLs, ...groupedURLs].reduce((acc, item) => {
            acc[item.pattern] = item;
            return acc;
          }, {}),
        );
      }

      // if objects are not equal
      siteConfig.updateGroupedURLs(Audit.AUDIT_TYPES.CWV, patchedGroupedURLs);
      site.setConfig(Config.toDynamoItem(siteConfig));
      // await site.save();

      const groupCount = 0;
      await say(`${SUCCESS_MESSAGE_PREFIX}Found ${groupCount} new group(s) for site "${baseURL}" and added them to the configuration. Please re-run the CWV audit to see the results.`);
    } catch (error) {
      log.error(error);
      await say(`${ERROR_MESSAGE_PREFIX}An error occurred while trying to automatically group pages by URL pattern: ${error.message}.`);
    }
  };

  baseCommand.init(context);

  return {
    ...baseCommand,
    handleExecution,
  };
};
