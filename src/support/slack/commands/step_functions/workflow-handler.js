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

/**
 * Lambda function to handle the onboarding workflow
 *
 * This function triggers a Step Functions state machine to orchestrate the long-running
 * processes (onboard, import, scrape, audit) to avoid the 15-minute Lambda timeout.
 *
 * @param {Object} event - Lambda event object
 * @param {string} event.siteUrl - URL of the site to onboard
 * @param {string} event.imsOrgId - IMS organization ID
 * @param {string} [event.profile='default'] - Profile name to use
 * @param {string} [event.slackChannel] - Slack channel to send notifications to
 * @param {Array<string>} [event.importTypes] - Array of import types to run
 * @param {Array<string>} [event.auditTypes] - Array of audit types to run
 * @returns {Object} - Result of the workflow execution
 */

import dataAccess from '@adobe/spacecat-shared-data-access';
import { Config } from '@adobe/spacecat-shared-data-access/src/models/site/config.js';
import { BaseSlackClient, SLACK_TARGETS } from '@adobe/spacecat-shared-slack-client';
import RunScrape from '../run-scrape.js';
import RunImport from '../run-import.js';
import RunAudit from '../run-audit.js';

/**
 * Create a context for Slack notifications
 *
 * @param {string} channel - Slack channel ID
 * @param {string} botToken - Slack bot token
 * @returns {Object} - Slack context
 * @throws {Error} If channel or botToken is not provided
 */
function createSlackContext(channel, botToken) {
  // Validate required parameters
  if (!channel) {
    throw new Error('Slack channel ID is required for notifications. Check that slackChannel is provided in the workflow input.');
  }

  if (!botToken) {
    throw new Error('Slack bot token is required for notifications. Check that botToken is provided in the workflow input.');
  }

  // Create context object with environment variables for BaseSlackClient
  const context = {
    env: {
      SLACK_BOT_TOKEN: botToken,
    },
  };

  // Use BaseSlackClient from shared library, following the pattern used elsewhere in the codebase
  const slackClient = BaseSlackClient.createFrom(context, SLACK_TARGETS.WORKSPACE_STANDARD);

  return {
    say: async (message) => {
      if (typeof message === 'string') {
        await slackClient.postMessage({
          channel,
          text: message,
        });
      } else {
        await slackClient.postMessage({
          channel,
          ...message,
        });
      }
    },
    channel: { id: channel },
  };
}

/**
 * Process all imports for a site in batch mode for each import type.
 * Note: Each handleExecution call will trigger a separate Lambda invocation.
 *
 * @param {string} siteUrl - The site URL
 * @param {string} imsOrgId - The IMS organization ID
 * @param {string} profile - The profile to use
 * @param {Array<string>} importTypes - Array of import types to process
 * @param {Object} slackContext - The Slack context for notifications
 * @param {Object} context - The context for the workflow
 * @returns {Promise<Object>} - Result of batch import processing
 */
