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

import { isValidUrl, isNonEmptyArray } from '@adobe/spacecat-shared-utils';
import {
  postErrorMessage,
} from '../../../utils/slack/base.js';
import BaseCommand from './base.js';

import Onboard from './onboard.js';

const PHRASES = ['run workflow site', 'run workflow sites'];

function RunWorkflowCommand(context) {
  const baseCommand = BaseCommand({
    id: 'onboard-workflow',
    name: 'Onboard Workflow',
    description: 'Runs full onboarding, scrape, audit, and import for a site or list of sites.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {siteURL} {imsOrgId} {profile} {importType} {startDate} {endDate}`,
  });

  const { log } = context;

  const onboard = Onboard(context);

  const runWorkflowForSite = async (
    siteUrl,
    imsOrgId,
    profile,
    slackContext,
  ) => {
    const logStep = (msg) => {
      log.info(msg);
      slackContext.say?.(`${msg}`);
    };

    try {
      logStep(`Starting onboarding for ${siteUrl}`);
      try {
        await onboard.handleExecution([siteUrl, imsOrgId, profile], slackContext);
      } catch (err) {
        log.error('Can not call handleExecution from onboard command', err);
      }
      logStep(`Completed full workflow for ${siteUrl}`);
    } catch (error) {
      log.error(error);
      await postErrorMessage(slackContext.say, error);
    }
  };

  const handleExecution = async (args, slackContext) => {
    const { say, files } = slackContext;

    try {
      const [siteUrlOrImportType, imsOrgId, profile] = args;

      const hasCSV = isNonEmptyArray(files);
      const isSingleSite = isValidUrl(siteUrlOrImportType);

      if (!isSingleSite && !hasCSV) {
        await say(baseCommand.usage());
        return;
      }

      if (isSingleSite && hasCSV) {
        await say(':warning: Provide either a URL or a CSV file, not both.');
        return;
      }
      await runWorkflowForSite(siteUrlOrImportType, imsOrgId, profile, slackContext);
    } catch (error) {
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
