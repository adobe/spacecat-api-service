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

import { hasText, isValidUrl } from '@adobe/spacecat-shared-utils';

import BaseCommand from './base.js';
import {
  extractURLFromSlackInput,
  postErrorMessage,
  postSiteNotFoundMessage,
} from '../../../utils/slack/base.js';
import { triggerBrandProfileAgent } from '../../brand-profile-trigger.js';

const COMMAND_ID = 'run-brand-profile';
const PHRASES = ['brand profile', 'run brand profile'];
const BRAND_PROFILE_SLACK_REASON = 'brand-profile-slack';

function RunBrandProfileCommand(context) {
  const baseCommand = BaseCommand({
    id: COMMAND_ID,
    name: 'Brand Profile Agent',
    description: 'Trigger the brand-profile agent for a specific site.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {baseURL}`,
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
    await triggerBrandProfileAgent({
      context,
      site,
      slackContext: buildSlackContext(slackContext),
      reason: BRAND_PROFILE_SLACK_REASON,
    });
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
