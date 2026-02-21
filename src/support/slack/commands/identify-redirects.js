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

import { Site as SiteModel } from '@adobe/spacecat-shared-data-access';
import { hasText } from '@adobe/spacecat-shared-utils';

import BaseCommand from './base.js';
import { extractURLFromSlackInput, postErrorMessage } from '../../../utils/slack/base.js';

const PHRASES = ['identify-redirects'];
const DEFAULT_MINUTES = 60;

export default function IdentifyRedirectsCommand(context) {
  const baseCommand = BaseCommand({
    id: 'identify-redirects',
    name: 'Identify Redirects',
    description: 'Detects common redirect-manager patterns using Splunk logs (AEM CS/CW only).',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {baseURL}`,
  });

  const {
    dataAccess,
    env,
    log,
    sqs,
  } = context;
  const { Site } = dataAccess;

  const handleExecution = async (args, slackContext) => {
    const { say, channelId, threadTs } = slackContext;

    try {
      const [baseURLInput, minutesInput] = args;
      const baseURL = extractURLFromSlackInput(baseURLInput);
      const minutes = Number.isFinite(Number(minutesInput))
        ? Number(minutesInput)
        : DEFAULT_MINUTES;

      if (!baseURL) {
        await say(baseCommand.usage());
        return;
      }

      const site = await Site.findByBaseURL(baseURL);
      if (!site) {
        await say(`:x: No site found with base URL '${baseURL}'.`);
        return;
      }

      const authoringType = site.getAuthoringType();
      if (![
        SiteModel.AUTHORING_TYPES.CS,
        SiteModel.AUTHORING_TYPES.CS_CW,
      ].includes(authoringType)) {
        await say(`:warning: identify-redirects currently supports AEM CS/CW only. This site authoringType is \`${authoringType}\`.`);
        return;
      }

      const deliveryConfig = site.getDeliveryConfig?.() || {};
      const { programId, environmentId } = deliveryConfig;

      if (!hasText(programId) || !hasText(environmentId)) {
        await say(':warning: This site is missing `deliveryConfig.programId` and/or `deliveryConfig.environmentId` required for Splunk queries.');
        return;
      }

      if (!hasText(env?.AUDIT_JOBS_QUEUE_URL)) {
        await say(':x: Server misconfiguration: missing `AUDIT_JOBS_QUEUE_URL`.');
        return;
      }

      if (!sqs) {
        await say(':x: Server misconfiguration: missing SQS client.');
        return;
      }

      await say(`:mag: Queued redirect pattern detection for *${baseURL}* (last ${minutes}m). I’ll reply here when it’s ready.`);

      await sqs.sendMessage(env.AUDIT_JOBS_QUEUE_URL, {
        type: 'identify-redirects',
        siteId: site.getId(),
        baseURL,
        programId: String(programId),
        environmentId: String(environmentId),
        minutes,
        slackContext: {
          channelId,
          threadTs,
        },
      });
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
