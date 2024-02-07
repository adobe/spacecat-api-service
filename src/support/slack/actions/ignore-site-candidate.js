/*
 * Copyright 2024 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { SITE_CANDIDATE_STATUS } from '@adobe/spacecat-shared-data-access/src/models/site-candidate.js';
import { composeReply, extractURLFromSlackMessage } from './commons.js';

export default function ignoreSiteCandidate(lambdaContext) {
  const { dataAccess, log } = lambdaContext;

  return async ({ ack, body, respond }) => {
    const { message = {}, user } = body;
    const { blocks } = message;

    log.info(JSON.stringify(body));

    await ack(); // slack expects acknowledgement within 3s

    const baseURL = extractURLFromSlackMessage(blocks[0]?.text?.text);

    log.info(`Site is ignored: ${baseURL}`);

    const siteCandidate = await dataAccess.getSiteCandidateByBaseURL(baseURL);

    siteCandidate.setStatus(SITE_CANDIDATE_STATUS.IGNORED);
    siteCandidate.setUpdatedBy(user.username);

    await dataAccess.updateSiteCandidate(siteCandidate);

    const reply = composeReply(blocks, true);
    await respond(reply);
  };
}
