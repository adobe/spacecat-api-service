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

import { randomUUID } from 'crypto';
import { hasText, isValidUrl } from '@adobe/spacecat-shared-utils';

import BaseCommand from './base.js';
import {
  extractURLFromSlackInput,
  postErrorMessage,
  postSiteNotFoundMessage,
} from '../../../utils/slack/base.js';
import { startAgentWorkflow } from '../../agent-workflow.js';

const COMMAND_ID = 'run-brand-profile';
const AGENT_ID = 'brand-profile';
const PHRASES = ['brand profile', 'run brand profile'];

const normalizeAllArgument = (arg = '') => {
  const normalized = arg.trim().toLowerCase();
  return normalized === 'all' || normalized === 'all-sites' || normalized === 'allsites';
};

function RunBrandProfileCommand(context) {
  const baseCommand = BaseCommand({
    id: COMMAND_ID,
    name: 'Brand Profile Agent',
    description: 'Trigger the brand-profile agent for a specific site or for all known sites.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {baseURL|all}`,
  });

  const { dataAccess, log, env } = context;
  const { Site } = dataAccess;

  const ensureWorkflowConfigured = async (say) => {
    if (hasText(env?.AGENT_WORKFLOW_STATE_MACHINE_ARN)) {
      return true;
    }
    await say(':warning: Agent workflow ARN is not configured. Please set `AGENT_WORKFLOW_STATE_MACHINE_ARN`.');
    return false;
  };

  const buildSlackContext = (slackContext) => (hasText(slackContext?.channelId) ? {
    channelId: slackContext.channelId,
    threadTs: slackContext.threadTs,
  } : undefined);

  const triggerAgentForSite = async (site, slackContext) => {
    const siteId = site.getId();
    const baseURL = site.getBaseURL();

    const payload = {
      agentId: AGENT_ID,
      siteId,
      context: {
        baseURL,
      },
      slackContext: buildSlackContext(slackContext),
      idempotencyKey: randomUUID(),
    };

    const executionName = `brand-${siteId}-${Date.now()}`;
    await startAgentWorkflow(context, payload, { executionName });
    return baseURL;
  };

  const handleSingleSite = async (args, slackContext) => {
    const { say } = slackContext;
    const baseURL = extractURLFromSlackInput(args[0]);
    if (!isValidUrl(baseURL)) {
      await say(baseCommand.usage());
      return;
    }

    const site = await Site.findByBaseURL(baseURL);
    if (!site) {
      await postSiteNotFoundMessage(say, baseURL);
      return;
    }

    await say(`:adobe-run: Triggering brand-profile agent for \`${baseURL}\``);
    try {
      await triggerAgentForSite(site, slackContext);
      await say(':rocket: Brand-profile agent queued. Updates will be posted in this thread.');
    } catch (error) {
      log.error(`brand-profile command: failed for site ${baseURL}`, error);
      await postErrorMessage(say, error);
    }
  };

  const handleAllSites = async (slackContext) => {
    const { say } = slackContext;
    const sites = await Site.all();
    if (!sites?.length) {
      await say(':warning: No sites found to run the brand-profile agent.');
      return;
    }

    await say(`:adobe-run: Triggering brand-profile agent for ${sites.length} site(s). This may take a few moments.`);
    const failures = [];

    // Run sequentially to avoid overwhelming Step Functions with a burst of executions.
    // eslint-disable-next-line no-restricted-syntax
    for (const site of sites) {
      const baseURL = site.getBaseURL();
      try {
        // eslint-disable-next-line no-await-in-loop
        await triggerAgentForSite(site, slackContext);
      } catch (error) {
        log.error(`brand-profile command: failed for site ${baseURL}`, error);
        failures.push({ baseURL, error: error.message });
      }
    }

    if (failures.length > 0) {
      const preview = failures
        .slice(0, 5)
        .map((failure) => `• ${failure.baseURL} (${failure.error})`)
        .join('\n');
      await say(`:warning: Brand-profile agent failed to start for ${failures.length} site(s).\n${preview}`);
      return;
    }

    await say(':white_check_mark: Brand-profile agent queued for all sites.');
  };

  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;
    if (!(await ensureWorkflowConfigured(say))) {
      return;
    }

    if (!args.length) {
      await say(baseCommand.usage());
      return;
    }

    try {
      if (normalizeAllArgument(args[0])) {
        await handleAllSites(slackContext);
        return;
      }

      await handleSingleSite(args, slackContext);
    } catch (error) {
      log.error('brand-profile command encountered an error', error);
      await postErrorMessage(say, error);
    }
  };

  baseCommand.init(context);

  return {
    ...baseCommand,
    handleExecution,
  };
}

export default RunBrandProfileCommand;
