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
/* c8 ignore start */
import { llmoConfig as llmo } from '@adobe/spacecat-shared-utils';
import { postErrorMessage, sendFile } from '../../../utils/slack/base.js';

import BaseCommand from './base.js';

import { createObjectCsvStringifier } from '../../../utils/slack/csvHelper.cjs';

const { readConfig } = llmo;
const PHRASES = ['get-prompt-usage'];

/**
 * Factory function to create the GetPromptUsage object.
 *
 * @param {Object} context - The context object.
 * @returns {GetPromptUsageCommand} - The GetPromptUsageCommand object.
 * @constructor
 */
function GetPromptUsageCommand(context) {
  const baseCommand = BaseCommand({
    id: 'get-prompt-usage',
    name: 'Get Prompt Usage',
    description:
      'Retrieves the total number of prompts for a given IMS org ID (or multiple IMS org IDs)',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {imsOrgID}`,
  });

  const { dataAccess, log, s3 } = context;
  const { Organization, Entitlement, Site } = dataAccess;

  const getLlmoConfig = async (siteId) => {
    if (!s3 || !s3.s3Client) {
      throw new Error(
        'LLMO config storage is not configured for this environment',
      );
    }

    const { config, exists } = await readConfig(siteId, s3.s3Client, {
      s3Bucket: s3.s3Bucket,
    });

    if (!exists) {
      return null;
    }

    return config;
  };

  /**
   * Retrieves prompt usage for a single IMS Org ID.
   *
   * @param {string} imsOrgD - The IMS Org ID.
   * @returns {Promise} A promise that resolves when the operation is complete.
   */
  const getPromptUsageForSingleIMSOrg = async (imsOrgID) => {
    const organization = await Organization.findByImsOrgId(imsOrgID);
    if (!organization) {
      throw new Error(
        'Could not find a Spacecat Organization for the provided IMS org ID',
      );
    }

    const organizationName = organization.getName();
    const orgId = organization.getId();

    const entitlements = await Entitlement.allByOrganizationId(organization.getId());
    if (!entitlements || entitlements.length === 0) {
      throw new Error(
        'Could not find any entitlements for the provided IMS org ID',
      );
    }

    const llmoEntitlement = entitlements.find((e) => e.getProductCode() === 'LLMO');
    let tier;

    if (!llmoEntitlement) {
      throw new Error(
        'No entitlement with product code LLMO found for the provided IMS org ID',
      );
    } else {
      tier = llmoEntitlement.getTier();
    }

    const sitesInOrg = await Site.allByOrganizationId(orgId);

    const configs = await Promise.all(
      sitesInOrg.map((site) => getLlmoConfig(site.getId())),
    );

    let totalPrompts = 0;

    for (const cfg of configs) {
      if (cfg) {
        const topics = cfg.topics || {};
        const topicPromptCount = Object.values(topics).reduce(
          (sum, topic) => sum + (topic.prompts?.length || 0),
          0,
        );
        totalPrompts += topicPromptCount;
      }
    }

    return {
      organizationName,
      imsOrgID,
      tier,
      totalPrompts,
    };
  };

  // TODO: add support for --all flag
  /**
   * Handles site onboarding (single site or batch of sites).
   *
   * @param {string[]} args - The arguments provided to the command ([site]).
   * @param {Object} slackContext - The Slack context object.
   * @param {Function} slackContext.say - The Slack say function.
   * @returns {Promise} A promise that resolves when the operation is complete.
   */
  const handleExecution = async (args, slackContext) => {
    const { say, channelId } = slackContext;

    try {
      const imsOrgIds = args
        .flatMap((s) => s.split(/[,\s]+/)) // split each string by commas/spaces
        .map((s) => s.trim())
        .filter(Boolean);

      if (imsOrgIds.length === 0) {
        await say(
          `Please provide one or more IMS org IDs.\n${baseCommand.usage()}`,
        );
        return;
      }
      if (imsOrgIds.length === 1) {
        const data = await getPromptUsageForSingleIMSOrg(imsOrgIds[0]);
        await say(
          `*Prompt usage for* \`${data.imsOrgID}\`:\n• *IMS Org Name:* ${data.organizationName}\n• *Tier:* ${data.tier}\n• *Total number of prompts:* ${data.totalPrompts}`,
        );
        return;
      }

      const results = await Promise.allSettled(
        imsOrgIds.map((id) => getPromptUsageForSingleIMSOrg(id)),
      );

      const rows = results.map((res, i) => {
        const imsOrgID = imsOrgIds[i];
        if (res.status === 'fulfilled') {
          const { organizationName, tier, totalPrompts } = res.value;
          return {
            organizationName,
            imsOrgID,
            tier,
            totalPrompts,
            error: '',
          };
        } else {
          return {
            organizationName: '',
            imsOrgID,
            tier: '',
            totalPrompts: '',
            error: res.reason?.message,
          };
        }
      });

      const csvStringifier = createObjectCsvStringifier({
        header: [
          { id: 'organizationName', title: 'IMS Org Name' },
          { id: 'imsOrgID', title: 'IMS Org ID' },
          { id: 'tier', title: 'Tier' },
          { id: 'totalPrompts', title: 'Total number of prompts' },
          { id: 'error', title: 'Error' },
        ],
      });

      const csv = csvStringifier.getHeaderString() + csvStringifier.stringifyRecords(rows);

      const csvBuffer = Buffer.from(csv, 'utf8');

      try {
        await sendFile(
          slackContext,
          csvBuffer,
          `prompt-usage-${Date.now()}.csv`,
          'Prompt usage report',
          'Here you can find the prompt usage report.',
          channelId,
        );
      } catch (error) {
        await say(
          `:warning: Failed to upload the report to Slack: ${error.message}`,
        );
      }
    } catch (error) {
      log.error(error);
      await postErrorMessage(say, error);
    }
  };

  baseCommand.init(context);
  return { ...baseCommand, handleExecution };
}

export default GetPromptUsageCommand;
