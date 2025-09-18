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

import { isNonEmptyArray, isNonEmptyObject, isValidUrl } from '@adobe/spacecat-shared-utils';
import BaseCommand from './base.js';

import {
  extractURLFromSlackInput,
  parseCSV,
  postErrorMessage,
  postSiteNotFoundMessage,
} from '../../../utils/slack/base.js';

import { triggerAuditForSite } from '../../utils.js';

const PHRASES = ['run audit'];
const LHS_MOBILE = 'lhs-mobile';
const ALL_AUDITS = [
  'apex',
  'cwv',
  'lhs-mobile',
  'lhs-desktop',
  '404',
  'sitemap',
  'canonical',
  'broken-backlinks',
  'broken-internal-links',
  'llm-error-pages',
  'experimentation-opportunities',
  'meta-tags',
  'structured-data',
  'forms-opportunities',
  'alt-text',
  'geo-brand-presence',
];

/**
 * Parses keyword arguments from command input.
 * Supports formats like "audit:geo-brand-presence", "audit: geo-brand-presence",
 * "date-start:2025-09-07", "source:google-ai-overviews"
 * Handles Slack-formatted URLs like <http://example.com|example.com>
 * @param {string[]} args - The command arguments
 * @returns {Object} Parsed arguments with keywords and remaining positional args
 */
const parseKeywordArguments = (args, say = null) => {
  const keywords = {};
  const positionalArgs = [];

  if (say) {
    say(`:bug: DEBUG: parseKeywordArguments called with: ${JSON.stringify(args)}`);
  }

  args.forEach((arg, index) => {
    if (say) {
      say(`:bug: DEBUG: Processing arg ${index}: "${arg}"`);
    }

    // Check if this is a Slack-formatted URL (e.g., <http://example.com|example.com>)
    const isSlackFormattedUrl = arg && arg.match(/^<https?:\/\/[^|>]+\|[^>]+>$/);

    if (say && isSlackFormattedUrl) {
      say(`:bug: DEBUG: Detected Slack-formatted URL: "${arg}"`);
    }

    if (arg && arg.includes(':') && !isSlackFormattedUrl) {
      const [key, ...valueParts] = arg.split(':');
      const value = valueParts.join(':').trim(); // Handle cases where value contains colons and trim whitespace
      keywords[key] = value;

      if (say) {
        say(`:bug: DEBUG: Found keyword - key: "${key}", value: "${value}"`);
      }
    } else {
      positionalArgs.push(arg);

      if (say) {
        say(`:bug: DEBUG: Added to positional args: "${arg}"`);
      }
    }
  });

  if (say) {
    say(`:bug: DEBUG: parseKeywordArguments result - keywords: ${JSON.stringify(keywords)}, positionalArgs: ${JSON.stringify(positionalArgs)}`);
  }

  return { keywords, positionalArgs };
};

/**
 * Factory function to create the RunAuditCommand object.
 *
 * @param {Object} context - The context object.
 * @returns {RunAuditCommand} The RunAuditCommand object.
 * @constructor
 */
