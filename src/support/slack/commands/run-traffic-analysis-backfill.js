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

import {
  hasText,
  isNonEmptyObject,
  isValidUrl,
} from '@adobe/spacecat-shared-utils';

import BaseCommand from './base.js';
import {
  extractURLFromSlackInput,
  postErrorMessage,
  postSiteNotFoundMessage,
} from '../../../utils/slack/base.js';
import { triggerTrafficAnalysisBackfill } from '../../utils.js';

const TRAFFIC_ANALYSIS_IMPORT_TYPE = 'traffic-analysis';
const PHRASES = ['run traffic-analysis-backfill'];

/**
 * Factory function to create the RunTrafficAnalysisBackfillCommand object.
 *
 * @param {Object} context - The context object.
 * @returns {RunTrafficAnalysisBackfillCommand} The RunTrafficAnalysisBackfillCommand object.
 * @constructor
 */
function RunTrafficAnalysisBackfillCommand(context) {
  const baseCommand = BaseCommand({
    id: 'run-traffic-analysis-backfill',
    name: 'Run Traffic Analysis Backfill',
    description: 'Runs the traffic analysis import prior to current calendar week for the site identified with its id; number of weeks can be specified and is 52 by default.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {baseURL|CSV-file} {weeks}`,
  });

  const { dataAccess, log } = context;
  const { Configuration, Site } = dataAccess;

  /**
   * Validates input and triggers a new import run for the given site.
   *
   * @param {string[]} args - The arguments provided to the command ([site]).
   * @param {Object} slackContext - The Slack context object.
   * @param {Function} slackContext.say - The Slack say function.
   * @returns {Promise} A promise that resolves when the operation is complete.
   */
  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;

    const config = await Configuration.findLatest();
    /* todo: uncomment after summit and back-office-UI support for configuration setting (roles)
    const slackRoles = config.getSlackRoles() || {};
    const admins = slackRoles?.import || [];

    if (!admins.includes(user)) {
      await say(':error: Only members of role \"import\" can run this command.');
      return;
    }
    */

    try {
      const [baseURLInput, weeks] = args;
      const baseURL = extractURLFromSlackInput(baseURLInput);
      const hasValidBaseURL = isValidUrl(baseURL);

      if (!hasText(TRAFFIC_ANALYSIS_IMPORT_TYPE) || !hasValidBaseURL) {
        await say(baseCommand.usage());
        return;
      }

      const site = await Site.findByBaseURL(baseURL);
      if (!isNonEmptyObject(site)) {
        await postSiteNotFoundMessage(say, baseURL);
        return;
      }

      // Fail safe in case the job will be removed in the future
      const jobConfig = config.getJobs()?.filter((job) => job.group === 'imports' && job.type === TRAFFIC_ANALYSIS_IMPORT_TYPE);

      if (!Array.isArray(jobConfig) || jobConfig.length === 0) {
        await say(`:warning: Import type ${TRAFFIC_ANALYSIS_IMPORT_TYPE} does not exist.`);
        return;
      }

      const siteConfig = site.getConfig();
      const isTrafficAnalysisEnabled = siteConfig?.isImportEnabled(TRAFFIC_ANALYSIS_IMPORT_TYPE);

      if (!isTrafficAnalysisEnabled) {
        await say(`:warning: Import type ${TRAFFIC_ANALYSIS_IMPORT_TYPE} is not enabled for site \`${baseURL}\``);
        return;
      }

      if (weeks !== undefined && (!Number.isSafeInteger(Number(weeks)) || !(weeks > 0))) {
        await say(':warning: Invalid number of weeks specified. Please provide a positive integer.');
        return;
      }

      // const weekYearPairs = getLastNumberOfWeeks(weeks || 52);

      const message = `:adobe-run: Triggered backfill for traffic analysis import for site \`${baseURL}\` for the last ${weeks || 52} weeks\n`;
      await say(message);

      await triggerTrafficAnalysisBackfill(
        site.getId(),
        config,
        slackContext,
        context,
        weeks || 52,
      );

    //   await Promise.all(
    //     weekYearPairs.map(async ({ week, year }) => {
    //       await runTrafficAnalysisImportForSite(
    //         site,
    //         week,
    //         year,
    //         config,
    //         slackContext,
    //       );
    //     }),
    //   );
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

export default RunTrafficAnalysisBackfillCommand;
