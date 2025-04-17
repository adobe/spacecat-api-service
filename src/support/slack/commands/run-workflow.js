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

import { isValidUrl } from '@adobe/spacecat-shared-utils';
import {
  postErrorMessage,
} from '../../../utils/slack/base.js';
import BaseCommand from './base.js';

import Onboard from './onboard.js';

const PHRASES = ['run workflow'];

/**
 * Factory function to create the RunWorkflowCommand object.
 *
 * @param {Object} context - The context object.
 * @returns {RunWorkflowCommand} - The RunWorkflowCommand object.
 * @constructor
 */
function RunWorkflowCommand(context) {
  const baseCommand = BaseCommand({
    id: 'onboard-workflow',
    name: 'Onboard Workflow',
    description: 'Runs full onboarding, scrape, audit, and import for a site or list of sites.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {site} {imsOrgId} [profile]`,
  });

  const { log } = context;
  const onboard = Onboard(context);

  const runWorkflow = async (
    siteUrl,
    imsOrgId,
    profile,
    slackContext,
  ) => {
    const logStep = (msg) => {
      log.info(msg);
      slackContext.say?.(`${msg}`);
    };
    log.info(`Flow debug - runWorkflowForSite for siteUrl ${JSON.stringify(siteUrl)}, imsOrgId ${JSON.stringify(imsOrgId)}, profile ${profile}, slackContext ${slackContext}`);
    try {
      logStep(`Starting onboarding for ${siteUrl}`);
      await onboard.handleExecution([siteUrl, imsOrgId, profile], slackContext);
      log.info(`Flow debug - finished onboarding for ${siteUrl}`);
      logStep(`Completed full workflow for ${siteUrl}`);
    } catch (error) {
      log.info(`Flow debug - failed onboarding for ${siteUrl}`);
      log.error(error);
      await postErrorMessage(slackContext.say, error);
    }
  };

  /**
   * Handles run workflow (single site or batch of sites).
   *
   * @param {string[]} args - The arguments provided to the command ([site]).
   * @param {Object} slackContext - The Slack context object.
   * @param {Function} slackContext.say - The Slack say function.
   * @returns {Promise} A promise that resolves when the operation is complete.
   */
  const handleExecution = async (args, slackContext) => {
    log.info(`Flow debug - in handleExecution for args ${JSON.stringify(args)} and slackContext ${JSON.stringify(slackContext)}`);
    try {
      const [baseURLInput, imsOrgID, profileName = 'default'] = args;
      const baseURL = 'https://www.visualcomfort.com';
      const isSingleSite = isValidUrl(baseURL);

      log.info(`Flow debug - in handleExecution baseURLInput ${baseURLInput}, baseURL ${baseURL}, isSingleSite ${isSingleSite}`);
      await runWorkflow(baseURL, imsOrgID, profileName, slackContext);
      log.info('Flow debug - run workflow for siteUrl completed');
    } catch (error) {
      log.info('Flow debug - failed run workflow for siteUrl failed');
      log.error(error);
      await postErrorMessage(slackContext.say, error);
    }
  };

  baseCommand.init(context);

  return {
    ...baseCommand,
    handleExecution,
  };
}

export default RunWorkflowCommand;