async function processBatchImports(siteUrl, imsOrgId, profile, importTypes, slackContext, context) {
  const { Site } = dataAccess;
  const { say } = slackContext;

  if (!importTypes || importTypes.length === 0) {
    return {
      success: true,
      message: 'No import types to process',
      processedImports: [],
    };
  }

  try {
    await say(`:rocket: Starting batch imports for ${siteUrl}: ${importTypes.join(', ')}`);

    // Load the site from the database - site is already validated in onboard.js
    const site = await Site.findByBaseURL(siteUrl);
    const baseURL = site.getBaseURL();

    // Initialize the import handler
    const runImport = RunImport(context);

    // Process all import types in parallel using Promise.all
    const importPromises = importTypes.map(async (importType) => {
      try {
        // Call the handleExecution method directly - this will trigger a Lambda invocation
        const result = await runImport.handleExecution([
          importType,
          baseURL,
          profile.imports[importType].startDate,
          profile.imports[importType].endDate,
        ], slackContext);

        return {
          siteUrl,
          imsOrgId,
          importType,
          success: true,
          result,
        };
      } catch (error) {
        return {
          siteUrl,
          imsOrgId,
          importType,
          success: false,
          error: error.message,
        };
      }
    });

    // Wait for all imports to complete in parallel
    const results = await Promise.all(importPromises);

    // Count successes and failures
    const successResults = results.filter((r) => r.success);
    const errorResults = results.filter((r) => !r.success);
    const successCount = successResults.length;
    const failureCount = errorResults.length;

    // Notify completion of batch import process
    let statusMessage;
    if (failureCount === 0) {
      statusMessage = `:white_check_mark: Successfully processed all ${successCount} imports for ${siteUrl}`;
    } else if (successCount === 0) {
      statusMessage = `:x: Failed to process all ${failureCount} imports for ${siteUrl}`;
    } else {
      statusMessage = `:warning: Processed ${successCount} imports successfully and ${failureCount} with errors for ${siteUrl}`;
    }

    await say(statusMessage);

    return {
      success: successCount > 0,
      message: statusMessage,
      siteUrl,
      imsOrgId,
      results: successResults,
      errors: errorResults,
      successCount,
      failureCount,
    };
  } catch (error) {
    await say(`:x: Error in batch import process for ${siteUrl}: ${error.message}`);
    throw error;
  }
}

/**
 * Process all audits for a site in batch for each audit type.
 * Note: Each handleExecution call will trigger a separate Lambda invocation.
 *
 * @param {string} siteUrl - The site URL
 * @param {string} imsOrgId - The IMS organization ID
 * @param {Array<string>} auditTypes - Array of audit types to process
 * @param {Object} slackContext - The Slack context for notifications
 * @param {Object} context - The context for the workflow
 * @returns {Promise<Object>} - Result of batch audit processing
 */
async function processBatchAudits(siteUrl, imsOrgId, auditTypes, slackContext, context) {
  const { Site } = dataAccess;
  const { say } = slackContext;

  if (!auditTypes || auditTypes.length === 0) {
    return {
      success: true,
      message: 'No audit types to process',
      processedAudits: [],
    };
  }

  try {
    // Use simpler notification with slackContext.say
    await say(`:rocket: Starting batch audits for site ${siteUrl}: ${auditTypes.join(', ')}`);

    const site = await Site.findByBaseURL(siteUrl);
    const baseURL = site.getBaseURL();

    // Initialize the audit handler
    const runAudit = RunAudit(context);

    // Process all audit types in parallel using Promise.all
    const auditPromises = auditTypes.map(async (auditType) => {
      try {
        // Call the handleExecution method directly - this will trigger a Lambda invocation
        const result = await runAudit.handleExecution([
          baseURL,
          auditType,
        ], slackContext);

        return {
          siteUrl,
          imsOrgId,
          auditType,
          success: true,
          result,
        };
      } catch (error) {
        return {
          siteUrl,
          imsOrgId,
          auditType,
          success: false,
          error: error.message,
        };
      }
    });

    // Wait for all audits to complete in parallel
    const results = await Promise.all(auditPromises);

    // Count successes and failures
    const successResults = results.filter((r) => r.success);
    const errorResults = results.filter((r) => !r.success);
    const successCount = successResults.length;
    const failureCount = errorResults.length;

    // Notify completion of batch audit process
    let statusMessage;
    if (failureCount === 0) {
      statusMessage = `:white_check_mark: Successfully initiated all ${successCount} audits for ${siteUrl}`;
    } else if (successCount === 0) {
      statusMessage = `:x: Failed to initiate all ${failureCount} audits for ${siteUrl}`;
    } else {
      statusMessage = `:warning: Initiated ${successCount} audits successfully and ${failureCount} with errors for ${siteUrl}`;
    }

    await say(statusMessage);

    return {
      success: successCount > 0,
      message: statusMessage,
      siteUrl,
      imsOrgId,
      results: successResults,
      errors: errorResults,
      successCount,
      failureCount,
    };
  } catch (error) {
    // Use simpler notification with slackContext.say for error
    await say(`:x: Error in batch audit process for ${siteUrl}: ${error.message}`);
    throw error;
  }
}

