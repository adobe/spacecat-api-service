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
  badRequest, internalServerError, notFound, ok,
} from '@adobe/spacecat-shared-http-utils';
import {
  composeBaseURL, deepEqual, hasText, isInteger, isNonEmptyObject, isObject, isValidUrl,
} from '@adobe/spacecat-shared-utils';
import yaml from 'js-yaml';

import { BaseSlackClient, SLACK_TARGETS } from '@adobe/spacecat-shared-slack-client';
import { Site as SiteModel, SiteCandidate as SiteCandidateModel } from '@adobe/spacecat-shared-data-access';
import { fetch, isHelixSite } from '../support/utils.js';
import { getHlxConfigMessagePart } from '../utils/slack/base.js';

const CDN_HOOK_SECRET_NAME = 'INCOMING_WEBHOOK_SECRET_CDN';

export const BUTTON_LABELS = {
  APPROVE_CUSTOMER: 'As Customer',
  APPROVE_FRIENDS_FAMILY: 'As Friends/Family',
  IGNORE: 'Ignore',
};

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
        log.info(`Could not process site candidate. Reason: ${e.message}, Source: ${type}, Candidate: ${e.url}`);
        return ok(`${type} site candidate disregarded`);
      }
      log.error(`Unexpected error while processing the ${type} site candidate`, e);
      return internalServerError();
    }
  };
}

function isInvalidSubdomain(config, hostname) {
  const subdomain = hostname.split('.').slice(0, -2).join('.');
  return config.ignoredSubdomainTokens.some((ignored) => subdomain.includes(ignored));
}

