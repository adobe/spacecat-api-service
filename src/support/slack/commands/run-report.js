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

import BaseCommand from './base.js';

import {
  postErrorMessage,
} from '../../../utils/slack/base.js';

import { triggerReportForSite } from '../../utils.js';

const PHRASES = ['run report'];
const FORMS_INTERNAL = 'forms-internal';

/**
 * Factory function to create the RunReportCommand object.
 *
 * @param {Object} context - The context object.
 * @returns {RunReportCommand} The RunReportCommand object.
 * @constructor
 */
function RunReportCommand(context) {
  const baseCommand = BaseCommand({
    id: 'run-report',
    name: 'Run Report',
    description: 'Run report. Runs forms-internal by default if no report type parameter is provided.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {reportType}`,
  });

  const { log } = context;

  /**
     * Validates input, fetches the site
     * and triggers a new audit for the given site
     *
     * @param {string[]} args - The arguments provided to the command ([site]).
     * @param {Object} slackContext - The Slack context object.
     * @param {Function} slackContext.say - The Slack say function.
     * @returns {Promise} A promise that resolves when the operation is complete.
     */
  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;

    try {
      log.info(`RunReportCommand: Received args: ${JSON.stringify(args)}`);
      const [reportTypeInputArg] = args;
      const reportType = reportTypeInputArg || FORMS_INTERNAL;
      log.info(`Triggering report type: ${reportType} via queue: ${context.env.REPORT_JOBS_QUEUE_URL}`);
      await triggerReportForSite(reportType, slackContext, context);
      say(`:adobe-run: Triggering ${reportType} report`);
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

export default RunReportCommand;
