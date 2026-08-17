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

import { isValidUUID } from '@adobe/spacecat-shared-utils';
import BaseCommand from './base.js';
import { getBrandBySite, setBrandClaimsEnabled } from '../../brands-storage.js';
import { extractURLFromSlackInput, postErrorMessage } from '../../../utils/slack/base.js';

const ENABLE_PHRASE = 'enable-brand-claims';
const DISABLE_PHRASE = 'disable-brand-claims';
const BRAND_CLAIMS_AUDIT_TYPE = 'brand-claims';

/**
 * One command, two explicit keywords: `enable-brand-claims {brandId|baseURL}` and
 * `disable-brand-claims {brandId|baseURL}`. Flips the brand-scoped
 * `brand_claims_enabled` scheduling gate the mystique Brand Claims consumer reads
 * back (LLMO-5741) AND the per-site `brand-claims` audit handler in lock-step, so
 * enabling opts the brand's primary site into the scheduled audit and disabling
 * opts it back out. The verb is derived from which keyword was used — no on/off
 * argument to get wrong. The target may be a brand UUID (as before) or a site base
 * URL, which is resolved to its active brand — so operators can target a site
 * without a separate brand-id lookup.
 *
 * @param {Object} context - The context object.
 * @returns {Object} The command object.
 */
function BrandClaimsCommand(context) {
  const baseCommand = BaseCommand({
    id: 'brand-claims',
    name: 'Brand Claims',
    description: 'Enables or disables Brand Claims scheduling for a brand (by brand ID or site URL).',
    phrases: [ENABLE_PHRASE, DISABLE_PHRASE],
    usageText: `${ENABLE_PHRASE} {brandId|baseURL} | ${DISABLE_PHRASE} {brandId|baseURL}`,
  });

  const { dataAccess, log } = context;
  const { Site, Configuration } = dataAccess;

  const execute = async (message, slackContext) => {
    const { say, user } = slackContext;

    try {
      const trimmed = message.trim();
      const enabled = trimmed.startsWith(ENABLE_PHRASE);
      const phrase = enabled ? ENABLE_PHRASE : DISABLE_PHRASE;
      const target = trimmed.slice(phrase.length).trim().split(/\s+/)[0];

      if (!target) {
        await say(`:warning: Please provide a brand ID or site URL. ${baseCommand.usage()}`);
        return;
      }

      const postgrestClient = dataAccess?.services?.postgrestClient;
      if (!postgrestClient?.from) {
        await say(':x: Brand storage is not available in this environment.');
        return;
      }

      // A UUID is treated as a brand ID (original behavior); anything else is
      // parsed as a site base URL and resolved to that site's active brand
      // (no brand-id lookup).
      let brandId;
      let site = null;
      if (isValidUUID(target)) {
        brandId = target;
      } else {
        const baseUrl = extractURLFromSlackInput(target);
        if (!baseUrl) {
          await say(`:warning: '${target}' is not a valid brand ID (UUID) or site URL. ${baseCommand.usage()}`);
          return;
        }
        site = await Site.findByBaseURL(baseUrl);
        if (!site) {
          await say(`:x: Site not found: \`${target}\``);
          return;
        }
        const resolvedBrand = await getBrandBySite(
          site.getOrganizationId(),
          site.getId(),
          postgrestClient,
          log,
        );
        if (!resolvedBrand) {
          await say(`:warning: No active brand found for site \`${site.getBaseURL()}\`.`);
          return;
        }
        brandId = resolvedBrand.id;
      }

      const actor = user ? `slack:${user}` : 'slack';
      const brand = await setBrandClaimsEnabled({
        brandId,
        enabled,
        postgrestClient,
        updatedBy: actor,
      });

      if (!brand) {
        await say(`:warning: No brand found with ID '${brandId}'.`);
        return;
      }

      log.info(`brand-claims: ${enabled ? 'enabled' : 'disabled'} for brand ${brand.id} ("${brand.name}") by ${actor}`);

      // Keep the per-site `brand-claims` audit handler in lock-step with the
      // brand flag: enabling opts the brand's primary site into the scheduled
      // audit, disabling opts it back out. The URL branch already has the site;
      // otherwise resolve the brand's primary site from the returned `site_id`.
      let auditToggled = false;
      if (!site && brand.site_id) {
        site = await Site.findById(brand.site_id);
      }
      if (site) {
        const configuration = await Configuration.findLatest();
        if (enabled) {
          configuration.enableHandlerForSite(BRAND_CLAIMS_AUDIT_TYPE, site);
        } else {
          configuration.disableHandlerForSite(BRAND_CLAIMS_AUDIT_TYPE, site);
        }
        await configuration.save();
        auditToggled = true;
        log.info(`brand-claims: ${enabled ? 'enabled' : 'disabled'} '${BRAND_CLAIMS_AUDIT_TYPE}' audit for site ${site.getId()} (${site.getBaseURL()})`);
      } else {
        log.warn(`brand-claims: brand ${brand.id} has no resolvable primary site; '${BRAND_CLAIMS_AUDIT_TYPE}' audit not ${enabled ? 'enabled' : 'disabled'}`);
      }

      const auditNote = auditToggled
        ? ` The \`${BRAND_CLAIMS_AUDIT_TYPE}\` audit was ${enabled ? 'enabled' : 'disabled'} for ${site.getBaseURL()}.`
        : ` :warning: No primary site resolved, so the \`${BRAND_CLAIMS_AUDIT_TYPE}\` audit was left unchanged.`;
      await say(`:white_check_mark: Brand claims *${enabled ? 'enabled' : 'disabled'}* for brand "${brand.name}" (${brand.id}).${auditNote}`);
    } catch (error) {
      log.error(error);
      await postErrorMessage(say, error);
    }
  };

  baseCommand.init(context);

  return {
    ...baseCommand,
    execute,
  };
}

export default BrandClaimsCommand;