function isInvalidDomain(config, hostname) {
  return config.ignoredDomains.some((ignored) => hostname.match(ignored));
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

async function getContentSource(hlxConfig, log) {
  const { ref, site: repo, owner } = hlxConfig.rso;

  const fstabResponse = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/fstab.yaml`);

  if (fstabResponse.status !== 200) {
    log.info(`Error fetching fstab.yaml for ${owner}/${repo}. Status: ${fstabResponse.status}`);
    return null;
  }

  const fstabContent = await fstabResponse.text();
  const parsedContent = yaml.load(fstabContent);

  const url = parsedContent?.mountpoints
    ? Object.entries(parsedContent.mountpoints)?.[0]?.[1]
    : null;

  if (!isValidUrl(url)) {
    log.info(`No content source found for ${owner}/${repo} in fstab.yaml`);
    return null;
  }

  const type = url.includes('drive.google') ? 'drive.google' : 'onedrive';
  return { source: { type, url } };
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
      } else {
        try {
          // eslint-disable-next-line no-await-in-loop
          const content = await getContentSource(hlxConfig, log);
          if (isObject(content)) {
            hlxConfig.content = content;
          }
        } catch (e) {
          log.error(`Error fetching fstab.yaml for ${rso.owner}/${rso.site}. Error: ${e.message}`);
        }
      }
      break;
    }
  }

  return hlxConfig;
}

function verifyURLCandidate(config, baseURL) {
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
  if (isInvalidSubdomain(config, url.hostname)) {
    throw new InvalidSiteCandidate('URL most likely contains a non-prod domain', url.href);
  }

  // disregard unwanted domains
  if (isInvalidDomain(config, url.hostname)) {
    throw new InvalidSiteCandidate('URL contains an unwanted domain', url.href);
  }
}

function buildSlackMessage(baseURL, source, hlxConfig, channel) {
  const hlxConfigMessagePart = getHlxConfigMessagePart(hlxConfig);
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

const getConfigFromContext = (lambdaContext) => {
  const {
    env: {
      HLX_ADMIN_TOKEN: hlxAdminToken,
      SITE_DETECTION_IGNORED_DOMAINS: ignoredDomains = '',
      SITE_DETECTION_IGNORED_SUBDOMAIN_TOKENS: ignoredSubdomainTokens = '',
      SLACK_SITE_DISCOVERY_CHANNEL_INTERNAL: channel,
    },
  } = lambdaContext;

  return {
    channel,
    hlxAdminToken,
    ignoredDomains: ignoredDomains.split(',')
      .map((domain) => {
        const trimmedDomain = domain.trim();
        const regexBody = trimmedDomain.startsWith('/') && trimmedDomain.endsWith('/') ? trimmedDomain.slice(1, -1) : trimmedDomain;
        return new RegExp(regexBody);
      }),
    ignoredSubdomainTokens: ignoredSubdomainTokens.split(',')
      .map((token) => token.trim()),
  };
};

/**
 * Hooks controller. Provides methods to process incoming webhooks.
 * @returns {object} Hooks controller.
 * @constructor
 */
function HooksController(lambdaContext) {
  const { dataAccess } = lambdaContext;
  const { Site, SiteCandidate } = dataAccess;
  const config = getConfigFromContext(lambdaContext);

  async function processSiteCandidate(domain, source, log, overrideHelixCheck, hlxConfig = {}) {
    const baseURL = composeBaseURL(domain);
    verifyURLCandidate(config, baseURL);
    if (!overrideHelixCheck) {
      await verifyHelixSite(baseURL, hlxConfig);
    }

    const siteCandidate = {
      baseURL,
      source,
      status: SiteCandidateModel.SITE_CANDIDATE_STATUS.PENDING,
      hlxConfig,
    };

    const site = await Site.findByBaseURL(siteCandidate.baseURL);

    // discard the site candidate if the site exists in sites db with deliveryType=aem_edge
    if (site && site.getDeliveryType() === SiteModel.DELIVERY_TYPES.AEM_EDGE) {
      // for existing site with empty hlxConfig or non-equal hlxConfig, update it now
      // todo: remove after back fill of hlx config for existing sites is complete
      if (source === SiteCandidateModel.SITE_CANDIDATE_SOURCES.CDN && isNonEmptyObject(hlxConfig)) {
        const siteHlxConfig = site.getHlxConfig();
        const siteHasHlxConfig = isNonEmptyObject(siteHlxConfig);
        const candidateHlxConfig = siteCandidate.hlxConfig;
        const hlxConfigChanged = !deepEqual(siteHlxConfig, candidateHlxConfig);

        if (hlxConfigChanged) {
          site.setHlxConfig(siteCandidate.hlxConfig);
          await site.save();

          const action = siteHasHlxConfig && hlxConfigChanged ? 'updated' : 'added';
          log.info(`HLX config ${action} for existing site: *<${baseURL}|${baseURL}>*${getHlxConfigMessagePart(hlxConfig)}`);
        }
      }
      throw new InvalidSiteCandidate('Site candidate already exists in sites db', baseURL);
    }

    // discard the site candidate if previously evaluated
    const isPreviouslyEvaluated = await SiteCandidate.findByBaseURL(siteCandidate.baseURL);
    if (isPreviouslyEvaluated !== null) {
      throw new InvalidSiteCandidate('Site candidate previously evaluated', baseURL);
    }

    await SiteCandidate.create(siteCandidate);

    return baseURL;
  }

  async function sendDiscoveryMessage(baseURL, source, hlxConfig = {}) {
    const slackClient = BaseSlackClient.createFrom(lambdaContext, SLACK_TARGETS.WORKSPACE_INTERNAL);
    return slackClient.postMessage(buildSlackMessage(baseURL, source, hlxConfig, config.channel));
  }

  async function processCDNHook(context) {
    const { log } = context;

    log.info(`Processing CDN site candidate. Input: ${JSON.stringify(context.data)}`);

    const {
      // eslint-disable-next-line camelcase,no-unused-vars
      hlxVersion, requestPath, requestXForwardedHost, overrideHelixCheck,
    } = context.data;

    if (!isInteger(hlxVersion)) {
      log.warn('HLX version is not an integer. Skipping processing CDN site candidate');
      return badRequest('HLX version is not an integer');
    }

    if (!hasText(requestXForwardedHost)) {
      log.warn('X-Forwarded-Host header is missing. Skipping processing CDN site candidate');
      return badRequest('X-Forwarded-Host header is missing');
    }

    const domains = requestXForwardedHost.split(',').map((domain) => domain.trim());
    const primaryDomain = domains[0];

    // extract the url from the x-forwarded-host header and determine hlx config
    const hlxConfig = await extractHlxConfig(domains, hlxVersion, config.hlxAdminToken, log);

    const domain = hlxConfig.cdn?.prod?.host || primaryDomain;
    const source = SiteCandidateModel.SITE_CANDIDATE_SOURCES.CDN;
    const baseURL = await processSiteCandidate(domain, source, log, overrideHelixCheck, hlxConfig);
    await sendDiscoveryMessage(baseURL, source, hlxConfig);

    return ok('CDN site candidate is successfully processed');
  }

  return {
    processCDNHook: wrap(processCDNHook)
      .with(errorHandler, { type: 'CDN' })
      .with(hookAuth, { secretName: CDN_HOOK_SECRET_NAME }),
  };
}

export default HooksController;
