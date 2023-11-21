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
import { fetch } from '../support/utils.js';
import { postSlackMessage } from '../support/slack.js';

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

function isAuditForAll(url) {
  return url.toUpperCase() === 'ALL';
}

/**
 *
 * @param target
 * @param targetChannels
 * @returns {*|string}
 */
export function getSlackChannelId(target, targetChannels = '') {
  const channel = targetChannels.split(',')
    .filter((pair) => pair.startsWith(`${target}=`));
  return channel[0] ? channel[0].split('=')[1] : FALLBACK_SLACK_CHANNEL;
}

async function fetchDomainList(domainkey, url) {
  const params = {
    ...DEFAULT_PARAMS,
    domainkey,
  };

  const resp = await fetch(createUrl(DOMAIN_LIST_URL, params));
  const respJson = await resp.json();

  return respJson?.results?.data?.map((result) => result.hostname)
    .filter((respUrl) => isAuditForAll(url) || url === respUrl);
}

function getSlackContext(target, targetChannels, ) {

}

export default async function triggerCWVAudit(context) {
  const { log, sqs } = context;
  const { type, url, target } = context.data;
  const {
    RUM_DOMAIN_KEY: domainkey,
    AUDIT_JOBS_QUEUE_URL: queueUrl,
    TARGET_SLACK_CHANNELS: targetChannels,
  } = context.env;

  if (!domainkey || !queueUrl) {
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
  if (isAuditForAll(url)) {
    const channelId = getSlackChannelId(target, targetChannels);
    slackContext = await postSlackMessage(channelId, INITIAL_SLACK_MESSAGE, context);
  } else {
    slackContext = { channel: getSlackChannelId(target, targetChannels) };
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
