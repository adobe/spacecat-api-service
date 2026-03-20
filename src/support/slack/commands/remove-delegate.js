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
import { AccessGrantLog as AccessGrantLogModel } from '@adobe/spacecat-shared-data-access';

import BaseCommand from './base.js';
import { postErrorMessage } from '../../../utils/slack/base.js';
import resolveSlackUsername from '../../../utils/slack/users.js';

const PHRASES = ['remove delegate'];

/**
 * Slack command: remove delegate <site> <imsOrgId> <productCode>
 *
 * Revokes a cross-org delegation grant for a site.
 */
function RemoveDelegateCommand(context) {
  const baseCommand = BaseCommand({
    id: 'remove-delegate',
    name: 'Remove Delegate',
    description: 'Revokes a delegate IMS org access grant from a site for a given product',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {baseURL|siteId} {imsOrgId} {productCode}`,
  });

  const { dataAccess, log } = context;
  const {
    Site, Organization, SiteImsOrgAccess, AccessGrantLog,
  } = dataAccess;

  const handleExecution = async (args, slackContext) => {
    const { say, user: userId, client } = slackContext;

    try {
      const [siteArg, imsOrgId, productCode] = args;

      if (!siteArg || !imsOrgId || !productCode) {
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

      // Resolve delegate org
      const delegateOrg = await Organization.findByImsOrgId(imsOrgId);
      if (!delegateOrg) {
        await say(`:x: Organization not found with IMS Org ID: \`${imsOrgId}\``);
        return;
      }

      const grant = await SiteImsOrgAccess.findBySiteIdAndOrganizationIdAndProductCode(
        site.getId(),
        delegateOrg.getId(),
        productCode,
      );

      if (!grant) {
        await say(
          `:x: No delegate grant found for site \`${site.getBaseURL()}\`, org \`${imsOrgId}\`, product \`${productCode}\`.`,
        );
        return;
      }

      // Use the Slack user ID directly for the audit trail — stable, unique, schema-valid.
      // Resolve the display name separately for the human-readable Slack response.
      const performedBy = `slack:${userId}`;
      const displayName = await resolveSlackUsername(client, userId);

      if (AccessGrantLog) {
        await AccessGrantLog.create({
          siteId: site.getId(),
          organizationId: delegateOrg.getId(),
          targetOrganizationId: grant.getTargetOrganizationId(),
          productCode,
          action: AccessGrantLogModel.GRANT_ACTIONS.REVOKE,
          role: grant.getRole(),
          performedBy,
        }).catch((err) => log.error('[RemoveDelegate] Failed to write access grant log', err));
      }

      await grant.remove();

      await say(
        `:white_check_mark: *Delegate access revoked*\nSite: \`${site.getBaseURL()}\`\nDelegate org: *${delegateOrg.getName() || imsOrgId}* (\`${imsOrgId}\`)\nProduct: \`${productCode}\`\nRevoked by: ${displayName}`,
      );
    } catch (error) {
      log.error('[RemoveDelegate] Error removing delegate:', error);
      await postErrorMessage(say, error);
    }
  };

  baseCommand.init(context);

  return {
    ...baseCommand,
    handleExecution,
  };
}

export default RemoveDelegateCommand;
