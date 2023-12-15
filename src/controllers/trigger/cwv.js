/*
 * Copyright 2023 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { Response } from '@adobe/fetch';
import { hasText } from '@adobe/spacecat-shared-utils';
import RUMAPIClient from '@adobe/spacecat-shared-rum-api-client';
import { notFound } from '@adobe/spacecat-shared-http-utils';

import { isAuditForAll } from '../../support/utils.js';
import { getSlackContext } from '../../utils/slack/base.js';

export const INITIAL_CWV_SLACK_MESSAGE = '*PERFORMANCE DEGRADATION (CWV) REPORT* for the *last week* :thread:';

// fallback slack channel (franklin-spacecat-internal-test) hardcoded to use when no appropriate
// slack channel was provided as parameter

/**
 * Destructs the env variable in name1=lid1,name2=id2 comma separated pairs and matches the
 * channel name which is provided by the target variable. Then returns the matched channel id
 * If no channel is matched to the given target param, then id of the fallback channel is returned
 * @param target name of the channel to match
 * @param targetChannels env variable in name=id,name=id form
 * @returns {*|string}
 */

export default async function triggerAudit(context) {
  const { log, sqs } = context;
  const { type, url, target } = context.data;
  const {
    RUM_DOMAIN_KEY: domainkey,
    AUDIT_JOBS_QUEUE_URL: queueUrl,
    TARGET_SLACK_CHANNELS: targetChannels,
    SLACK_BOT_TOKEN: token,
  } = context.env;

  if (!hasText(domainkey) || !hasText(queueUrl)) {
    throw Error('Required env variables are missing');
  }
  const rumApiClient = RUMAPIClient.createFrom(context);

  const urls = await rumApiClient.getDomainList();
  const filteredUrls = isAuditForAll(url) ? urls : urls.filter((row) => url === row);

  if (filteredUrls.length === 0) {
    return notFound('', { 'x-error': 'did not match any url' });
  }

  const slackContext = await getSlackContext({
    target, targetChannels, url, message: INITIAL_CWV_SLACK_MESSAGE, token,
  });

  for (const filteredUrl of filteredUrls) {
    const auditContext = {
      ...(slackContext && { slackContext }),
    };
    // eslint-disable-next-line no-await-in-loop
    await sqs.sendMessage(queueUrl, { type, url: filteredUrl, auditContext });
  }

  const message = `Successfully queued ${type} audit jobs for ${filteredUrls.length} url/s`;
  log.info(message);

  return new Response(JSON.stringify({ message }));
}