/**
 * Disables imports and audits for a site at the end of the workflow
 *
 * @param {string} siteUrl - The site URL
 * @param {string} imsOrgId - The IMS organization ID
 * @param {Array<string>} importTypes - Array of import types to disable
 * @param {Array<string>} auditTypes - Array of audit types to disable
 * @param {Object} slackContext - The Slack context for notifications
 * @returns {Promise<Object>} - Result of disabling imports and audits
 */
async function disableImportsAndAudits(siteUrl, imsOrgId, importTypes, auditTypes, slackContext) {
  const { say } = slackContext;
  const { Site, Configuration } = dataAccess;

  try {
    await say(`:gear: Disabling imports and audits for ${siteUrl}`);

    // Load the site from the database - site is already validated in onboard.js
    const site = await Site.findByBaseURL(siteUrl);
    const configuration = await Configuration.findLatest();
    const siteConfig = site.getConfig();

    // 1. Disable all imports in the site config in parallel (though this is just a local operation)
    importTypes.forEach((importType) => {
      siteConfig.disableImport(importType);
    });

    // 2. Save the site config
    site.setConfig(Config.toDynamoItem(siteConfig));
    await site.save();

    // 3. Disable all audits for the site in the configuration in parallel
    auditTypes.forEach((auditType) => {
      configuration.disableHandlerForSite(auditType, site);
    });

    // 4. Update site config and save configuration
    // These DB operations can't be parallelized due to potential conflicts
    await Site.updateSiteConfig(site.getId(), siteConfig);
    await configuration.save();

    // Notify completion
    await say(`:white_check_mark: Successfully disabled imports and audits for ${siteUrl}`);
    await say(':tada: Workflow completed successfully!');

    return {
      success: true,
      message: 'Successfully disabled imports and audits',
      siteUrl,
      imsOrgId,
      disabledImports: importTypes,
      disabledAudits: auditTypes,
    };
  } catch (error) {
    await say(`:x: Error disabling imports and audits for ${siteUrl}: ${error.message}`);
    throw error;
  }
}

/**
 * Handles specific workflow commands
 *
 * @param {string} command - The command to execute
 * @param {Object} params - Command parameters
 * @param {string} params.siteUrl - The site URL
 * @param {string} params.imsOrgId - The IMS organization ID
 * @param {string} params.profile - The profile to use
 * @param {string} params.slackChannel - The Slack channel for notifications
 * @param {string} params.botToken - Slack bot token
 * @param {Array<string>} [params.importTypes] - Array of import types to process
 * @param {Array<string>} [params.auditTypes] - Array of audit types to process
 * @param {Object} slackContext - The Slack context for sending notifications
 * @returns {Promise<Object>} - Command execution result
 */
