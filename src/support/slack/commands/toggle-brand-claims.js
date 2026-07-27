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

import BaseCommand from './base.js';
import { getBrandBySite, updateBrand } from '../../brands-storage.js';

import {
  extractURLFromSlackInput,
  postErrorMessage,
  postSiteNotFoundMessage,
} from '../../../utils/slack/base.js';

const PHRASES = ['brand-claims'];

const ON_VALUES = new Set(['on', 'enable', 'enabled', 'true', 'yes']);
const OFF_VALUES = new Set(['off', 'disable', 'disabled', 'false', 'no']);

/**
 * Factory function to create the ToggleBrandClaimsCommand object.
 *
 * Enables/disables the Brand Claims scheduling gate for a site's brand. The flag
 * lives on the brand row (`brands.brand_claims_enabled`), so the command resolves
 * the brand for the given site — the same resolution the mystique consumer uses —
 * and flips that brand's row. Enablement is therefore brand-wide (LLMO-5741).
 *
 * @param {Object} context - The context object.
 * @returns {Object} The ToggleBrandClaimsCommand object.
 */
function ToggleBrandClaimsCommand(context) {
  const baseCommand = BaseCommand({
    id: 'toggle-brand-claims',
    name: 'Toggle Brand Claims',
    description: 'Enables or disables the Brand Claims scheduling gate for a site\'s brand '
      + '(brand-scoped; the automated run targets the brand\'s primary domain).',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {site} {on|off}`,
  });

  const { dataAccess, log } = context;
  const { Site } = dataAccess;

  /**
   * Validates input, resolves the site's brand, and flips brandClaimsEnabled.
   *
   * @param {string[]} args - The arguments ([siteBaseURLOrId, onOff]).
   * @param {Object} slackContext - The Slack context object.
   * @param {Function} slackContext.say - The Slack say function.
   * @returns {Promise} A promise that resolves when the operation is complete.
   */
  const handleExecution = async (args, slackContext) => {
    const { say, user } = slackContext;

    try {
      const [siteInput, onOffArg] = args;

      if (!siteInput) {
        await say(':warning: Please provide a valid site base URL or site ID.');
        return;
      }

      const flagArg = (onOffArg || '').trim().toLowerCase();
      if (!ON_VALUES.has(flagArg) && !OFF_VALUES.has(flagArg)) {
        await say(`:warning: Please specify \`on\` or \`off\`. ${baseCommand.usage()}`);
        return;
      }
      const brandClaimsEnabled = ON_VALUES.has(flagArg);

      const baseURL = extractURLFromSlackInput(siteInput);
      const site = baseURL
        ? await Site.findByBaseURL(baseURL)
        : await Site.findById(siteInput);

      if (!site) {
        await postSiteNotFoundMessage(say, siteInput);
        return;
      }

      const postgrestClient = dataAccess?.services?.postgrestClient;
      if (!postgrestClient?.from) {
        await say(':x: Brand storage is not available in this environment.');
        return;
      }

      const organizationId = site.getOrganizationId();
      const brand = await getBrandBySite(organizationId, site.getId(), postgrestClient, log);

      if (!brand) {
        await say(`:warning: No active brand is mapped to '${site.getBaseURL()}' as its primary site. `
          + 'Brand claims are brand-scoped, so there is nothing to toggle for this site.');
        return;
      }

      const updated = await updateBrand({
        organizationId,
        brandId: brand.id,
        updates: { brandClaimsEnabled },
        postgrestClient,
        updatedBy: user ? `slack:${user}` : 'slack',
      });

      if (!updated) {
        await say(`:x: Could not update brand "${brand.name}" (${brand.id}) — it may have been deleted.`);
        return;
      }

      const verb = brandClaimsEnabled ? 'enabled' : 'disabled';
      await say(`:white_check_mark: Brand claims *${verb}* for brand "${brand.name}" (primary: ${brand.baseUrl || site.getBaseURL()}).\n\n`
        + '_This flag is brand-scoped — it applies to every site that maps to this brand, '
        + 'and the automated run targets the brand\'s primary domain._');
    } catch (error) {
      log.error(error);
      await postErrorMessage(say, error);
    }
  };

  baseCommand.init(context);

  return {
    ...baseCommand,
    handleExecution,
  };
}

export default ToggleBrandClaimsCommand;
