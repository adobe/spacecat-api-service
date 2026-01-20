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

import { isNonEmptyArray, isValidUrl } from '@adobe/spacecat-shared-utils';

import BaseCommand from './base.js';
import {
  extractURLFromSlackInput,
  parseCSV,
  postErrorMessage,
  postSiteNotFoundMessage,
} from '../../../utils/slack/base.js';

const PHRASES = ['run page citability'];
const AUDIT_TYPE = 'page-citability';

function RunPageCitabilityCommand(context) {
  const baseCommand = BaseCommand({
    id: 'run-page-citability',
    name: 'Run Page Citability',
    description: 'Run page citability audit for a site with a list of URLs (CSV file).',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {site} (attach CSV file with URLs)`,
  });

  const { dataAccess, sqs, log } = context;
  const { Site, Configuration } = dataAccess;

  const handleExecution = async (args, slackContext) => {
    const { say, files, botToken } = slackContext;

    try {
      const [baseURLInputArg] = args;
      const baseURL = extractURLFromSlackInput(baseURLInputArg);

      if (!isValidUrl(baseURL)) {
        await say(baseCommand.usage());
        return;
      }

      const site = await Site.findByBaseURL(baseURL);
      if (!site) {
        await postSiteNotFoundMessage(say, baseURL);
        return;
      }

      const configuration = await Configuration.findLatest();
      const queueUrl = configuration.getQueues().audits;

      // Check if CSV file is attached
      if (!isNonEmptyArray(files)) {
        await say(':warning: Please attach a CSV file with URLs to audit.');
        return;
      }

      if (files.length > 1) {
        await say(':warning: Please provide only one CSV file.');
        return;
      }

      const file = files[0];
      if (!file.name.endsWith('.csv')) {
        await say(':warning: Please provide a CSV file.');
        return;
      }

      // Parse CSV - expecting URLs in the first column, minimum 1 column
      const csvData = await parseCSV(file, botToken, 1);
      const urls = csvData.map((row) => row[0]).filter((url) => isValidUrl(url));

      if (urls.length === 0) {
        await say(':warning: No valid URLs found in the CSV file.');
        return;
      }

      await say(`:adobe-run: Triggering ${AUDIT_TYPE} audit for site ${baseURL} with ${urls.length} URLs...`);

      // Send audit message with URLs in auditContext
      const message = {
        type: AUDIT_TYPE,
        siteId: site.getId(),
        auditContext: {
          urls,
        },
      };

      await sqs.sendMessage(queueUrl, message);

      await say(`:white_check_mark: ${AUDIT_TYPE} audit queued for ${urls.length} URLs.`);
    } catch (error) {
      log.error('Error running page citability audit:', error);
      await postErrorMessage(say, error);
    }
  };

  baseCommand.init(context);

  return {
    ...baseCommand,
    handleExecution,
  };
}

export default RunPageCitabilityCommand;
