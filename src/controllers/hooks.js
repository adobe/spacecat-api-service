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
import { Blocks, Elements, Message } from 'slack-block-builder';
import {
  badRequest,
  internalServerError,
  notFound,
  ok,
} from '@adobe/spacecat-shared-http-utils';
import {
  composeBaseURL,
  deepEqual,
  hasText, isInteger,
  isNonEmptyObject,
  isObject,
} from '@adobe/spacecat-shared-utils';

import { BaseSlackClient, SLACK_TARGETS } from '@adobe/spacecat-shared-slack-client';
import {
  SITE_CANDIDATE_SOURCES,
  SITE_CANDIDATE_STATUS,
} from '@adobe/spacecat-shared-data-access/src/models/site-candidate.js';
import { DELIVERY_TYPES } from '@adobe/spacecat-shared-data-access/src/models/site.js';
import { fetch, isHelixSite } from '../support/utils.js';
import { getHlxConfigMessagePart } from '../utils/slack/base.js';

const CDN_HOOK_SECRET_NAME = 'INCOMING_WEBHOOK_SECRET_CDN';
const RUM_HOOK_SECRET_NAME = 'INCOMING_WEBHOOK_SECRET_RUM';

export const BUTTON_LABELS = {
  APPROVE_CUSTOMER: 'As Customer',
  APPROVE_FRIENDS_FAMILY: 'As Friends/Family',
  IGNORE: 'Ignore',
};

const IGNORED_DOMAINS = [/helix3.dev/, /fastly.net/, /ngrok-free.app/, /oastify.co/, /fastly-aem.page/, /findmy.media/, /impactful-[0-9]+\.site/, /shuyi-guan/, /adobevipthankyou/, /alshayauat/];
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
  return IGNORED_DOMAINS.some((ignored) => hostname.match(ignored));
}

function isIPAddress(hostname) {
  return /^\d{1,3}(\.\d{1,3}){3}$|^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/.test(hostname);
}

function containsPathOrSearchParams(url) {
  return url.pathname !== '/' || url.search !== '';
}

async function verifyHelixSite(url, hlxConfig = {}) {
  const { isHelix, reason } = await isHelixSite(url, hlxConfig);

  if (!isHelix) {
    throw new InvalidSiteCandidate(reason, url);
  }

  return true;
}

function parseHlxRSO(domain) {
  // This regex matches and captures domains of the form <ref>--<site>--<owner>.(hlx.live|aem.live)
  // ^([\w-]+)--([\w-]+)--([\w-]+)\.(hlx\.live|aem\.live)$
  // ^                  - asserts the position at the start of the string
  // ([\w-]+)           - captures one or more word characters
  //                      (alphanumeric and underscore) or hyphens as <ref>
  // --                 - matches the literal string "--"
  // ([\w-]+)           - captures one or more word characters or hyphens as <site>
  // --                 - matches the literal string "--"
  // ([\w-]+)           - captures one or more word characters or hyphens as <owner>
  // \.                 - matches the literal dot character
  // (hlx\.live|aem\.live) - captures either "hlx.live" or "aem.live" as the top-level domain
  // $                  - asserts the position at the end of the string
  const regex = /^([\w-]+)--([\w-]+)--([\w-]+)\.(hlx\.live|aem\.live)$/;
  const match = domain.match(regex);

  if (!match) {
    return null;
  }

  return {
    ref: match[1],
    site: match[2],
    owner: match[3],
    tld: match[4],
  };
}

/**
 * Fetches the edge config for the given site. If the config is not found, returns null.
 * @param {object} hlxConfig - The hlx config object
 * @param {number} hlxConfig.hlxVersion - The Helix Version
 * @param {object} hlxConfig.rso - The rso object
 * @param {string} hlxConfig.rso.owner - The owner of the site
 * @param {string} hlxConfig.rso.site - The site name
 * @param {string} [hlxConfig.rso.ref] - The ref of the site, if any
 * @param {string} [hlxConfig.rso.tld] - The tld of the site, if any
 * @param {string} hlxAdminToken - The hlx admin token
 * @param {object} log - The logger object
 * @param hlxAdminToken
 * @param log
 * @return {Promise<unknown>}
 */
async function fetchHlxConfig(hlxConfig, hlxAdminToken, log) {
  const { hlxVersion, rso } = hlxConfig;

  if (hlxVersion < 5) {
    log.info(`HLX version is ${hlxVersion}. Skipping fetching hlx config`);
    return null;
  }

  const { owner, site } = rso;
  const url = `https://admin.hlx.page/config/${owner}/aggregated/${site}.json`;

  log.info(`Fetching hlx config for ${owner}/${site} with url: ${url}`);

  try {
    const response = await fetch(url, {
      headers: { Authorization: `token ${hlxAdminToken}` },
    });

    if (response.status === 200) {
      log.info(`HLX config found for ${owner}/${site}`);
      return response.json();
    }

    if (response.status === 404) {
      log.info(`No hlx config found for ${owner}/${site}`);
      return null;
    }

    log.error(`Error fetching hlx config for ${owner}/${site}. Status: ${response.status}. Error: ${response.headers.get('x-error')}`);
  } catch (e) {
    log.error(`Error fetching hlx config for ${owner}/${site}`, e);
  }

  return null;
}

/**
 * Extracts the hlx config from the given list of domains.
 * @param {string[]} domains - The list of domains (as extracted from the x-forwarded-host header)
 * @param {number} hlxVersion - The Helix Version
 * @param {string} hlxAdminToken - The hlx admin token
 * @param {object} log - The logger object
 * @return {Promise<{cdn: object, code: object, content: object, hlxVersion: number, rso: {}}>}
 */
