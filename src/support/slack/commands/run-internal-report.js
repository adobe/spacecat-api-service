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
import { postErrorMessage } from '../../../utils/slack/base.js';

const PHRASES = ['run internal report'];
const REPORTS = [
  'usage-metrics-internal',
  'audit-site-overview-internal',
];

/**
 * Run Internal Report command.
 *
 * @param {Object} context - The context object.
 * @return {runInternalReportCommand} The runInternalReportCommand object.
 */
function runInternalReportCommand(context) {
  const { log } = context;

  const baseCommand = BaseCommand({
    id: 'run-internal-report',
    name: 'Run Internal Report',
    description: 'Run internal report for all sites. Runs usage-metrics by default if no report type parameter is provided.', //  Runs all reports if report type is `all` <- add this maybe
    phrases: PHRASES,
    usageText: `${PHRASES[0]} [reportType (optional)]`,
  });

  /**
   * Runs an internal report for the given type.
   *
   * @param {Object} slackContext - The Slack context object.
   * @param {string} reportType - The report type.
   */
  const handleExecution = async (slackContext, reportType) => {
    const { say } = slackContext;

    try {
      if (!reportType) {
        await say(baseCommand.usage());
        return;
      }
      await say(`Starting report generation for: *${reportType}* for all sites`);
      log.info(REPORTS);
    } catch (error) {
      log.error(`Error running internal report: ${error.message}`);
      await postErrorMessage(say, error);
    }
  };

  baseCommand.init(context);

  return {
    ...baseCommand,
    handleExecution,
  };
}

export default runInternalReportCommand;
