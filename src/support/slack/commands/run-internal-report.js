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

import { hasText } from '@adobe/spacecat-shared-utils';
import BaseCommand from './base.js';
import { postErrorMessage } from '../../../utils/slack/base.js';
import { triggerInternalReportRun } from '../../utils.js';

const PHRASES = ['run internal report'];
const REPORTS = [
  'usage-metrics-internal',
  'audit-site-overview-internal',
];

/**
 * Run Internal Report command.
 *
 * @param {Object} context - The context object.
 * @return {RunInternalReportCommand} The runInternalReportCommand object.
 * @constructor
 */
function RunInternalReportCommand(context) {
  const { log, Configuration } = context;
  log.info('Run internal report command recognized');

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
   * @param {string[]} args - The arguments provided to the command.
   * @param {Object} slackContext - The Slack context object.
   */
  // write tests for this - check run-import how it's done
  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;
    log.info('Handle execution should start');
    const config = await Configuration.findLatest();

    try {
      const [reportType] = args;
      if (!hasText(reportType)) {
        await say(baseCommand.usage());
        return;
      }

      if (!REPORTS.includes(reportType)) {
        await say(`:warning: reportType ${reportType} is not a valid internal report type. Valid types are: ${REPORTS.join(', ')}`);
        return;
      }

      await say(`Triggering report generation for: *${reportType}* for all sites`);

      await triggerInternalReportRun(
        config,
        reportType,
        slackContext,
        context,
      );

      await say(`:adobe-run: Triggered report generation for: *${reportType}* for all sites`);
      log.info('Triggered report');
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

export default RunInternalReportCommand;
