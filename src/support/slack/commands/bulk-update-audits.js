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

import BaseCommand from './base.js';
import { SiteDto } from '../../../dto/site.js';

const PHRASES = ['bulk', 'audit configs'];
function BulkUpdateAuditConfigCommand(context) {
  const baseCommand = BaseCommand({
    id: 'bulk--audits',
    name: 'Bulk Enable Audits',
    description: 'Enables or disables audits for multiple sites.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {enable/disable} {site1,site2,...} {auditType1,auditType2,...}`,
  });

  const { log, dataAccess } = context;

  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;

    try {
      const [enableDisableInput, baseURLsInput, auditTypesInput] = args;

      const baseURLs = baseURLsInput.split(',');
      const auditTypes = auditTypesInput.split(',');

      const enableAudits = enableDisableInput.toLowerCase() === 'enable';

      const organizationsMap = new Map();

      const sites = await Promise.all(baseURLs.map(async (baseURL) => {
        const site = await dataAccess.getSiteByBaseURL(baseURL);
        if (!site) {
          return { baseURL, site: null };
        }
        const organizationId = site.getOrganizationId();

        if (organizationId !== 'default' && !organizationsMap.has(organizationId)) {
          const organization = await dataAccess.getOrganizationByID(organizationId);
          if (!organization) {
            return { baseURL, error: `Error updating site with organization with id: ${organizationId} not found` };
          }
          organizationsMap.set(organizationId, organization);
        }

        return { baseURL, site };
      }));

      const responses = await Promise.all(sites.map(async ({ baseURL, site, error }) => {
        if (!site) {
          return { baseURL, payload: error || `Cannot update site with baseURL: ${baseURL}` };
        }
        const organizationId = site.getOrganizationId();
        const organization = organizationsMap.get(organizationId);

        auditTypes.forEach((auditType) => {
          if (organization) {
            organization.getAuditConfig().updateAuditTypeConfig(
              auditType,
            );
          }
          site.getAuditConfig().updateAuditTypeConfig(auditType, { auditsDisabled: !enableAudits });
        });

        if (organization && enableAudits) {
          try {
            await dataAccess.updateOrganization(organization);
          } catch (e) {
            return { baseURL, payload: `Error updating site with organization with id: ${organizationId}` };
          }
        }
        try {
          await dataAccess.updateSite(site);
        } catch (e) {
          return { baseURL, payload: `Error updating site with id: ${site.getId()}` };
        }

        return { baseURL, payload: SiteDto.toJSON(site) };
      }));

      let message = 'Bulk update completed with the following responses:\n';
      responses.forEach((response) => {
        message += `- ${response.baseURL}: ${response.payload}\n`;
      });

      await say(message);
    } catch (error) {
      log.error(error);
      await say(`Error during bulk update: ${error.message}`);
    }
  };

  baseCommand.init(context);

  return {
    ...baseCommand,
    handleExecution,
  };
}

export default BulkUpdateAuditConfigCommand;
