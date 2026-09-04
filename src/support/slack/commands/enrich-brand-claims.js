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

import { isValidUrl } from '@adobe/spacecat-shared-utils';
import BaseCommand from './base.js';
import {
  extractURLFromSlackInput,
  postErrorMessage,
  postSiteNotFoundMessage,
} from '../../../utils/slack/base.js';
import { triggerBrandClaimsEnrich } from '../../utils.js';

const PHRASE = 'enrich-brand-claims';

/**
 * `enrich-brand-claims {site}` — triggers a cache-safe off-site opportunity link
 * refresh for a site's existing Brand Claims (LLMO-7312). It fires the `brand-claims`
 * audit with `mode: 'enrich'`; the audit worker forwards that onto its ready-signal
 * and mystique's BP consumer force-recomputes only the citation matcher + delivery,
 * leaving every expensive claims/LLM fact cached. Unlike `run audit ... brand-claims`
 * (a full recompute), this is the cheap "pick up newly-available off-site
 * opportunities" path — no LLM cost.
 *
 * @param {Object} context - The context object.
 * @returns {Object} The command object.
 */
function EnrichBrandClaimsCommand(context) {
  const baseCommand = BaseCommand({
    id: 'enrich-brand-claims',
    name: 'Enrich Brand Claims',
    description: 'Refreshes off-site opportunity links for a site\'s existing Brand Claims (cache-safe; no full recompute).',
    phrases: [PHRASE],
    usageText: `${PHRASE} {site}`,
  });

  const { dataAccess, log } = context;
  const { Site } = dataAccess;

  const execute = async (message, slackContext) => {
    const { say } = slackContext;

    try {
      const target = message.trim().slice(PHRASE.length).trim().split(/\s+/)[0];
      const baseURL = extractURLFromSlackInput(target);

      if (!baseURL || !isValidUrl(baseURL)) {
        await say(`:warning: Please provide a valid site URL. ${baseCommand.usage()}`);
        return;
      }

      const site = await Site.findByBaseURL(baseURL);
      if (!site) {
        await postSiteNotFoundMessage(say, baseURL);
        return;
      }

      await triggerBrandClaimsEnrich(site, slackContext, context);
      log.info(`enrich-brand-claims: triggered off-site opportunity enrich for site ${site.getId()} (${baseURL})`);
      await say(`:adobe-run: Triggering Brand Claims off-site opportunity *enrich* for ${baseURL} (cache-safe link refresh).`);
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

export default EnrichBrandClaimsCommand;