async function handleWorkflowCommand(command, params, slackContext) {
  const {
    siteUrl,
    imsOrgId,
    profile,
    importTypes,
    auditTypes,
  } = params;

  const { say } = slackContext;

  // Create a context with dataAccess
  const context = {
    dataAccess,
  };

  switch (command) {
    case 'run-batch-imports': {
      const importResults = await processBatchImports(
        siteUrl,
        imsOrgId,
        profile,
        importTypes,
        slackContext,
        context,
      );
      await say(':hourglass: Import operations initiated. Waiting 20 minutes for them to complete...');
      return {
        statusCode: 200,
        body: {
          message: 'Successfully processed batch imports',
          siteUrl,
          imsOrgId,
          results: importResults,
        },
      };
    }

    case 'run-scrape': {
      try {
        const { Site } = dataAccess;
        const site = await Site.findByBaseURL(siteUrl);
        const baseURL = site.getBaseURL();
        const runScrape = RunScrape(context);
        // Execute the scrape command directly
        const result = await runScrape.handleExecution([
          baseURL,
        ], slackContext);

        await say(':hourglass: Scrape operation initiated. Waiting 20 minutes for it to complete...');
        return {
          statusCode: 200,
          body: {
            message: 'Scrape initiated successfully',
            siteUrl,
            imsOrgId,
            result,
          },
        };
      } catch (error) {
        return {
          statusCode: 500,
          body: {
            error: `Scrape failed: ${error.message}`,
            siteUrl,
            imsOrgId,
          },
        };
      }
    }

    case 'run-batch-audits': {
      const auditResults = await processBatchAudits(
        siteUrl,
        imsOrgId,
        auditTypes,
        slackContext,
        context,
      );
      await say(':hourglass: Audit operations initiated. Waiting 30 minutes for them to complete...');
      return {
        statusCode: 200,
        body: {
          message: 'Successfully processed batch audits',
          siteUrl,
          imsOrgId,
          results: auditResults,
        },
      };
    }

    case 'disable-imports-audits': {
      const disableResults = await disableImportsAndAudits(
        siteUrl,
        imsOrgId,
        importTypes,
        auditTypes,
        slackContext,
      );
      return {
        statusCode: 200,
        body: {
          message: 'Successfully disabled imports and audits',
          siteUrl,
          imsOrgId,
          results: disableResults,
        },
      };
    }

    default: {
      const errorMessage = `Unknown command: '${command}'. Supported commands are: run-scrape, run-batch-imports, run-batch-audits, disable-imports-audits.`;
      await say(`:x: ${errorMessage}`);
      throw new Error(errorMessage);
    }
  }
}

/**
 * Lambda handler function for workflow processing
 *
 * @param {Object} event - Lambda event object
 * @param {string} event.siteUrl - URL of the site to onboard
 * @param {string} event.imsOrgId - IMS organization ID
 * @param {string} [event.profile='default'] - Profile name to use
 * @param {string} [event.slackChannel] - Slack channel to send notifications to
 * @param {string} [event.botToken] - Slack bot token for notifications
 * @param {Array<string>} [event.importTypes] - Array of import types to run
 * @param {Array<string>} [event.auditTypes] - Array of audit types to run
 * @param {string} [event.command] - Command to execute (onboard, import, audit)
 * @returns {Object} - Result of the workflow execution
 */
export async function handler(event) {
  const {
    siteUrl,
    imsOrgId,
    profile = 'default',
    slackChannel,
    botToken = process.env.SLACK_BOT_TOKEN,
    importTypes = [],
    auditTypes = [],
    command,
  } = event;

  const slackContext = createSlackContext(slackChannel, botToken);
  const { say } = slackContext;

  try {
    // If no command is specified, return an error
    if (!command) {
      const validCommands = ['run-batch-imports', 'run-scrape', 'run-batch-audits', 'disable-imports-audits'];
      await say(`:warning: Command parameter is required. Please specify one of: *${validCommands.join(', ')}*`);
      return {
        status: 'error',
        message: `Command parameter is required. Valid commands: ${validCommands.join(', ')}`,
        validCommands,
      };
    }

    // Process command
    return await handleWorkflowCommand(command, {
      siteUrl,
      imsOrgId,
      profile,
      importTypes,
      auditTypes,
    }, slackContext);
  } catch (error) {
    await say(`:x: Workflow failed for ${siteUrl}: ${error.message}`);
    return {
      status: 'error',
      message: `Workflow failed for ${siteUrl}: ${error.message}`,
      error: error.message,
    };
  }
}

// Export named functions for testing and reuse
export {
  handleWorkflowCommand,
  processBatchImports,
  processBatchAudits,
  disableImportsAndAudits,
};
