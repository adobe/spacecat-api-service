/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { Config } from '@adobe/spacecat-shared-data-access/src/models/site/config.js';
import TokowakaClient from '@adobe/spacecat-shared-tokowaka-client';
import BaseCommand from './base.js';
import {
  extractURLFromSlackInput,
  postErrorMessage,
  postSiteNotFoundMessage,
} from '../../../utils/slack/base.js';

const PHRASES = ['add-oae-stage-domain'];

/**
 * Factory function to create the AddOaeStageDomainCommand object.
 *
 * Onboards a customer's stage domain(s) for Optimize at Edge (OAE) testing against
 * a given production site. Unlike the REST API equivalent, this command does not
 * require the staging domain to share the same registered domain as the production
 * site — intended for internal Adobe use via Slack only.
 *
 * @param {Object} context - The context object.
 * @returns {Object} The AddOaeStageDomainCommand object.
 */
function AddOaeStageDomainCommand(context) {
  const baseCommand = BaseCommand({
    id: 'add-oae-stage-domain',
    name: 'Add OAE Stage Domain',
    description: 'Onboards a customer\'s stage domain(s) for Optimize at Edge testing. Unlike the API, cross-domain staging is allowed.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} <prod-site-url-or-id> <stage-domain1>[,stage-domain2,...]`,
  });

  const { dataAccess, log } = context;
  const { Site } = dataAccess;

  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;

    const [siteInput, domainsArg, ...extraArgs] = args;

    if (!siteInput || !domainsArg) {
      await say(baseCommand.usage());
      return;
    }

    if (extraArgs.length > 0) {
      await say(`:warning: Too many arguments. Use comma-separated domains, not spaces.\n${baseCommand.usage()}`);
      return;
    }

    const stagingDomains = domainsArg.split(',').map((d) => d.trim()).filter(Boolean);
    if (stagingDomains.length === 0) {
      await say(':warning: Please provide at least one staging domain.');
      return;
    }

    // Validate all stage domain strings upfront before any DB or Tokowaka calls,
    // so a bad entry cannot leave provisioning in a partial state.
    const domainEntries = [];
    const invalidDomains = [];
    for (const domain of stagingDomains) {
      const stageBaseURL = extractURLFromSlackInput(domain);
      if (!stageBaseURL) {
        invalidDomains.push(domain);
      } else {
        domainEntries.push({ domain, stageBaseURL });
      }
    }
    if (invalidDomains.length > 0) {
      await say(`:warning: Invalid domain(s): ${invalidDomains.map((d) => `\`${d}\``).join(', ')}. Please provide valid domain names separated by commas.`);
      return;
    }

    try {
      const baseURL = extractURLFromSlackInput(siteInput);
      const site = baseURL
        ? await Site.findByBaseURL(baseURL)
        : await Site.findById(siteInput);

      if (!site) {
        await postSiteNotFoundMessage(say, siteInput);
        return;
      }

      const tokowakaClient = TokowakaClient.createFrom(context);
      const organizationId = site.getOrganizationId();
      const lastModifiedBy = 'slack-add-oae-stage-domain';
      const newEntries = [];
      const stageConfigs = [];

      /* eslint-disable no-await-in-loop */
      for (const { domain, stageBaseURL } of domainEntries) {
        let stageSite = await Site.findByBaseURL(stageBaseURL);
        if (!stageSite) {
          stageSite = await Site.create({
            baseURL: stageBaseURL,
            organizationId,
          });
        } else if (stageSite.getOrganizationId() !== organizationId) {
          throw new Error(`Stage domain \`${domain}\` already belongs to a different organization.`);
        }

        let metaconfig = await tokowakaClient.fetchMetaconfig(stageBaseURL);
        if (!metaconfig || !Array.isArray(metaconfig?.apiKeys) || metaconfig.apiKeys.length === 0) {
          metaconfig = await tokowakaClient.createMetaconfig(
            stageBaseURL,
            stageSite.getId(),
            { tokowakaEnabled: true },
            { lastModifiedBy, isStageDomain: true },
          );
          if (!metaconfig?.apiKeys?.length) {
            throw new Error(`Failed to provision API key for stage domain \`${domain}\`: createMetaconfig returned no API keys.`);
          }
        } else {
          await tokowakaClient.updateMetaconfig(
            stageBaseURL,
            stageSite.getId(),
            {},
            { lastModifiedBy, isStageDomain: true },
          );
          metaconfig = await tokowakaClient.fetchMetaconfig(stageBaseURL);
        }

        newEntries.push({ domain, id: stageSite.getId() });
        stageConfigs.push({ domain, ...metaconfig });
      }
      /* eslint-enable no-await-in-loop */

      const currentConfig = site.getConfig();
      const existingEdgeConfig = currentConfig.getEdgeOptimizeConfig() || {};
      const existingList = existingEdgeConfig.stagingDomains || [];
      const byDomain = new Map(existingList.map((e) => [e.domain, e]));
      for (const entry of newEntries) {
        byDomain.set(entry.domain, { domain: entry.domain, id: entry.id });
      }
      const mergedStagingDomains = [...byDomain.values()];

      currentConfig.updateEdgeOptimizeConfig({
        ...existingEdgeConfig,
        stagingDomains: mergedStagingDomains,
      });
      site.setConfig(Config.toDynamoItem(currentConfig));
      await site.save();

      const domainList = stageConfigs.map((c) => `• \`${c.domain}\``).join('\n');
      await say(`:white_check_mark: Successfully onboarded ${stageConfigs.length} stage domain(s) for *${site.getBaseURL()}*:\n${domainList}`);
      log.info(`add-oae-stage-domain: completed by Slack user ${slackContext.user}`);
    } catch (error) {
      log.error('Error in add-oae-stage-domain:', error);
      await postErrorMessage(say, error);
    }
  };

  baseCommand.init(context);
  return { ...baseCommand, handleExecution };
}

export default AddOaeStageDomainCommand;
