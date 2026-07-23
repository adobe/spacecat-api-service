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

import BaseCommand from './base.js';
import {
  extractURLFromSlackInput,
  postErrorMessage,
  postSiteNotFoundMessage,
} from '../../../utils/slack/base.js';
import { triggerGlobalImportRun } from '../../utils.js';

/* c8 ignore start */
/* eslint-disable no-useless-escape */
const PHRASES = ['run global import'];
const FORCE_FLAG = '--force';

const GLOBAL_IMPORTS = [
  'stale-suggestions-cleanup',
  'optimize-at-edge-enabled-marking',
];

/**
 * Splits the `--force` flag out of the raw args, wherever it appears, leaving the remaining
 * positional args (importType, site) in order.
 *
 * @param {string[]} args - Raw args as provided to the command.
 * @returns {{ positionalArgs: string[], force: boolean }}
 */
function splitForceFlag(args) {
  const positionalArgs = args.filter((a) => a !== FORCE_FLAG);
  const force = args.includes(FORCE_FLAG);
  return { positionalArgs, force };
}

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
  const { Configuration, Site } = dataAccess;

  const baseCommand = BaseCommand({
    id: 'run-global-import',
    name: 'Run Global Import',
    description: 'Run a global import job that operates across all data. '
      + 'These imports do not require a specific site URL, but an optional site (URL or ID) '
      + 'scopes the run to just that one site, and --force skips that handler\'s normal '
      + 'gating check for it, for handlers that support both.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {importType} [site-url-or-id] [--force]\n\nAvailable types: \`${GLOBAL_IMPORTS.join('\`, \`')}\`\n`
      + 'Optional site (URL or ID): scope the run to a single site instead of all data '
      + '(currently only `optimize-at-edge-enabled-marking` uses it).\n'
      + '`--force`: requires a site — skips prerender content validation, enabling the site '
      + 'on the edge request-id check alone. Never touches an already-enabled site.',
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
      const { positionalArgs, force } = splitForceFlag(args);
      const [importType, siteInput] = positionalArgs;

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

      // Optional site scope — accepts either a site URL or a raw site ID.
      let site;
      if (siteInput) {
        const baseURL = extractURLFromSlackInput(siteInput);
        site = baseURL
          ? await Site.findByBaseURL(baseURL)
          : await Site.findById(siteInput);

        if (!site) {
          await postSiteNotFoundMessage(say, siteInput);
          return;
        }
      }

      if (force && !site) {
        await say(':warning: `--force` requires a site (URL or ID) to scope to — it has no effect on a bulk run.');
        return;
      }

      await triggerGlobalImportRun(
        config,
        importType,
        slackContext,
        context,
        { siteId: site?.getId(), force, forcedBy: slackContext.user },
      );

      let message = `:adobe-run: Triggered global import: *${importType}*`;
      if (site) {
        message += ` for site *${site.getBaseURL()}* (\`${site.getId()}\`)`;
      }
      if (force) {
        message += ' — *force*: skipping prerender content validation.';
      }
      await say(message);
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
/* c8 ignore end */
