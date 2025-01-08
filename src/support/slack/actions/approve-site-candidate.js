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
import { DELIVERY_TYPES } from '@adobe/spacecat-shared-data-access/src/models/site.js';
import { KEY_EVENT_TYPES } from '@adobe/spacecat-shared-data-access/src/models/key-event.js';
import { BaseSlackClient, SLACK_TARGETS } from '@adobe/spacecat-shared-slack-client';
import { Blocks, Message } from 'slack-block-builder';
import { BUTTON_LABELS } from '../../../controllers/hooks.js';
import { composeReply, extractURLFromSlackMessage } from './commons.js';
import { getHlxConfigMessagePart } from '../../../utils/slack/base.js';

async function announceSiteDiscovery(context, baseURL, source, hlxConfig) {
  const { SLACK_REPORT_CHANNEL_INTERNAL: channel } = context.env;
  const slackClient = BaseSlackClient.createFrom(context, SLACK_TARGETS.WORKSPACE_INTERNAL);
  const hlxConfigMessagePart = getHlxConfigMessagePart(hlxConfig);
  const announcementMessage = Message()
    .channel(channel)
    .blocks(
      Blocks.Section()
        .text(`A new site, *<${baseURL}|${baseURL}>*, has gone *live* on Edge Delivery Services and has been added to the Star Catalogue :rocket: (_source:_ *${source}*${hlxConfigMessagePart})`),
    )
    .buildToObject();
  return slackClient.postMessage(announcementMessage);
}

export default function approveSiteCandidate(lambdaContext) {
  const { dataAccess, log } = lambdaContext;
  const { KeyEvent, Site, SiteCandidate } = dataAccess;
  const { ORGANIZATION_ID_FRIENDS_FAMILY: friendsFamilyOrgId } = lambdaContext.env;
  const { DEFAULT_ORGANIZATION_ID: defaultOrgId } = lambdaContext.env;

  return async ({ ack, body, respond }) => {
    try {
      const { actions = [], message = {}, user } = body;
      const { blocks } = message;

      log.info(JSON.stringify(body));

      await ack(); // slack expects acknowledgement within 3s

      const baseURL = extractURLFromSlackMessage(blocks[0]?.text?.text);

      const siteCandidate = await SiteCandidate.findByBaseURL(baseURL);

      log.info(`Creating a new site: ${baseURL}`);

      const orgId = actions[0]?.text?.text === BUTTON_LABELS.APPROVE_FRIENDS_FAMILY
        && friendsFamilyOrgId;

      let site = await Site.findByBaseURL(siteCandidate.getBaseURL());

      // if site didn't exist before, then directly save it
      if (!site) {
        site = await Site.create({
          baseURL: siteCandidate.getBaseURL(),
          hlxConfig: siteCandidate.getHlxConfig(),
          isLive: true,
          ...(orgId
            ? { organizationId: friendsFamilyOrgId }
            : { organizationId: defaultOrgId }),
        });
      } else {
        // site might've been added before manually. In that case, make sure it is promoted to live
        // and set delivery type to aem_edge then update
        if (!site.getIsLive()) {
          site.toggleLive();
        }
        // make sure hlx config is set
        site.setHlxConfig(siteCandidate.getHlxConfig());
        site.setDeliveryType(DELIVERY_TYPES.AEM_EDGE);
        site = await site.save();
      }

      siteCandidate.setSiteId(site.getId());
      siteCandidate.setStatus(SITE_CANDIDATE_STATUS.APPROVED);
      siteCandidate.setUpdatedBy(user.username);

      await siteCandidate.save();

      await KeyEvent.create({
        name: 'Go Live',
        siteId: site.getId(),
        type: KEY_EVENT_TYPES.STATUS_CHANGE,
      });

      const reply = composeReply({
        blocks,
        username: user.username,
        orgId,
        approved: true,
      });

      log.info(`Responding site candidate approval with: ${JSON.stringify(reply)}`);

      await respond(reply);

      await announceSiteDiscovery(
        lambdaContext,
        baseURL,
        siteCandidate.getSource(),
        siteCandidate.getHlxConfig(),
      );
    } catch (e) {
      log.error('Error occurred while acknowledging site candidate approval', e);
      throw e;
    }
  };
}
