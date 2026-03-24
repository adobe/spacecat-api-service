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

/**
 * Slack slash-style command: `detect-cdn {url}` (single URL argument only).
 *
 * Examples — same invocation shape; behavior differs when the URL is a known SpaceCat site:
 *
 * - `detect-cdn https://example.com` — Queues CDN detection for that URL. The worker replies in
 *   this thread with the detected CDN. If no SpaceCat site uses that base URL, the job has no
 *   `siteId` and the worker does not update delivery configuration.
 *
 * - `detect-cdn https://customer.example` — If that base URL matches a SpaceCat site, the queued
 *   message includes `siteId`; when the worker finishes, it can persist `deliveryConfig.cdn` for
 *   that site (in addition to posting the result in Slack).
 */

import { hasText } from '@adobe/spacecat-shared-utils';

import BaseCommand from './base.js';
import { extractURLFromSlackInput, postErrorMessage } from '../../../utils/slack/base.js';

const PHRASES = ['detect-cdn'];

export default function DetectCdnCommand(context) {
  const baseCommand = BaseCommand({
    id: 'detect-cdn',
    name: 'Detect CDN',
    description:
      'Detects which CDN a website uses (e.g. Cloudflare, Akamai, Fastly) from its HTTP headers. '
      + 'Usage: detect-cdn {url}. The bot always posts the detected CDN in this thread. '
      + 'If {url} matches a SpaceCat site base URL in our system, the worker also saves the CDN '
      + "on that site's delivery configuration.",
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

      // If base URL matches a SpaceCat site, include siteId so the worker can persist
      // deliveryConfig.cdn on that site.
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
