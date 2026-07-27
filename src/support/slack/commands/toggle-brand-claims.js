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
import { setBrandClaimsEnabled } from '../../brands-storage.js';
import { postErrorMessage } from '../../../utils/slack/base.js';

const ENABLE_PHRASE = 'enable-brand-claims';
const DISABLE_PHRASE = 'disable-brand-claims';

/**
 * One command, two explicit keywords: `enable-brand-claims {brandId}` and
 * `disable-brand-claims {brandId}`. Flips the brand-scoped `brand_claims_enabled`
 * scheduling gate the mystique Brand Claims consumer reads back (LLMO-5741). The
 * verb is derived from which keyword was used — no on/off argument to get wrong.
 *
 * @param {Object} context - The context object.
 * @returns {Object} The command object.
 */
function BrandClaimsCommand(context) {
  const baseCommand = BaseCommand({
    id: 'brand-claims',
    name: 'Brand Claims',
    description: 'Enables or disables Brand Claims scheduling for a brand (by brand ID).',
    phrases: [ENABLE_PHRASE, DISABLE_PHRASE],
    usageText: `${ENABLE_PHRASE} {brandId} | ${DISABLE_PHRASE} {brandId}`,
  });

  const { dataAccess, log } = context;

  const execute = async (message, slackContext) => {
    const { say, user } = slackContext;

    try {
      const trimmed = message.trim();
      const enabled = trimmed.startsWith(ENABLE_PHRASE);
      const phrase = enabled ? ENABLE_PHRASE : DISABLE_PHRASE;
      const brandId = trimmed.slice(phrase.length).trim().split(/\s+/)[0];

      if (!brandId) {
        await say(`:warning: Please provide a brand ID. ${baseCommand.usage()}`);
        return;
      }

      if (!isValidUUID(brandId)) {
        await say(`:warning: '${brandId}' is not a valid brand ID (expected a UUID). ${baseCommand.usage()}`);
        return;
      }

      const postgrestClient = dataAccess?.services?.postgrestClient;
      if (!postgrestClient?.from) {
        await say(':x: Brand storage is not available in this environment.');
        return;
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
      await say(`:white_check_mark: Brand claims *${enabled ? 'enabled' : 'disabled'}* for brand "${brand.name}" (${brand.id}).`);
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
