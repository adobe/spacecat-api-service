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
import { triggerInternalReportRun } from '../../utils.js';

/* eslint-disable no-useless-escape */
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
 * @constructor
 */
function runInternalReportCommand(context) {
  const { log, dataAccess } = context;
  const { Configuration } = dataAccess;

  const baseCommand = BaseCommand({
    id: 'run-internal-report',
    name: 'Run Internal Report',
    description: 'Run internal report for all sites. Runs usage-metrics-internal by default if no report type parameter is provided.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} [reportType (optional)]`,
  });

  /**
   * Runs an internal report for the given type.
   *
   * @param {string[]} args - The arguments provided to the command.
   * @param {Object} slackContext - The Slack context object.
   */
  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;
    const config = await Configuration.findLatest();

    try {
      let [reportType] = args;

      if (reportType === '') {
        reportType = 'usage-metrics-internal';
      }

      if (reportType === 'all') {
        await say(`:warning: reportType ${reportType} not available. Valid types are: \`${REPORTS.join('\`, \`')}\``);
        return;
      }

      if (!REPORTS.includes(reportType)) {
        await say(`:warning: reportType ${reportType} is not a valid internal report type. Valid types are: \`${REPORTS.join('\`, \`')}\``);
        return;
      }

      await triggerInternalReportRun(
        config,
        reportType,
        slackContext,
        context,
      );

      await say(`:adobe-run: Triggered report generation for: *${reportType}* for all sites`);
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
