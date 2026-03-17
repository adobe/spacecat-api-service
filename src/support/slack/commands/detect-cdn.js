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

import { hasText } from '@adobe/spacecat-shared-utils';

import BaseCommand from './base.js';
import { extractURLFromSlackInput, postErrorMessage } from '../../../utils/slack/base.js';

const PHRASES = ['detect-cdn'];

export default function DetectCdnCommand(context) {
  const baseCommand = BaseCommand({
    id: 'detect-cdn',
    name: 'Detect CDN',
    description: 'Detects which CDN a website uses (e.g. Cloudflare, Akamai, Fastly) from HTTP headers. Optional: pass a Spacecat site base URL to associate the result with a site for future onboarding.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {url}`,
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
      const [urlInput] = args;
      const baseURL = extractURLFromSlackInput(urlInput);

      if (!baseURL) {
        await say(baseCommand.usage());
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

      // Optional: if URL matches a Spacecat site, pass siteId for future onboarding integration
      let siteId = null;
      try {
        const site = await Site.findByBaseURL(baseURL);
        if (site) {
          siteId = site.getId();
        }
      } catch {
        // ignore; we can still detect CDN for any URL
      }

      await say(`:mag: Queued CDN detection for *${baseURL}*. I'll reply here when it's ready.`);

      await sqs.sendMessage(env.AUDIT_JOBS_QUEUE_URL, {
        type: 'detect-cdn',
        baseURL,
        ...(siteId && { siteId }),
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
    usageText: `${PHRASES[0]} {url}`,
    handleExecution,
  };
}
