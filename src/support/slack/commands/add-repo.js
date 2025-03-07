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

import { isObject, tracingFetch as fetch } from '@adobe/spacecat-shared-utils';

import { triggerAuditForSite } from '../../utils.js';
import { printSiteDetails } from '../../../utils/slack/format.js';
import { validateRepoUrl } from '../../../utils/validations.js';
import {
  extractURLFromSlackInput,
  postErrorMessage,
  postSiteNotFoundMessage,
} from '../../../utils/slack/base.js';

import BaseCommand from './base.js';

const PHRASES = ['add repo', 'save repo', 'add repo by site'];

/**
 * Factory function to create the AddRepoCommand object.
 *
 * @param {Object} context - The context object.
 * @return {AddRepoCommand} The AddRepoCommand object.
 * @constructor
 */
function AddRepoCommand(context) {
  const baseCommand = BaseCommand({
    id: 'add-github-repo',
    name: 'Add GitHub Repo',
    description: 'Adds a Github repository to previously added site.',
    phrases: PHRASES,
    usageText: `${PHRASES.join(' or ')} {site} {githubRepoURL}`,
  });

  const { dataAccess, log } = context;
  const { Configuration, Site } = dataAccess;

  /**
   * Fetches repository information from the GitHub API.
   *
   * @param {string} repoUrl - The GitHub repository URL.
   * @returns {Object} The repository information.
   */
  async function fetchRepoInfo(repoUrl) {
    const repoApiUrl = `https://api.github.com/repos/${repoUrl.split('github.com/')[1]}`;
    try {
      const response = await fetch(repoApiUrl);

      if (response.ok) {
        return response.json();
      } else if (response.status === 404) {
        log.warn(`Failed to fetch GitHub repository at '${repoUrl}', status: ${response.status}, ${response.statusText}`);
        return null;
      } else {
        throw new Error(`Failed to fetch GitHub repository at '${repoUrl}', status: ${response.status}, ${response.statusText}`);
      }
    } catch (error) {
      throw new Error(`Failed to set up request to fetch GitHub repository at '${repoUrl}': ${error.message}`);
    }
  }

  /**
   * Execute function for AddRepoCommand. This function validates the input, fetches the repository
   * information from the GitHub API, and saves it as a site in the database.
   *
   * @param {Array} args - The arguments provided to the command.
   * @param {Object} slackContext - The Slack context object.
   * @param {Function} slackContext.say - The Slack say function.
   * @returns {Promise} A promise that resolves when the operation is complete.
   */
  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;

    try {
      const [baseURLInput, repoUrlInput] = args;

      const baseURL = extractURLFromSlackInput(baseURLInput);
      let repoUrl = extractURLFromSlackInput(repoUrlInput, false, false);

      if (!baseURL || !repoUrl) {
        await say(baseCommand.usage());
        return;
      }

      repoUrl = `https://${repoUrl}`;

      if (!validateRepoUrl(repoUrl)) {
        await say(`:warning: '${repoUrl}' is not a valid GitHub repository URL.`);
        return;
      }

      const site = await Site.findByBaseURL(baseURL);
      if (!isObject(site)) {
        await postSiteNotFoundMessage(say, baseURL);
        return;
      }

      const repoInfo = await fetchRepoInfo(repoUrl);

      if (repoInfo === null) {
        await say(`:warning: The GitHub repository '${repoUrl}' could not be found (private repo?).`);
        return;
      }

      if (repoInfo.archived) {
        await say(`:warning: The GitHub repository '${repoUrl}' is archived. Please unarchive it before adding it to a site.`);
        return;
      }

      site.setGitHubURL(repoUrl);

      await site.save();

      const auditType = 'lhs-mobile';
      const configuration = await Configuration.findLatest();
      const isAuditEnabled = configuration.isHandlerEnabledForSite(auditType, site);

      if (isAuditEnabled) {
        await triggerAuditForSite(site, auditType, slackContext, context);
      }

      await say(`
      :white_check_mark: *GitHub repo added for <${site.getBaseURL()}|${site.getBaseURL()}>*
      
${printSiteDetails(site, isAuditEnabled)}
      
      First PSI check with new repo is triggered! :adobe-run:
      `);
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

export default AddRepoCommand;
