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

import { isAuditForAllUrls } from '../../support/utils.js';

export const INITIAL_404_SLACK_MESSAGE = '*404 REPORT* for the *last week* :thread:';

export default async function triggerAudit(context) {
  const { log, sqs } = context;
  const { type, url } = context.data;
  const {
    RUM_DOMAIN_KEY: domainkey,
    AUDIT_JOBS_QUEUE_URL: queueUrl,
  } = context.env;

  if (!hasText(domainkey) || !hasText(queueUrl)) {
    throw Error('Required env variables are missing');
  }

  const rumApiClient = RUMAPIClient.createFrom(context);
  const urls = await rumApiClient.getDomainList();
  const filteredUrls = isAuditForAllUrls(url) ? urls : urls.filter((row) => url === row);

  if (filteredUrls.length === 0) {
    return notFound('', { 'x-error': 'did not match any url' });
  }

  for (const filteredUrl of filteredUrls) {
    const siteBaseURL = `https://${filteredUrl}`;
    // eslint-disable-next-line no-await-in-loop
    await sqs.sendMessage(queueUrl, { type, url: siteBaseURL });
  }

  const message = `Successfully queued ${type} audit jobs for ${filteredUrls.length} url/s`;
  log.info(message);

  return new Response(JSON.stringify({ message }));
}