async function extractHlxConfig(domains, hlxVersion, hlxAdminToken, log) {
  const hlxConfig = {
    hlxVersion,
    rso: {},
  };

  for (const domain of domains.slice(1)) {
    const rso = parseHlxRSO(domain);
    if (isObject(rso)) {
      hlxConfig.rso = rso;
      log.info(`Parsed RSO: ${JSON.stringify(rso)} for domain: ${domain}`);
      // eslint-disable-next-line no-await-in-loop
      const config = await fetchHlxConfig(hlxConfig, hlxAdminToken, log);
      if (isObject(config)) {
        const { cdn, code, content } = config;
        hlxConfig.cdn = cdn;
        hlxConfig.code = code;
        hlxConfig.content = content;
        hlxConfig.hlxVersion = 5;
        log.info(`HLX config found for ${rso.owner}/${rso.site}: ${JSON.stringify(config)}`);
      }
      break;
    }
  }

  return hlxConfig;
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

function buildSlackMessage(baseURL, source, hlxConfig, channel) {
  const hlxConfigMessagePart = getHlxConfigMessagePart(source, hlxConfig);
  return Message()
    .channel(channel)
    .blocks(
      Blocks.Section()
        .text(`I discovered a new site on Edge Delivery Services: *<${baseURL}|${baseURL}>*. Would you like me to include it in the Star Catalogue? (_source:_ *${source}*${hlxConfigMessagePart})`),
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

  async function processSiteCandidate(domain, source, log, hlxConfig = {}) {
    const baseURL = composeBaseURL(domain);
    verifyURLCandidate(baseURL);
    await verifyHelixSite(baseURL, hlxConfig);

    const siteCandidate = {
      baseURL,
      source,
      status: SITE_CANDIDATE_STATUS.PENDING,
      hlxConfig,
    };

    const site = await dataAccess.getSiteByBaseURL(siteCandidate.baseURL);

    // discard the site candidate if the site exists in sites db with deliveryType=aem_edge
    if (site && site.getDeliveryType() === DELIVERY_TYPES.AEM_EDGE) {
      // for existing site with empty hlxConfig or non-equal hlxConfig, update it now
      // todo: remove after back fill of hlx config for existing sites is complete
      if (source === SITE_CANDIDATE_SOURCES.CDN && isNonEmptyObject(hlxConfig)) {
        const siteHlxConfig = site.getHlxConfig();
        const siteHasHlxConfig = isNonEmptyObject(siteHlxConfig);
        const candidateHlxConfig = siteCandidate.hlxConfig;
        const hlxConfigChanged = !deepEqual(siteHlxConfig, candidateHlxConfig);

        if (hlxConfigChanged) {
          site.updateHlxConfig(siteCandidate.hlxConfig);
          await dataAccess.updateSite(site);

          const action = siteHasHlxConfig && hlxConfigChanged ? 'updated' : 'added';
          log.info(`HLX config ${action} for existing site: *<${baseURL}|${baseURL}>*${getHlxConfigMessagePart(SITE_CANDIDATE_SOURCES.CDN, hlxConfig)}`);
        }
      }
      throw new InvalidSiteCandidate('Site candidate already exists in sites db', baseURL);
    }

    // discard the site candidate if previously evaluated
    if (!site && (await dataAccess.siteCandidateExists(siteCandidate.baseURL))) {
      throw new InvalidSiteCandidate('Site candidate previously evaluated', baseURL);
    }

    await dataAccess.upsertSiteCandidate(siteCandidate);

    return baseURL;
  }

  async function sendDiscoveryMessage(baseURL, source, hlxConfig = {}) {
    const { SLACK_SITE_DISCOVERY_CHANNEL_INTERNAL: channel } = lambdaContext.env;
    const slackClient = BaseSlackClient.createFrom(lambdaContext, SLACK_TARGETS.WORKSPACE_INTERNAL);
    return slackClient.postMessage(buildSlackMessage(baseURL, source, hlxConfig, channel));
  }

  async function processCDNHook(context) {
    const { log } = context;

    log.info(`Processing CDN site candidate. Input: ${JSON.stringify(context.data)}`);

    // eslint-disable-next-line camelcase,no-unused-vars
    const { hlxVersion, requestPath, requestXForwardedHost } = context.data;

    if (!isInteger(hlxVersion)) {
      log.warn('HLX version is not an integer. Skipping processing CDN site candidate');
      return badRequest('HLX version is not an integer');
    }

    if (!hasText(requestXForwardedHost)) {
      log.warn('X-Forwarded-Host header is missing. Skipping processing CDN site candidate');
      return badRequest('X-Forwarded-Host header is missing');
    }

    const { HLX_ADMIN_TOKEN: hlxAdminToken } = context.env;
    const domains = requestXForwardedHost.split(',').map((domain) => domain.trim());
    const primaryDomain = domains[0];

    // extract the url from the x-forwarded-host header and determine hlx config
    const hlxConfig = await extractHlxConfig(domains, hlxVersion, hlxAdminToken, log);

    const domain = hlxConfig.cdn?.prod?.host || primaryDomain;
    const source = SITE_CANDIDATE_SOURCES.CDN;
    const baseURL = await processSiteCandidate(domain, source, log, hlxConfig);
    await sendDiscoveryMessage(baseURL, source, hlxConfig);

    return ok('CDN site candidate is successfully processed');
  }

  async function processRUMHook(context) {
    const { log } = context;
    const { domain } = context.data;

    log.info(`Processing RUM site candidate. Input: ${JSON.stringify(context.data)}`);

    const source = SITE_CANDIDATE_SOURCES.RUM;
    const baseURL = await processSiteCandidate(domain, source, log);
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
