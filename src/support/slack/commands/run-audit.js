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
import TierClient from '@adobe/spacecat-shared-tier-client';

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
  'product-metatags',
  'structured-data',
  'forms-opportunities',
  'alt-text',
  'prerender',
  'summarization',
];

/**
 * Parses keyword arguments from command input.
 * Supports formats like "audit:geo-brand-presence", "audit: geo-brand-presence",
 * "date-start:2025-09-07", "source:google-ai-overviews"
 * Handles Slack-formatted URLs like <http://example.com|example.com>
 * @param {string[]} args - The command arguments
 * @returns {Object} Parsed arguments with keywords and remaining positional args
 */
const parseKeywordArguments = (args) => {
  const keywords = {};
  const positionalArgs = [];

  args.forEach((arg) => {
    // Check if this is any type of URL (focused on HTTP/HTTPS only)
    const isAnyUrl = arg && (
      arg.startsWith('<http')
      || arg.startsWith('http://')
      || arg.startsWith('https://')
    );

    if (arg && arg.includes(':') && !isAnyUrl) {
      const [key, ...valueParts] = arg.split(':');
      const value = valueParts.join(':').trim(); // Handle cases where value contains colons and trim whitespace
      keywords[key] = value;
    } else {
      positionalArgs.push(arg);
    }
  });

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
    description: 'Run audit for a previously added site. Supports both positional and keyword arguments. Runs lhs-mobile by default if no audit type is specified. Use `audit:all` to run all audits. Use `product-metatags` for Product Detail Page (PDP) analysis of commerce sites.',
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

    try {
      const site = await Site.findByBaseURL(baseURL);
      const configuration = await Configuration.findLatest();

      if (!isNonEmptyObject(site)) {
        await postSiteNotFoundMessage(say, baseURL);
        return;
      }

      if (auditType === 'all') {
        // const enabledAudits = configuration.getEnabledAuditsForSite(site);
        const enabledAudits = ALL_AUDITS.filter(
          (audit) => configuration.isHandlerEnabledForSite(audit, site),
        );

        if (!isNonEmptyArray(enabledAudits)) {
          await say(`:warning: No audits configured for site \`${baseURL}\``);
          return;
        }

        await Promise.all(
          enabledAudits.map(async (enabledAuditType) => {
            try {
              await triggerAuditForSite(site, enabledAuditType, undefined, slackContext, context);
            } catch (error) {
              log.error(`Error running audit ${enabledAuditType.id} for site ${baseURL}`, error);
              await postErrorMessage(say, error);
            }
          }),
        );
      } else {
        if (!configuration.isHandlerEnabledForSite(auditType, site)) {
          await say(`:x: Will not audit site '${baseURL}' because audits of type '${auditType}' are disabled for this site.`);
          return;
        }
        const handler = configuration.getHandlers()?.[auditType];
        // Exit early with error if handler has no product codes configured
        if (!isNonEmptyArray(handler?.productCodes)) {
          await say(`:x: Will not audit site '${baseURL}' because no product codes are configured for audit type '${auditType}'.`);
          return;
        }

        // Check entitlements for all product codes
        const entitlementChecks = await Promise.all(
          handler.productCodes.map(async (productCode) => {
            try {
              const tierClient = await TierClient.createForSite(context, site, productCode);
              const tierResult = await tierClient.checkValidEntitlement();
              return tierResult.entitlement || false;
            } catch (error) {
              context.log.error(`Failed to check entitlement for product code ${productCode}:`, error);
              return false;
            }
          }),
        );

        // Block audit if site has no entitlement for any of the product codes
        if (!entitlementChecks.some((hasEntitlement) => hasEntitlement)) {
          await say(`:x: Will not audit site '${baseURL}' because site is not entitled for this audit.`);
          return;
        }

        await triggerAuditForSite(site, auditType, auditData, slackContext, context);
      }
    } catch (error) {
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

    try {
      // Parse keyword arguments
      const { keywords, positionalArgs } = parseKeywordArguments(args);

      // Determine if we're using keyword format or positional format
      const isKeywordFormat = Object.keys(keywords).length > 0;

      let baseURLInputArg;
      let auditTypeInputArg;
      let auditDataInputArg;

      if (isKeywordFormat) {
        // New keyword format: site audit:type date-start:value source:value
        [baseURLInputArg] = positionalArgs;
        auditTypeInputArg = keywords.audit;

        // Build audit data from remaining keywords (excluding 'audit')
        const auditDataKeywords = { ...keywords };
        delete auditDataKeywords.audit;

        auditDataInputArg = Object.keys(auditDataKeywords).length > 0
          ? JSON.stringify(auditDataKeywords)
          : undefined;
      } else {
        // Old positional format: site auditType auditData
        [baseURLInputArg, auditTypeInputArg, auditDataInputArg] = positionalArgs;
      }

      log.info(`run-audit: baseURL="${baseURLInputArg}", auditType="${auditTypeInputArg}", auditData="${auditDataInputArg}"`);

      const hasFiles = isNonEmptyArray(files);
      const baseURL = extractURLFromSlackInput(baseURLInputArg);
      const hasValidBaseURL = isValidUrl(baseURL);

      if (!hasValidBaseURL && !hasFiles) {
        await say(baseCommand.usage());
        return;
      }

      if (hasValidBaseURL && hasFiles) {
        await say(':warning: Please provide either a baseURL or a CSV file with a list of site URLs.');
        return;
      }

      if (hasFiles) {
        const [, auditTypeInput, auditData] = ['', baseURLInputArg, auditTypeInputArg];
        const auditType = auditTypeInput || LHS_MOBILE;

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
        const auditType = auditTypeInputArg || LHS_MOBILE;
        say(`:adobe-run: Triggering ${auditType} audit for ${baseURL}`);
        await runAuditForSite(baseURL, auditType, auditDataInputArg, slackContext);
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

export default RunAuditCommand;
