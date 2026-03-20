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
import {
  SiteImsOrgAccess as SiteImsOrgAccessModel,
  AccessGrantLog as AccessGrantLogModel,
} from '@adobe/spacecat-shared-data-access';

import BaseCommand from './base.js';
import { postErrorMessage } from '../../../utils/slack/base.js';

const PHRASES = ['add delegate'];

/**
 * Slack command: add delegate <site> <imsOrgId> <productCode>
 *
 * Grants cross-org delegation access. Resolves the IMS org → Organization record,
 * creating one on the fly if not present (requires imsClient). The site is resolved
 * by base URL or UUID.
 */
function AddDelegateCommand(context) {
  const baseCommand = BaseCommand({
    id: 'add-delegate',
    name: 'Add Delegate',
    description: 'Grants a delegate IMS org access to a site for a given product',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {baseURL|siteId} {imsOrgId} {productCode}`,
  });

  const { dataAccess, log, imsClient } = context;
  const {
    Site, Organization, SiteImsOrgAccess, AccessGrantLog,
  } = dataAccess;

  const handleExecution = async (args, slackContext) => {
    const { say, user: userId } = slackContext;

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

      // Resolve delegate org (create on the fly if not found)
      let delegateOrg = await Organization.findByImsOrgId(imsOrgId);
      if (!delegateOrg) {
        let imsOrgDetails;
        try {
          imsOrgDetails = await imsClient.getImsOrganizationDetails(imsOrgId);
        } catch (err) {
          log.error(`[AddDelegate] Error retrieving IMS org details: ${err.message}`);
          await say(`:x: Could not find an IMS org with the ID *${imsOrgId}* in IMS.`);
          return;
        }
        if (!imsOrgDetails) {
          await say(`:x: Could not find an IMS org with the ID *${imsOrgId}* in IMS.`);
          return;
        }
        delegateOrg = await Organization.create({
          name: imsOrgDetails.orgName,
          imsOrgId,
        });
        await delegateOrg.save();
      }

      // Resolve target org (the org that owns the site)
      const targetOrg = await site.getOrganization();
      if (!targetOrg) {
        await say(`:x: Site \`${site.getBaseURL()}\` has no owning organization.`);
        return;
      }

      // Use the Slack user ID directly — stable, unique, schema-valid (slack:<non-whitespace>).
      const performedBy = `slack:${userId}`;

      const grant = await SiteImsOrgAccess.create({
        siteId: site.getId(),
        organizationId: delegateOrg.getId(),
        targetOrganizationId: targetOrg.getId(),
        productCode,
        role: SiteImsOrgAccessModel.DELEGATION_ROLES.AGENCY,
        grantedBy: performedBy,
        updatedBy: performedBy,
      });

      if (AccessGrantLog) {
        await AccessGrantLog.create({
          siteId: site.getId(),
          organizationId: delegateOrg.getId(),
          targetOrganizationId: targetOrg.getId(),
          productCode,
          action: AccessGrantLogModel.GRANT_ACTIONS.GRANT,
          role: grant.getRole(),
          performedBy,
        }).catch((err) => log.error('[AddDelegate] Failed to write access grant log', err));
      }

      await say(
        `:white_check_mark: *Delegate access granted*\nSite: \`${site.getBaseURL()}\`\nDelegate org: *${delegateOrg.getName() || imsOrgId}* (\`${imsOrgId}\`)\nProduct: \`${productCode}\`\nGrant ID: \`${grant.getId()}\``,
      );
    } catch (error) {
      if (error.status === 409) {
        await say(`:information_source: ${error.message}`);
        return;
      }
      log.error('[AddDelegate] Error adding delegate:', error);
      await postErrorMessage(say, error);
    }
  };

  baseCommand.init(context);

  return {
    ...baseCommand,
    handleExecution,
  };
}

export default AddDelegateCommand;
