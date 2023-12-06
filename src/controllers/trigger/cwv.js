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

import { createUrl, Response } from '@adobe/fetch';
import { hasText } from '@adobe/spacecat-shared-utils';
import { fetch, isAuditForAll } from '../../support/utils.js';
import { postSlackMessage } from '../../support/slack.js';

export const DEFAULT_PARAMS = { // export for testing
  interval: 30,
  offset: 0,
  limit: 100000,
};

const DOMAIN_LIST_URL = 'https://helix-pages.anywhere.run/helix-services/run-query@v3/dash/domain-list';
export const INITIAL_SLACK_MESSAGE = '*PERFORMANCE DEGRADATION (CWV) REPORT* for the *last week* :thread:';
// fallback slack channel (franklin-spacecat-internal-test) hardcoded to use when no appropriate
// slack channel was provided as parameter
export const FALLBACK_SLACK_CHANNEL = 'C060T2PPF8V';

/**
 * Destructs the env variable in name1=lid1,name2=id2 comma separated pairs and matches the
 * channel name which is provided by the target variable. Then returns the matched channel id
 * If no channel is matched to the given target param, then id of the fallback channel is returned
 * @param target name of the channel to match
 * @param targetChannels env variable in name=id,name=id form
 * @returns {*|string}
 */
export function getSlackChannelId(target, targetChannels = '') {
  const channel = targetChannels.split(',')
    .filter((pair) => pair.startsWith(`${target}=`))
    .find((pair) => pair.trim().length > target.length + 1);
  return channel ? channel.split('=')[1].trim() : FALLBACK_SLACK_CHANNEL;
}

async function fetchDomainList(domainkey, url) {
  const params = {
    ...DEFAULT_PARAMS,
    domainkey,
  };

  const resp = await fetch(createUrl(DOMAIN_LIST_URL, params));
  const respJson = await resp.json(); // intentionally not catching parse error here.

  const data = respJson?.results?.data;
  if (!Array.isArray(data)) {
    throw new Error('Unexpected response format. $.results.data is not array');
  }

  const urls = data.map((row) => row.hostname);
  return isAuditForAll(url) ? urls : urls.filter((row) => url === row);
}

export default async function triggerCWVAudit(context) {
  const { log, sqs } = context;
  const { type, url, target } = context.data;
  const {
    RUM_DOMAIN_KEY: domainkey,
    AUDIT_JOBS_QUEUE_URL: queueUrl,
    TARGET_SLACK_CHANNELS: targetChannels,
    SLACK_BOT_TOKEN: token,
  } = context.env;

  if (!hasText(domainkey) || !hasText(queueUrl)) {
    throw Error('Required env variables is missing');
  }

  const filteredUrls = await fetchDomainList(domainkey, url);

  if (filteredUrls.length === 0) {
    return new Response('', {
      status: 404,
      headers: {
        'x-error': 'not matched any url',
      },
    });
  }

  let slackContext;
  // if audit triggered for all urls, then an initial message sent to the channel and the slack
  // thread id is added to auditContext for downstream components to send messages under same thread
  // If audit is triggered for a single url, then only channel id is added to uudit context
  const channelId = getSlackChannelId(target, targetChannels);
  if (isAuditForAll(url)) {
    slackContext = await postSlackMessage(channelId, INITIAL_SLACK_MESSAGE, token);
  } else {
    slackContext = { channel: channelId };
  }

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
