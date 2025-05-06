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
 * @param {string} [event.slackChannel] - Slack channel to send notifications to
 * @param {Array<string>} [event.importTypes] - Array of import types to run
 * @param {Array<string>} [event.auditTypes] - Array of audit types to run
 * @returns {Object} - Result of the workflow execution
 */

import dataAccess from '@adobe/spacecat-shared-data-access';
import { Config } from '@adobe/spacecat-shared-data-access/src/models/site/config.js';
import { BaseSlackClient, SLACK_TARGETS } from '@adobe/spacecat-shared-slack-client';
import RunScrape from '../run-scrape.js';
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
 * Process all audits for a site in batch for each audit type.
 *
 * @param {string} siteUrl - The site URL
 * @param {string} imsOrgId - The IMS organization ID
 * @param {Array<string>} auditTypes - Array of audit types to process
 * @param {Object} slackContext - The Slack context for notifications
 * @param {Object} context - The context for the workflow
 * @returns {Promise<Object>} - Result of batch audit processing
 */
async function processBatchAudits(siteUrl, imsOrgId, auditTypes, slackContext, context) {
  const { say } = slackContext;

  try {
    await say(`:rocket: Starting batch audits for site ${siteUrl}: ${auditTypes.join(', ')}`);

    const runAudit = RunAudit(context);
    const auditPromises = auditTypes.map(async (auditType) => {
      try {
        const result = await runAudit.handleExecution([
          siteUrl,
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

    const statusMessage = `:hourglass: Initiated audits ${auditTypes} for ${siteUrl}`;
    await say(statusMessage);

    return {
      siteUrl,
      imsOrgId,
      message: statusMessage,
      results,
    };
  } catch (error) {
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

    // TODO: verify - 4. Update site config and save configuration
    // These DB operations can't be parallelized due to potential conflicts
    await Site.updateSiteConfig(site.getId(), siteConfig);
    await configuration.save();

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
 * @param {string} params.slackChannel - The Slack channel for notifications
 * @param {string} params.botToken - Slack bot token
 * @param {Array<string>} [params.importTypes] - Array of import types to process
 * @param {Array<string>} [params.auditTypes] - Array of audit types to process
 * @param {string} [params.message] - The error message to send
 * @param {Object} slackContext - The Slack context for sending notifications
 * @returns {Promise<Object>} - Command execution result
 */
async function handleWorkflowCommand(command, params, slackContext) {
  const {
    siteUrl,
    imsOrgId,
    importTypes,
    auditTypes,
    message,
  } = params;

  const { say } = slackContext;

  // Create a context with dataAccess
  const context = {
    dataAccess,
  };

  switch (command) {
    case 'notify': {
      const formattedMessage = `:x: ${message}`;
      await say(formattedMessage);
      return {
        statusCode: 200,
        body: {
          message: 'Error notification sent',
          sentMessage: formattedMessage,
        },
      };
    }

    case 'run-scrape': {
      try {
        const runScrape = RunScrape(context);
        const result = await runScrape.handleExecution([
          siteUrl,
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
      const validCommands = ['run-scrape', 'run-batch-audits', 'disable-imports-audits', 'notify'];
      const errorMessage = `Unknown command: '${command}'. Supported commands are: ${validCommands.join(', ')}.`;
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
 * @param {string} [event.slackChannel] - Slack channel to send notifications to
 * @param {string} [event.botToken] - Slack bot token for notifications
 * @param {Array<string>} [event.importTypes] - Array of import types to run
 * @param {Array<string>} [event.auditTypes] - Array of audit types to run
 * @param {string} [event.command] - Command to execute (onboard, import, audit)
 * @param {string} [event.message] - The message to send
 * @returns {Object} - Result of the workflow execution
 */
export async function handler(event) {
  const {
    siteUrl,
    imsOrgId,
    slackChannel,
    botToken = process.env.SLACK_BOT_TOKEN,
    importTypes = [],
    auditTypes = [],
    command,
    message,
  } = event;

  const slackContext = createSlackContext(slackChannel, botToken);
  const { say } = slackContext;

  try {
    // If no command is specified, return an error
    if (!command) {
      const validCommands = ['run-scrape', 'run-batch-audits', 'disable-imports-audits', 'notify'];
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
      importTypes,
      auditTypes,
      message,
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
  processBatchAudits,
  disableImportsAndAudits,
};
