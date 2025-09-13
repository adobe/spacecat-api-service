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
  const { log, dataAccess, sqs, env } = context;
  const { Configuration, Organization, Site } = dataAccess;

  const baseCommand = BaseCommand({
    id: 'run-internal-report',
    name: 'Run Internal Report',
    description: 'Run internal report for all sites, or for a specific org/site/audit type. Usage: run internal report [reportType] [orgId] [siteBaseURL] [auditType]',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} [reportType (optional)] [orgId (optional)] [siteBaseURL (optional)] [auditType (optional)]`,
  });

  /**
   * Runs an internal report for the given type, org, site, and auditType.
   *
   * @param {string[]} args - The arguments provided to the command.
   * @param {Object} slackContext - The Slack context object.
   */
  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;
    const config = await Configuration.findLatest();

    try {
      let [reportType, orgId, siteBaseURL, auditType] = args;

      // Default reportType if not provided
      if (!reportType || reportType === '') {
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

      // If no org/site/auditType provided, run for all sites (default)
      if (!orgId && !siteBaseURL && !auditType) {
        await triggerInternalReportRun(
          config,
          reportType,
          slackContext,
          context,
        );
        await say(`:adobe-run: Triggered report generation for: *${reportType}* for all sites`);
        return;
      }

      // If orgId or siteBaseURL or auditType is provided, trigger for specific org/site/auditType
      // This will send a message to the reports queue with the filter parameters
      // (downstream jobs-dispatcher must support these fields)
      const queueUrl = config.getQueues().reports;
      const filter = {};
      if (orgId) filter.orgId = orgId;
      if (siteBaseURL) filter.siteBaseURL = siteBaseURL;
      if (auditType) filter.auditType = auditType;

      await sqs.sendMessage(queueUrl, {
        type: reportType,
        slackContext: {
          channelId: slackContext.channelId,
          threadTs: slackContext.threadTs,
        },
        ...filter,
      });

      let msg = `:adobe-run: Triggered report generation for: *${reportType}*`;
      if (orgId) msg += `, org: \`${orgId}\``;
      if (siteBaseURL) msg += `, site: \`${siteBaseURL}\``;
      if (auditType) msg += `, auditType: \`${auditType}\``;
      await say(msg);
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
