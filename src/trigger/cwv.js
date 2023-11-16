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

export const DEFAULT_PARAMS = { // export for testing
  interval: 30,
  offset: 0,
  limit: 100000,
};

const DOMAIN_LIST_URL = 'https://helix-pages.anywhere.run/helix-services/run-query@v3/dash/domain-list';
const ALL_URLS = 'ALL';

export default async function triggerCWVAudit(context) {
  const { log, sqs } = context;
  const { type, url } = context.data;
  const {
    RUM_DOMAIN_KEY: domainkey,
    AUDIT_JOBS_QUEUE_URL: queueUrl,
  } = context.env;

  if (!domainkey || !queueUrl) {
    throw Error('Required env variables is missing');
  }

  const params = {
    ...DEFAULT_PARAMS,
    domainkey,
  };

  const resp = await fetch(createUrl(DOMAIN_LIST_URL, params));
  const respJson = await resp.json();

  const respUrls = respJson?.results?.data?.map((result) => result.hostname);
  const matchedUrls = respUrls
    .filter((respUrl) => url.toUpperCase() === ALL_URLS || url === respUrl);

  if (matchedUrls.length === 0) {
    return new Response('', {
      status: 404,
      headers: {
        'x-error': 'not matched any url',
      },
    });
  }

  for (const matchedUrl of matchedUrls) {
    // eslint-disable-next-line no-await-in-loop
    await sqs.sendMessage(queueUrl, { type, url: matchedUrl });
  }

  const message = `Successfully queued ${type} audit jobs for ${matchedUrls.length} url/s`;
  log.info(message);

  return new Response(JSON.stringify({ message }));
}
