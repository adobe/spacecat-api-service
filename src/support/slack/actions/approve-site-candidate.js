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
import { BaseSlackClient, SLACK_TARGETS } from '@adobe/spacecat-shared-slack-client';
import { Blocks, Message } from 'slack-block-builder';
import { BUTTON_LABELS } from '../../../controllers/hooks.js';
import { composeReply, extractURLFromSlackMessage } from './commons.js';

async function announceSiteDiscovery(context, baseURL, source) {
  const { SLACK_REPORT_CHANNEL_INTERNAL: channel } = context.env;
  const slackClient = BaseSlackClient.createFrom(context, SLACK_TARGETS.WORKSPACE_INTERNAL);
  const announcementMessage = Message()
    .channel(channel)
    .blocks(
      Blocks.Section()
        .text(`A new site, *<${baseURL}|${baseURL}>*, has gone *live* :rocket: on Edge Delivery Services and has been added to the Star Catalogue. (_source:_ *${source}*)`),
    )
    .buildToObject();
  return slackClient.postMessage(announcementMessage);
}

export default function approveSiteCandidate(lambdaContext) {
  const { dataAccess, log } = lambdaContext;
  const { ORGANIZATION_ID_FRIENDS_FAMILY: friendsFamilyOrgId } = lambdaContext.env;

  return async ({ ack, body, respond }) => {
    const { actions = [], message = {}, user } = body;
    const { blocks } = message;

    log.info(JSON.stringify(body));

    await ack(); // slack expects acknowledgement within 3s

    const baseURL = extractURLFromSlackMessage(blocks[0]?.text?.text);

    const siteCandidate = await dataAccess.getSiteCandidateByBaseURL(baseURL);

    log.info(`Creating a new site: ${baseURL}`);

    const orgId = actions[0]?.text?.text === BUTTON_LABELS.APPROVE_FRIENDS_FAMILY
      && friendsFamilyOrgId;

    const site = await dataAccess.addSite({
      baseURL: siteCandidate.getBaseURL(),
      isLive: true,
      ...(orgId && { orgId: friendsFamilyOrgId }),
    });

    siteCandidate.setSiteId(site.getId());
    siteCandidate.setStatus(SITE_CANDIDATE_STATUS.APPROVED);
    siteCandidate.setUpdatedBy(user.username);

    await dataAccess.updateSiteCandidate(siteCandidate);

    const reply = composeReply({
      blocks,
      username: user.username,
      orgId,
      approved: true,
    });

    await respond(reply);

    await announceSiteDiscovery(lambdaContext, baseURL, siteCandidate.getSource());
  };
}
