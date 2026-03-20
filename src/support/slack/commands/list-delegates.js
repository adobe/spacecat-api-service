/*
 * Copyright 2025 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { isValidUUID } from '@adobe/spacecat-shared-utils';

import BaseCommand from './base.js';
import { postErrorMessage } from '../../../utils/slack/base.js';

const PHRASES = ['list delegates'];

/**
 * Slack command: list delegates <site>
 *
 * Lists all cross-org delegation grants for a site.
 */
function ListDelegatesCommand(context) {
  const baseCommand = BaseCommand({
    id: 'list-delegates',
    name: 'List Delegates',
    description: 'Lists all cross-org delegation grants for a site',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {baseURL|siteId}`,
  });

  const { dataAccess, log } = context;
  const { Site, Organization, SiteImsOrgAccess } = dataAccess;

  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;

    try {
      const [siteArg] = args;

      if (!siteArg) {
        await say(baseCommand.usage());
        return;
      }

      // Resolve site
      const site = isValidUUID(siteArg)
        ? await Site.findById(siteArg)
        : await Site.findByBaseURL(siteArg);

      if (!site) {
        await say(`:x: Site not found: \`${siteArg}\``);
        return;
      }

      const grants = await SiteImsOrgAccess.allBySiteId(site.getId());

      if (grants.length === 0) {
        await say(`:information_source: No delegate grants found for site \`${site.getBaseURL()}\`.`);
        return;
      }

      // Resolve org names in parallel (best-effort)
      const orgIds = [...new Set([
        ...grants.map((g) => g.getOrganizationId()),
        ...grants.map((g) => g.getTargetOrganizationId()),
      ])];
      const orgMap = {};
      await Promise.all(orgIds.map(async (id) => {
        try {
          const org = await Organization.findById(id);
          if (org) orgMap[id] = org.getName() || org.getImsOrgId() || id;
        } catch (err) {
          log.warn(`[ListDelegates] Could not resolve org ${id}`, err);
        }
      }));

      const now = new Date();
      const lines = grants.map((g) => {
        const delegateName = orgMap[g.getOrganizationId()] || g.getOrganizationId();
        const targetName = orgMap[g.getTargetOrganizationId()] || g.getTargetOrganizationId();
        const expired = g.getExpiresAt() && new Date(g.getExpiresAt()) <= now
          ? ' *(expired)*' : '';
        return `• \`${g.getId()}\`  delegate: *${delegateName}*  →  target: *${targetName}*  product: \`${g.getProductCode()}\`  role: \`${g.getRole()}\`${expired}`;
      });

      await say(
        `:clipboard: *Delegate grants for \`${site.getBaseURL()}\`* (${grants.length} total)\n${lines.join('\n')}`,
      );
    } catch (error) {
      log.error('[ListDelegates] Error listing delegates:', error);
      await postErrorMessage(say, error);
    }
  };

  baseCommand.init(context);

  return {
    ...baseCommand,
    handleExecution,
  };
}

export default ListDelegatesCommand;
