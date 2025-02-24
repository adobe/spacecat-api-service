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

import {
  postErrorMessage,
} from '../../../utils/slack/base.js';

import BaseCommand from './base.js';

const PHRASES = ['onboard batch'];

/**
 * Factory function to create the OnboardBatchCommand object.
 *
 * @param {Object} context - The context object.
 * @returns {OnboardBatchCommand} - The OnboardBatchCommand object.
 * @constructor
 */
function OnboardBatchCommand(context) {
  const baseCommand = BaseCommand({
    id: 'onboard-batch',
    name: 'Obboard Batch',
    description: 'Onboards a new batch of sites to Success Studio.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {batch-file}`,
  });

  const { log } = context;

  /**
   * Validates input and auto-onboards the batch of sites to ESS
   *
   * @param {string[]} args - The arguments provided to the command ([batch]).
   * @param {Object} slackContext - The Slack context object.
   * @param {Function} slackContext.say - The Slack say function.
   * @returns {Promise} A promise that resolves when the operation is complete.
   */
  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;

    try {
      // eslint-disable-next-line prefer-destructuring
      const files = args.files;
      if (!files || files.length === 0) {
        await say('No file attached. Please attach a CSV file for batch onboarding, and try again!');
        return;
      }

      const file = files[0];
      if (file.filetype !== 'csv') {
        await say('Please attach a valid CSV file.');
      }
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

export default OnboardBatchCommand;
