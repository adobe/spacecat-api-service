/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */
/* c8 ignore start */
import BaseCommand from './base.js';
import { postErrorMessage } from '../../../utils/slack/base.js';
import { sendAuditMessage } from '../../utils.js';

const PHRASES = ['run cdn reports bulk publish'];
const AUDIT_TYPE = 'cdn-reports-bulk-publish';

function runCdnReportsBulkPublishCommand(context) {
  const { log, sqs, env } = context;

  const baseCommand = BaseCommand({
    id: 'run-cdn-reports-bulk-publish',
    name: 'Run CDN Reports Bulk Publish',
    description: 'Manually trigger the cross-site cdn-reports-bulk-publish audit. '
      + 'Submits one bulk preview + publish to admin.hlx.page covering every site '
      + 'with cdn-logs-report enabled.',
    phrases: PHRASES,
    usageText: PHRASES[0],
  });

  const handleExecution = async (_args, slackContext) => {
    const { say } = slackContext;
    try {
      await sendAuditMessage(
        sqs,
        env.AUDIT_JOBS_QUEUE_URL,
        AUDIT_TYPE,
        {
          slackContext: {
            channelId: slackContext.channelId,
            threadTs: slackContext.threadTs,
          },
        },
      );
      await say(`:adobe-run: Triggered *${AUDIT_TYPE}*`);
    } catch (error) {
      log.error(`Error triggering ${AUDIT_TYPE}: ${error.message}`);
      await postErrorMessage(say, error);
    }
  };

  baseCommand.init(context);

  return {
    ...baseCommand,
    handleExecution,
  };
}

export default runCdnReportsBulkPublishCommand;
/* c8 ignore end */
