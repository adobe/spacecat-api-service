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

import {
  KeyEvent as KeyEventModel,
  Site as SiteModel,
  SiteCandidate as SiteCandidateModel,
} from '@adobe/spacecat-shared-data-access';
import { BaseSlackClient, SLACK_TARGETS } from '@adobe/spacecat-shared-slack-client';
import { Blocks, Elements, Message } from 'slack-block-builder';
import { hasText } from '@adobe/spacecat-shared-utils';
import { BUTTON_LABELS } from '../../../controllers/hooks.js';
import { composeReply, extractURLFromSlackMessage } from './commons.js';
import { getHlxConfigMessagePart } from '../../../utils/slack/base.js';

const POLLING_NUM_RETRIES = 10;
const POLLING_INTERVAL = 60 * 5 * 1000; // 5 minutes

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
  const {
    ORGANIZATION_ID_FRIENDS_FAMILY: friendsFamilyOrgId,
    MYSTIQUE_API_BASE_URL: mystiqueApiBaseUrl,
    DEFAULT_ORGANIZATION_ID: defaultOrgId,
  } = lambdaContext.env;

  return async ({ ack, body, respond }) => {
    try {
      const {
        actions = [], channel, message = {}, user,
      } = body;
      const { blocks, ts: threadTs } = message;

      log.info(JSON.stringify(body));

      await ack(); // slack expects acknowledgement within 3s

      const baseURL = extractURLFromSlackMessage(blocks[0]?.text?.text);

      const siteCandidate = await SiteCandidate.findByBaseURL(baseURL);

      log.info(`Creating a new site: ${baseURL}`);

      const isFnF = actions[0]?.text?.text === BUTTON_LABELS.APPROVE_FRIENDS_FAMILY;

      let site = await Site.findByBaseURL(siteCandidate.getBaseURL());

      // if site didn't exist before, then directly save it
      if (!site) {
        site = await Site.create({
          baseURL: siteCandidate.getBaseURL(),
          hlxConfig: siteCandidate.getHlxConfig(),
          isLive: true,
          ...(isFnF
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
        site.setDeliveryType(SiteModel.DELIVERY_TYPES.AEM_EDGE);
        site = await site.save();
      }

      siteCandidate.setSiteId(site.getId());
      siteCandidate.setStatus(SiteCandidateModel.SITE_CANDIDATE_STATUS.APPROVED);
      siteCandidate.setUpdatedBy(user.username);

      await siteCandidate.save();

      await KeyEvent.create({
        name: 'Go Live',
        siteId: site.getId(),
        type: KeyEventModel.KEY_EVENT_TYPES.STATUS_CHANGE,
      });

      const reply = composeReply({
        blocks,
        username: user.username,
        isFnF,
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

      if (!isFnF) {
        // Start the Org Detector Agent in Mystique
        const startResponse = await fetch(`${mystiqueApiBaseUrl}/v1/org-detector`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            domain: siteCandidate.getBaseURL().replace('https://', ''),
            githubLogin: siteCandidate.getHlxConfig()?.rso?.owner,
            ignoredGithubOrgs: lambdaContext.env.IGNORED_GITHUB_ORGS,
          }),
        });
        if (!startResponse.ok) throw new Error(`Failed to start OrgDetectorAgent: ${startResponse.statusText}`);
        const startData = await startResponse.json();

        if (!startData || !startData.uuid) throw new Error('Invalid response from OrgDetectorAgent start');
        const jobId = startData.uuid;

        // Poll the mystique API to check the status of the Org Detector Agent job
        /* eslint-disable no-await-in-loop */
        const org = await (async function doPolling() {
          let result = null;
          let polling = true;
          let retryCount = 0;

          while (polling && retryCount < POLLING_NUM_RETRIES) {
            // Errors are handled by the outer try-catch block
            let response;

            if (polling) {
              response = await fetch(`${mystiqueApiBaseUrl}/v1/org-detector/${jobId}`, {
                method: 'GET',
                headers: { 'Content-Type': 'application/json' },
              });
            }

            if (polling && response.ok) {
              const { status, matchedCompany = null } = await response.json();

              polling = status !== 'completed';
              result = matchedCompany;
            }

            retryCount += 1;

            if (polling && retryCount < POLLING_NUM_RETRIES) {
              await new Promise((resolve) => {
                setTimeout(resolve, POLLING_INTERVAL);
              });
            } else if (polling && retryCount >= POLLING_NUM_RETRIES) {
              throw new Error(`Polling for OrgDetectorAgent job ${jobId} exceeded maximum retries (${POLLING_NUM_RETRIES})`);
            }
          }

          return result;
        }());
        /* eslint-enable no-await-in-loop */

        log.info(`Detected org: ${JSON.stringify(org)}`);

        if (hasText(org?.name) && hasText(org?.imsOrgId)) {
          const { name, imsOrgId } = org;

          const orgMsg = Message()
            .channel(channel.id)
            .threadTs(threadTs)
            .blocks(
              Blocks.Section()
                .text(`:agent_smith: Detected IMS organization \`${name}\` with IMS org ID \`${imsOrgId}\` for *<${baseURL}|${baseURL}>*`),
              Blocks.Section()
                .text(`Would you approve? @${user.username}`),
              Blocks.Actions()
                .elements(
                  Elements.Button()
                    .text('Yes')
                    .actionId('approveOrg')
                    .primary(),
                  Elements.Button()
                    .text('No')
                    .actionId('rejectOrg')
                    .danger(),
                ),
            )
            .buildToObject();

          const slackClient = BaseSlackClient.createFrom(
            lambdaContext,
            SLACK_TARGETS.WORKSPACE_INTERNAL,
          );
          await slackClient.postMessage(orgMsg);
        }
      }
    } catch (e) {
      log.error('Error occurred while acknowledging site candidate approval', e);
      throw e;
    }
  };
}
