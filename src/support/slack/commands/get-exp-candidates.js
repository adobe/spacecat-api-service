/*
 * Copyright 2023 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

// todo: prototype - untested
/* c8 ignore start */

import BaseCommand from './base.js';

import { extractURLFromSlackInput, postErrorMessage } from '../../../utils/slack/base.js';

import { triggerExperimentationCandidates } from '../../utils.js';

const PHRASES = ['get experimentation candidates'];

/**
 * Factory function to create the GetExperimentationCandidatesCommand object.
 *
 * @param {Object} context - The context object.
 * @returns {GetExperimentationCandidatesCommand} The GetExperimentationCandidatesCommand object.
 * @constructor
 */
function GetExperimentationCandidatesCommand(context) {
  const baseCommand = BaseCommand({
    id: 'get-experimentation-candidates',
    name: 'Get Experimentation Candidates',
    description: 'Get the experimentation candidates for a URL.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {URL}`,
  });

  const { log } = context;

  /**
   * Validates input and triggers the experimentation candidates for the given URL.
   *
   * @param {string[]} args - The arguments provided to the command ([site]).
   * @param {Object} slackContext - The Slack context object.
   * @param {Function} slackContext.say - The Slack say function.
   * @returns {Promise} A promise that resolves when the operation is complete.
   */
  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;

    try {
      const [baseURLInput] = args;

      const url = extractURLFromSlackInput(baseURLInput);

      if (!url) {
        await say(':warning: Please provide a valid url.');
        return;
      }

      await triggerExperimentationCandidates(url, slackContext, context);

      let message = `:white_check_mark: Scraping and determining desktop experimentation candidates for ${url}\n`;
      message += ':adobe-run: Stand by for results. I will post them here when they are ready.';

      await say(message);
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

export default GetExperimentationCandidatesCommand;
/* c8 ignore end */
