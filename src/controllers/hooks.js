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

import { Message, Blocks, Elements } from 'slack-block-builder';
import wrap from '@adobe/helix-shared-wrap';
import { notFound, ok } from '@adobe/spacecat-shared-http-utils';

import { BaseSlackClient, SLACK_TARGETS } from '@adobe/spacecat-shared-slack-client';
import { SITE_CANDIDATE_STATUS, SITE_CANDIDATE_SOURCES } from '@adobe/spacecat-shared-data-access/src/models/site-candidate.js';

const CDN_HOOK_SECRET = 'INCOMING_WEBHOOK_SECRET_CDN';
// const RUM_HOOK_SECRET = 'INCOMING_WEBHOOK_SECRET_RUM';

function isIPAddress(hostname) {
  return /^\d{1,3}(\.\d{1,3}){3}$|^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/.test(hostname);
}

function verifySecret(fn, opts) {
  return (context) => {
    const expectedSecret = context.env[opts.secret];
    const secretFromPath = context.params?.hookSecret;
    return expectedSecret === secretFromPath
      ? fn(context)
      : notFound();
  };
}

function getBaseURLFromXForwardedHostHeader(forwardedHost) {
  const domain = forwardedHost.split(',')[0]?.trim();
  domain.replace(/:(\d{1,5})$/, ''); // replace the port at the end
  const baseURL = domain.startsWith('https://') ? domain : `https://${domain}`;
  const url = new URL(baseURL);

  if (isIPAddress(url.hostname)) {
    throw Error('we dont accept ip addresses');
  }

  return url.href; // sneakily check if a valid URL
}

/**
 * Hooks controller. Provides methods to process incoming webhooks.
 * @returns {object} Hooks controller.
 * @constructor
 */
function HooksController() {
  async function processCDNHook(context) {
    const { dataAccess, log } = context;
    const { forwardedHost } = context.data;
    const { SLACK_REPORT_CHANNEL_INTERNAL: channel } = context.env;

    let baseURL;
    try {
      baseURL = getBaseURLFromXForwardedHostHeader(forwardedHost);
    } catch (e) {
      log.warn('Forwarded host does not contain a valid', e);
      return ok('you sure this is valid?');
    }

    if (await dataAccess.siteCandidateExists(baseURL)) {
      return ok('already exists');
    }

    await dataAccess.upsertSiteCandidate({
      baseURL,
      source: SITE_CANDIDATE_SOURCES.CDN,
      status: SITE_CANDIDATE_STATUS.PENDING,
    });

    const slackClient = BaseSlackClient.createFrom(context, SLACK_TARGETS.WORKSPACE_INTERNAL);

    const discoveryMessage = Message()
      .channel(channel)
      .blocks(
        Blocks.Section().text(`I discovered a new site: *<${baseURL}|${baseURL}>*. Would you like me to include it in the Star Catalogue?`),
        Blocks.Actions()
          .elements(
            Elements.Button()
              .text('Yes')
              .actionId('approveSiteCandidate')
              .primary(),
            Elements.Button()
              .text('Ignore')
              .actionId('ignoreSiteCandidate')
              .danger(),
          ),
      )
      .buildToObject();

    await slackClient.postMessage({
      ...discoveryMessage,
      unfurl_links: true,
    });

    log.info(`Processed site candidate ${baseURL} successfully.`);
    return ok('processed yo!');
  }

  return {
    processCDNHook: wrap(processCDNHook)
      .with(verifySecret, { secret: CDN_HOOK_SECRET }),
  };
}

export default HooksController;
