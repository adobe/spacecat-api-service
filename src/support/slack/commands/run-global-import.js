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

import BaseCommand from './base.js';
import { postErrorMessage } from '../../../utils/slack/base.js';
import { triggerGlobalImportRun } from '../../utils.js';

/* eslint-disable no-useless-escape */
const PHRASES = ['run global import'];

// Global import types that don't require a siteId
const GLOBAL_IMPORTS = [
  'stale-suggestions-cleanup',
];

/**
 * Run Global Import command.
 * Triggers global import jobs that run across all data without requiring a specific site.
 *
 * @param {Object} context - The context object.
 * @return {runGlobalImportCommand} The runGlobalImportCommand object.
 * @constructor
 */
function runGlobalImportCommand(context) {
  const { log, dataAccess } = context;
  const { Configuration } = dataAccess;

  const baseCommand = BaseCommand({
    id: 'run-global-import',
    name: 'Run Global Import',
    description: 'Run a global import job that operates across all data. '
      + 'These imports do not require a specific site URL.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {importType}\n\nAvailable types: \`${GLOBAL_IMPORTS.join('\`, \`')}\``,
  });

  /**
   * Runs a global import for the given type.
   *
   * @param {string[]} args - The arguments provided to the command.
   * @param {Object} slackContext - The Slack context object.
   */
  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;
    const config = await Configuration.findLatest();

    try {
      const [importType] = args;

      if (!importType || importType === '') {
        await say(baseCommand.usage());
        return;
      }

      if (!GLOBAL_IMPORTS.includes(importType)) {
        await say(
          `:warning: Import type \`${importType}\` is not a valid global import type.\n`
          + `Valid types are: \`${GLOBAL_IMPORTS.join('\`, \`')}\``,
        );
        return;
      }

      // Verify the import type is configured in the system
      const jobConfig = config.getJobs().filter(
        (job) => job.group === 'imports' && job.type === importType,
      );
      if (!Array.isArray(jobConfig) || jobConfig.length === 0) {
        await say(
          `:warning: Import type \`${importType}\` is not configured in the system. `
          + 'Please add it to the configuration first.',
        );
        return;
      }

      await triggerGlobalImportRun(
        config,
        importType,
        slackContext,
        context,
      );

      await say(`:adobe-run: Triggered global import: *${importType}*`);
    } catch (error) {
      log.error(`Error running global import: ${error.message}`);
      await postErrorMessage(say, error);
    }
  };

  baseCommand.init(context);

  return {
    ...baseCommand,
    handleExecution,
  };
}

export default runGlobalImportCommand;
