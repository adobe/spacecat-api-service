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
import { notFound, ok } from '@adobe/spacecat-shared-http-utils';
import { composeBaseURL } from '@adobe/spacecat-shared-utils';

import { BaseSlackClient, SLACK_TARGETS } from '@adobe/spacecat-shared-slack-client';
import { SITE_CANDIDATE_STATUS, SITE_CANDIDATE_SOURCES } from '@adobe/spacecat-shared-data-access/src/models/site-candidate.js';
import { fetch } from '../support/utils.js';

const CDN_HOOK_SECRET_NAME = 'INCOMING_WEBHOOK_SECRET_CDN';
const RUM_HOOK_SECRET_NAME = 'INCOMING_WEBHOOK_SECRET_RUM';

const IGNORED_SUBDOMAIN_TOKENS = ['demo', 'dev', 'stag', 'qa', '--'];

function verifyHookSecret(context, secretName) {
  const expectedSecret = context.env[secretName];
  const secretFromPath = context.params?.hookSecret;
  return expectedSecret !== secretFromPath;
}

function isInvalidSubdomain(hostname) {
  const subdomain = hostname.split('.').slice(0, -2).join('.');
  return IGNORED_SUBDOMAIN_TOKENS.some((ignored) => subdomain.includes(ignored));
}

function isIPAddress(hostname) {
  return /^\d{1,3}(\.\d{1,3}){3}$|^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/.test(hostname);
}

function containsPathOrSearchParams(url) {
  return url.pathname !== '/' || url.search !== '';
}

async function verifyHelixSite(url) {
  let finalUrl;
  try {
    const resp = await fetch(url);
    finalUrl = resp.url;
  } catch (e) {
    throw Error(`URL is unreachable: ${url}`, { cause: e });
  }

  finalUrl = finalUrl.endsWith('/') ? `${finalUrl}index.plain.html` : `${finalUrl}.plain.html`;
  let finalResp;

  try {
    finalResp = await fetch(finalUrl);
  } catch (e) {
    throw Error(`.plain.html is unreachable for ${finalUrl}`, { cause: e });
  }

  if (!finalResp.ok) {
    throw Error(`.plain.html does not exist for ${finalUrl}`);
  }
  return true;
}

async function extractDomainFromXForwardedHostHeader(forwardedHost) {
  return forwardedHost.split(',')[0]?.trim(); // get the domain from x-fw-host header
}

function verifyURLCandidate(baseURL) {
  const url = new URL(baseURL);

  // x-fw-host header should contain hostname only. If it contains path and/or search
  // params, then it's most likely a h4ck attempt
  if (containsPathOrSearchParams(url)) {
    throw Error(`Path/search params are not accepted: ${url.href}/${url.search}`);
  }

  // disregard the IP addresses
  if (isIPAddress(url.hostname)) {
    throw Error('Hostname is an IP address');
  }

  // disregard the non-prod hostnames
  if (isInvalidSubdomain(url.hostname)) {
    throw Error(`URL most likely contains a non-prod domain: ${url.href}`);
  }
}

function buildSlackMessage(baseURL, source, channel) {
  const discoveryMessage = Message()
    .channel(channel)
    .blocks(
      Blocks.Section()
        .text(`I discovered a new site on Edge Delivery Services: *<${baseURL}|${baseURL}>*. Would you like me to include it in the Star Catalogue? (_source:_ *${source}*)`),
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

  return {
    ...discoveryMessage,
    unfurl_links: true, // TODO: change once this PR is merged: https://github.com/raycharius/slack-block-builder/pull/130
    unfurl_media: true,
  };
}

/**
 * Hooks controller. Provides methods to process incoming webhooks.
 * @returns {object} Hooks controller.
 * @constructor
 */
function HooksController(lambdaContext) {
  const { dataAccess } = lambdaContext;

  async function processSiteCandidate(domain, source) {
    const baseURL = composeBaseURL(domain);
    verifyURLCandidate(baseURL);
    await verifyHelixSite(baseURL);

    const siteCandidate = {
      baseURL,
      source,
      status: SITE_CANDIDATE_STATUS.PENDING,
    };

    if (await dataAccess.siteCandidateExists(siteCandidate.baseURL)) {
      throw Error('Site candidate previously evaluated');
    }

    await dataAccess.upsertSiteCandidate(siteCandidate);

    if (await dataAccess.getSiteByBaseURL(siteCandidate.baseURL)) {
      throw Error('Site candidate already exists in sites db');
    }

    return baseURL;
  }

  async function sendDiscoveryMessage(baseURL, source) {
    const { SLACK_REPORT_CHANNEL_INTERNAL: channel } = lambdaContext.env;
    const slackClient = BaseSlackClient.createFrom(lambdaContext, SLACK_TARGETS.WORKSPACE_INTERNAL);
    return slackClient.postMessage(buildSlackMessage(baseURL, source, channel));
  }

  async function processCDNHook(context) {
    if (verifyHookSecret(context, CDN_HOOK_SECRET_NAME)) notFound();

    const { log } = context;
    const { forwardedHost } = context.data;

    try {
      // extract the url from the x-forwarded-host header
      const domain = await extractDomainFromXForwardedHostHeader(forwardedHost);
      const source = SITE_CANDIDATE_SOURCES.CDN;

      const baseURL = await processSiteCandidate(domain, source);

      const resp = await sendDiscoveryMessage(baseURL, source);
      log.info(JSON.stringify(resp));

      return ok('CDN site candidate is successfully processed');
    } catch (e) {
      log.warn('Could not process the CDN site candidate', e);
      return ok('CDN site candidate disregarded'); // webhook should return success
    }
  }

  async function processRUMHook(context) {
    if (verifyHookSecret(context, RUM_HOOK_SECRET_NAME)) notFound();

    const { log } = context;
    const { domain } = context.data;

    try {
      const source = SITE_CANDIDATE_SOURCES.RUM;

      const baseURL = await processSiteCandidate(domain, source);

      await sendDiscoveryMessage(baseURL, source);

      return ok('RUM site candidate is successfully processed');
    } catch (e) {
      log.warn('Could not process the RUM site candidate', e);
      return ok('RUM site candidate disregarded'); // webhook should return success
    }
  }

  return {
    processCDNHook,
    processRUMHook,
  };
}

export default HooksController;
