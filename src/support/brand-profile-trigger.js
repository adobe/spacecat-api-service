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

import { hasText } from '@adobe/spacecat-shared-utils';
import { startAgentWorkflow } from './agent-workflow.js';

const AGENT_ID = 'brand-profile';

const buildSlackContext = (slackContext) => {
  if (!slackContext?.channelId) {
    return undefined;
  }
  return {
    channelId: slackContext.channelId,
    threadTs: slackContext.threadTs,
  };
};

/**
 * Triggers the brand-profile agent Step Function for a given site.
 *
 * @param {object} options
 * @param {object} options.context - Lambda/controller context (env/log/data access)
 * @param {object} options.site - Site entity (must expose getId/getBaseURL)
 * @param {object} [options.slackContext] - Slack metadata for notifications
 * @param {string} [options.reason='manual'] - Reason suffix used for idempotency key/name
 * @returns {Promise<string|null>} Execution name if triggered, otherwise null
 */
export const triggerBrandProfileAgent = async ({
  context,
  site,
  siteId,
  baseURL,
  slackContext,
  reason = 'manual',
}) => {
  const { env = {}, log } = context || {};

  if (env.ENABLE_BRAND_PROFILE_AUTORUN === 'false') {
    log?.info?.('brand-profile autorun disabled via env flag');
    return null;
  }

  if (!hasText(env?.AGENT_WORKFLOW_STATE_MACHINE_ARN)) {
    log?.debug?.('brand-profile workflow ARN not configured; skipping trigger');
    return null;
  }

  let resolvedSite = site;
  let resolvedSiteId = site?.getId?.() || siteId;
  let resolvedBaseURL = site?.getBaseURL?.() || baseURL;

  if (!resolvedSite && hasText(resolvedSiteId) && context?.dataAccess?.Site?.findById) {
    try {
      resolvedSite = await context.dataAccess.Site.findById(resolvedSiteId);
      resolvedSiteId = resolvedSite?.getId?.() || resolvedSiteId;
      resolvedBaseURL = resolvedSite?.getBaseURL?.() || resolvedBaseURL;
    } catch (error) {
      log?.warn?.(`brand-profile trigger: failed to load site ${resolvedSiteId}`, error);
    }
  }

  if (!hasText(resolvedSiteId) || !hasText(resolvedBaseURL)) {
    log?.warn?.('brand-profile trigger skipped: missing site identifier/baseURL', {
      siteId: resolvedSiteId,
      baseURL: resolvedBaseURL,
    });
    return null;
  }

  const idempotencyKey = `${AGENT_ID}-${resolvedSiteId}-${reason}-${Date.now()}`;
  const executionName = `${AGENT_ID}-${resolvedSiteId}-${reason}-${Date.now()}`.slice(0, 80);

  try {
    const payload = {
      agentId: AGENT_ID,
      siteId: resolvedSiteId,
      context: {
        baseURL: resolvedBaseURL,
      },
      idempotencyKey,
    };

    const slackMeta = buildSlackContext(slackContext);
    payload.slackContext = slackMeta || {};

    const startedExecution = await startAgentWorkflow(context, payload, {
      executionName,
    });

    log?.info?.('brand-profile agent workflow triggered', {
      siteId: resolvedSiteId,
      reason,
      executionName: startedExecution,
    });

    return startedExecution;
  } catch (error) {
    log?.warn?.(`Failed to trigger brand-profile workflow for site ${resolvedSiteId}`, error);
    return null;
  }
};

export default triggerBrandProfileAgent;
