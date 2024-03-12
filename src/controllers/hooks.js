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

import wrap from '@adobe/helix-shared-wrap';
import { Message, Blocks, Elements } from 'slack-block-builder';
import { internalServerError, notFound, ok } from '@adobe/spacecat-shared-http-utils';
import { composeBaseURL, hasText } from '@adobe/spacecat-shared-utils';

import { BaseSlackClient, SLACK_TARGETS } from '@adobe/spacecat-shared-slack-client';
import { SITE_CANDIDATE_STATUS, SITE_CANDIDATE_SOURCES } from '@adobe/spacecat-shared-data-access/src/models/site-candidate.js';
import { fetch } from '../support/utils.js';

const CDN_HOOK_SECRET_NAME = 'INCOMING_WEBHOOK_SECRET_CDN';
const RUM_HOOK_SECRET_NAME = 'INCOMING_WEBHOOK_SECRET_RUM';

export const BUTTON_LABELS = {
  APPROVE_CUSTOMER: 'As Customer',
  APPROVE_FRIENDS_FAMILY: 'As Friends/Family',
  IGNORE: 'Ignore',
};

const IGNORED_DOMAINS = ['helix3.dev', 'fastly.net', 'ngrok-free.app', 'oastify.com', 'fastly-aem.page', 'findmy.media'];
const IGNORED_SUBDOMAIN_TOKENS = ['demo', 'dev', 'stag', 'qa', '--', 'sitemap', 'test', 'preview', 'cm-verify', 'owa', 'mail', 'ssl', 'secure', 'publish'];

class InvalidSiteCandidate extends Error {
  constructor(message, url) {
    super(message);
    this.url = url;
  }
}

function hookAuth(fn, opts) {
  return (context) => {
    const expectedSecret = context.env[opts.secretName];
    const secretFromPath = context.params?.hookSecret;
    return hasText(expectedSecret) && expectedSecret === secretFromPath
      ? fn(context)
      : notFound();
  };
}

function errorHandler(fn, opts) {
  const { type } = opts;
  return async (context) => {
    const { log } = context;
    try {
      return await fn(context);
    } catch (e) {
      if (e instanceof InvalidSiteCandidate) {
        log.warn(`Could not process site candidate. Reason: ${e.message}, Source: ${type}, Candidate: ${e.url}`);
        return ok(`${type} site candidate disregarded`);
      }
      log.error(`Unexpected error while processing the ${type} site candidate`, e);
      return internalServerError();
    }
  };
}

function isInvalidSubdomain(hostname) {
  const subdomain = hostname.split('.').slice(0, -2).join('.');
  return IGNORED_SUBDOMAIN_TOKENS.some((ignored) => subdomain.includes(ignored));
}

function isInvalidDomain(hostname) {
  return IGNORED_DOMAINS.some((ignored) => hostname.includes(ignored));
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
    throw new InvalidSiteCandidate(`Cannot fetch the candidate due to ${e.message}`, url);
  }

  finalUrl = finalUrl.endsWith('/') ? `${finalUrl}index.plain.html` : `${finalUrl}.plain.html`;
  let finalResp;

  try {
    // redirects are disabled because .plain.html should return 200
    finalResp = await fetch(finalUrl, { redirect: 'manual' });
  } catch (e) {
    throw new InvalidSiteCandidate('.plain.html is unreachable', finalUrl);
  }

  // reject if .plain.html does not return 2XX
  if (!finalResp.ok) {
    throw new InvalidSiteCandidate(`.plain.html does not return 2XX, returns ${finalResp.status}`, finalUrl);
  }

  const respText = await finalResp.text();

  // reject if .plain.html contains <head>
  if (respText.includes('<head>')) {
    throw new InvalidSiteCandidate('.plain.html should not contain <head>', finalUrl);
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
    throw new InvalidSiteCandidate('Path/search params are not accepted', url.href);
  }

  // disregard the IP addresses
  if (isIPAddress(url.hostname)) {
    throw new InvalidSiteCandidate('Hostname is an IP address', url.href);
  }

  // disregard the non-prod hostnames
  if (isInvalidSubdomain(url.hostname)) {
    throw new InvalidSiteCandidate('URL most likely contains a non-prod domain', url.href);
  }

  // disregard unwanted domains
  if (isInvalidDomain(url.hostname)) {
    throw new InvalidSiteCandidate('URL contains an unwanted domain', url.href);
  }
}

function buildSlackMessage(baseURL, source, channel) {
  return Message()
    .channel(channel)
    .blocks(
      Blocks.Section()
        .text(`I discovered a new site on Edge Delivery Services: *<${baseURL}|${baseURL}>*. Would you like me to include it in the Star Catalogue? (_source:_ *${source}*)`),
      Blocks.Actions()
        .elements(
          Elements.Button()
            .text(BUTTON_LABELS.APPROVE_CUSTOMER)
            .actionId('approveSiteCandidate')
            .primary(),
          Elements.Button()
            .text(BUTTON_LABELS.APPROVE_FRIENDS_FAMILY)
            .actionId('approveFriendsFamily')
            .primary(),
          Elements.Button()
            .text(BUTTON_LABELS.IGNORE)
            .actionId('ignoreSiteCandidate')
            .danger(),
        ),
    )
    .buildToObject();
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
      throw new InvalidSiteCandidate('Site candidate previously evaluated', baseURL);
    }

    if (await dataAccess.getSiteByBaseURL(siteCandidate.baseURL)) {
      throw new InvalidSiteCandidate('Site candidate already exists in sites db', baseURL);
    }

    await dataAccess.upsertSiteCandidate(siteCandidate);

    return baseURL;
  }

  async function sendDiscoveryMessage(baseURL, source) {
    const { SLACK_SITE_DISCOVERY_CHANNEL_INTERNAL: channel } = lambdaContext.env;
    const slackClient = BaseSlackClient.createFrom(lambdaContext, SLACK_TARGETS.WORKSPACE_INTERNAL);
    return slackClient.postMessage(buildSlackMessage(baseURL, source, channel));
  }

  async function processCDNHook(context) {
    const { log } = context;
    const { forwardedHost } = context.data;

    log.info(`Processing CDN site candidate. Input: ${forwardedHost}`);

    // extract the url from the x-forwarded-host header
    const domain = await extractDomainFromXForwardedHostHeader(forwardedHost);

    const source = SITE_CANDIDATE_SOURCES.CDN;
    const baseURL = await processSiteCandidate(domain, source);
    await sendDiscoveryMessage(baseURL, source);

    return ok('CDN site candidate is successfully processed');
  }

  async function processRUMHook(context) {
    const { log } = context;
    const { domain } = context.data;

    log.info(`Processing RUM site candidate. Input: ${domain}`);

    const source = SITE_CANDIDATE_SOURCES.RUM;
    const baseURL = await processSiteCandidate(domain, source);
    await sendDiscoveryMessage(baseURL, source);

    return ok('RUM site candidate is successfully processed');
  }

  return {
    processCDNHook: wrap(processCDNHook)
      .with(errorHandler, { type: 'CDN' })
      .with(hookAuth, { secretName: CDN_HOOK_SECRET_NAME }),
    processRUMHook: wrap(processRUMHook)
      .with(errorHandler, { type: 'RUM' })
      .with(hookAuth, { secretName: RUM_HOOK_SECRET_NAME }),
  };
}

export default HooksController;