function RunAuditCommand(context) {
  const baseCommand = BaseCommand({
    id: 'run-audit',
    name: 'Run Audit',
    description: 'Run audit for a previously added site. Supports both positional and keyword arguments. Runs lhs-mobile by default if no audit type is specified. Use `audit:all` to run all audits.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {site} [auditType] [auditData] OR {site} audit:{auditType} [key:value ...]`,
  });

  const { dataAccess, log } = context;
  const { Configuration, Site } = dataAccess;

  /**
   * Runs an audit for the given site.
   * @param {string} baseURL - The base URL of the site.
   * @param {string} auditType - The type of audit to run.
   * @param {undefined|string} auditData - Extra data to pass to the audit.
   * @param {object} slackContext - The Slack context object.
   * @returns {Promise} A promise that resolves when the operation is complete.
   */
  const runAuditForSite = async (baseURL, auditType, auditData, slackContext) => {
    const { say } = slackContext;

    await say(`:bug: DEBUG: runAuditForSite called with baseURL=${baseURL}, auditType=${auditType}, auditData=${auditData}`);

    try {
      await say(`:bug: DEBUG: Looking up site for baseURL: ${baseURL}`);
      const site = await Site.findByBaseURL(baseURL);
      await say(`:bug: DEBUG: Site found: ${site ? 'YES' : 'NO'}, site data: ${JSON.stringify(site, null, 2)}`);

      await say(':bug: DEBUG: Fetching latest configuration');
      const configuration = await Configuration.findLatest();
      await say(`:bug: DEBUG: Configuration found: ${configuration ? 'YES' : 'NO'}`);

      if (!isNonEmptyObject(site)) {
        await postSiteNotFoundMessage(say, baseURL);
        return;
      }

      await say(`:bug: DEBUG: Checking audit type: ${auditType}`);

      if (auditType === 'all') {
        await say(':bug: DEBUG: Running \'all\' audits');
        // const enabledAudits = configuration.getEnabledAuditsForSite(site);
        const enabledAudits = ALL_AUDITS.filter(
          (audit) => configuration.isHandlerEnabledForSite(audit, site),
        );

        await say(`:bug: DEBUG: Enabled audits: ${JSON.stringify(enabledAudits)}`);

        if (!isNonEmptyArray(enabledAudits)) {
          await say(`:warning: No audits configured for site \`${baseURL}\``);
          return;
        }

        await say(`:adobe-run: Triggering ${auditType} audit for ${baseURL}`);
        await Promise.all(
          enabledAudits.map(async (enabledAuditType) => {
            try {
              await say(`:bug: DEBUG: Triggering audit: ${enabledAuditType}`);
              await triggerAuditForSite(site, enabledAuditType, undefined, slackContext, context);
            } catch (error) {
              log.error(`Error running audit ${enabledAuditType.id} for site ${baseURL}`, error);
              await postErrorMessage(say, error);
            }
          }),
        );
      } else {
        await say(`:bug: DEBUG: Running single audit type: ${auditType}`);
        await say(`:bug: DEBUG: Checking if handler is enabled for audit type: ${auditType}`);

        const isHandlerEnabled = configuration.isHandlerEnabledForSite(auditType, site);
        await say(`:bug: DEBUG: Handler enabled: ${isHandlerEnabled}`);

        if (!isHandlerEnabled) {
          await say(`:x: Will not audit site '${baseURL}' because audits of type '${auditType}' are disabled for this site.`);
          return;
        }
        await say(`:adobe-run: Triggering ${auditType} audit for ${baseURL}`);
        await say(`:bug: DEBUG: About to call triggerAuditForSite with auditData: ${auditData}`);
        await triggerAuditForSite(site, auditType, auditData, slackContext, context);
        await say(':bug: DEBUG: triggerAuditForSite completed successfully');
      }
    } catch (error) {
      await say(`:bug: DEBUG: Error in runAuditForSite: ${error.message}`);
      await say(`:bug: DEBUG: Error stack: ${error.stack}`);
      log.error(`Error running audit ${auditType} for site ${baseURL}`, error);
      await postErrorMessage(say, error);
    }
  };

  /**
   * Validates input, fetches the site
   * and triggers a new audit for the given site
   *
   * @param {string[]} args - The arguments provided to the command ([site]).
   * @param {Object} slackContext - The Slack context object.
   * @param {Function} slackContext.say - The Slack say function.
   * @returns {Promise} A promise that resolves when the operation is complete.
   */
  const handleExecution = async (args, slackContext) => {
    const { say, files, botToken } = slackContext;

    await say(`:bug: DEBUG: handleExecution called with args: ${JSON.stringify(args)}`);

    try {
      // Parse keyword arguments
      const { keywords, positionalArgs } = parseKeywordArguments(args, say);

      await say(`:bug: DEBUG: Parsed keywords: ${JSON.stringify(keywords)}`);
      await say(`:bug: DEBUG: Parsed positionalArgs: ${JSON.stringify(positionalArgs)}`);

      // Determine if we're using keyword format or positional format
      const isKeywordFormat = Object.keys(keywords).length > 0;
      await say(`:bug: DEBUG: Using keyword format: ${isKeywordFormat}`);

      let baseURLInputArg;
      let auditTypeInputArg;
      let auditDataInputArg;

      if (isKeywordFormat) {
        // New keyword format: site audit:type date-start:value source:value
        [baseURLInputArg] = positionalArgs;
        auditTypeInputArg = keywords.audit;

        await say(`:bug: DEBUG: Keyword format - baseURLInputArg: ${baseURLInputArg}`);
        await say(`:bug: DEBUG: Keyword format - auditTypeInputArg: ${auditTypeInputArg}`);

        // Build audit data from remaining keywords (excluding 'audit')
        const auditDataKeywords = { ...keywords };
        delete auditDataKeywords.audit;

        await say(`:bug: DEBUG: Audit data keywords: ${JSON.stringify(auditDataKeywords)}`);

        auditDataInputArg = Object.keys(auditDataKeywords).length > 0
          ? JSON.stringify(auditDataKeywords)
          : undefined;

        await say(`:bug: DEBUG: Final auditDataInputArg: ${auditDataInputArg}`);
      } else {
        // Old positional format: site auditType auditData
        [baseURLInputArg, auditTypeInputArg, auditDataInputArg] = positionalArgs;

        await say(`:bug: DEBUG: Positional format - baseURLInputArg: ${baseURLInputArg}`);
        await say(`:bug: DEBUG: Positional format - auditTypeInputArg: ${auditTypeInputArg}`);
        await say(`:bug: DEBUG: Positional format - auditDataInputArg: ${auditDataInputArg}`);
      }

      const hasFiles = isNonEmptyArray(files);
      const baseURL = extractURLFromSlackInput(baseURLInputArg);
      const hasValidBaseURL = isValidUrl(baseURL);

      await say(`:bug: DEBUG: hasFiles: ${hasFiles}`);
      await say(`:bug: DEBUG: baseURL extracted: ${baseURL}`);
      await say(`:bug: DEBUG: hasValidBaseURL: ${hasValidBaseURL}`);

      if (!hasValidBaseURL && !hasFiles) {
        await say(':bug: DEBUG: No valid baseURL and no files - showing usage');
        await say(baseCommand.usage());
        return;
      }

      if (hasValidBaseURL && hasFiles) {
        await say(':warning: Please provide either a baseURL or a CSV file with a list of site URLs.');
        return;
      }

      if (hasFiles) {
        await say(':bug: DEBUG: Processing files');
        const [, auditTypeInput, auditData] = ['', baseURLInputArg, auditTypeInputArg];
        const auditType = auditTypeInput || LHS_MOBILE;

        await say(`:bug: DEBUG: File processing - auditType: ${auditType}, auditData: ${auditData}`);

        if (files.length > 1) {
          await say(':warning: Please provide only one CSV file.');
          return;
        }

        const file = files[0];
        if (!file.name.endsWith('.csv')) {
          await say(':warning: Please provide a CSV file.');
          return;
        }

        const csvData = await parseCSV(file, botToken);

        say(`:adobe-run: Triggering ${auditType} audit for ${csvData.length} sites.`);

        await Promise.all(
          csvData.map(async (row) => {
            const [csvBaseURL] = row;
            if (isValidUrl(csvBaseURL)) {
              await runAuditForSite(csvBaseURL, auditType, auditData, slackContext);
            } else {
              await say(`:warning: Invalid URL found in CSV file: ${csvBaseURL}`);
            }
          }),
        );
      } else if (hasValidBaseURL) {
        await say(':bug: DEBUG: Processing single baseURL');
        const auditType = auditTypeInputArg || LHS_MOBILE;
        await say(`:bug: DEBUG: Single URL processing - auditType: ${auditType}, auditDataInputArg: ${auditDataInputArg}`);
        await runAuditForSite(baseURL, auditType, auditDataInputArg, slackContext);
      }
    } catch (error) {
      await say(`:bug: DEBUG: Error caught in handleExecution: ${error.message}`);
      await say(`:bug: DEBUG: Error stack: ${error.stack}`);
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

export default RunAuditCommand;
