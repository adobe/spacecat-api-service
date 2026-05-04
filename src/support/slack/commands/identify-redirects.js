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
import { queueIdentifyRedirectsAudit } from '../../utils.js';

import BaseCommand from './base.js';
import { extractURLFromSlackInput, postErrorMessage } from '../../../utils/slack/base.js';

const PHRASES = ['identify-redirects'];
const DEFAULT_MINUTES = 2500; // 41 hours, 40 minutes

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
    log,
    updateRedirects = false,
  } = context;
  const { Site } = dataAccess;

  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;

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

      const result = await queueIdentifyRedirectsAudit({
        site,
        baseURL,
        minutes,
        updateRedirects,
        slackContext,
      }, context);

      if (!result.ok) {
        await say(result.message || result.error);
      }
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
