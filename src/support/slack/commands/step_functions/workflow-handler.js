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
/* c8 ignore start */
import dataAccess from '@adobe/spacecat-shared-data-access';
import { BaseSlackClient, SLACK_TARGETS } from '@adobe/spacecat-shared-slack-client';
import RunScrape from '../run-scrape.js';
import RunAudit from '../run-audit.js';
import ToggleImports from '../toggle-site-import.js';
import ToggleAudits from '../toggle-site-audit.js';

/**
 * Create a context for Slack notifications
 *
 * @param {string} channel - Slack channel ID
 * @returns {Object} - Slack context
 * @throws {Error} If channel is not provided
 */
function createSlackContext(channel) {
  console.log('Creating Slack context with channel:', channel);
  // Validate required parameters
  if (!channel) {
    throw new Error('Slack channel ID is required for notifications. Check that slackChannel is provided in the workflow input.');
  }

  // Get the Slack token from the environment
  const slackBotToken = process.env.SLACK_BOT_TOKEN;
  console.log('SLACK_BOT_TOKEN:', slackBotToken ? 'Available' : 'Missing');
  if (!slackBotToken) {
    throw new Error('SLACK_BOT_TOKEN environment variable is missing. This should be configured in the Lambda environment.');
  }

  // Create a Lambda-compatible context with environment variables
  // The BaseSlackClient requires specific environment variables to function correctly
  const lambdaContext = {
    env: {
      SLACK_BOT_TOKEN: slackBotToken,
      // Map SLACK_BOT_TOKEN to what BaseSlackClient expects for WORKSPACE_INTERNAL
      SLACK_TOKEN_WORKSPACE_INTERNAL: slackBotToken,
      SLACK_OPS_CHANNEL_WORKSPACE_INTERNAL: channel,
    },
  };

  // Create the Slack client using the shared client library
  // Using WORKSPACE_INTERNAL as it matches what's defined in the library
  const slackClient = BaseSlackClient.createFrom(lambdaContext, SLACK_TARGETS.WORKSPACE_INTERNAL);

  // Create a Slack context object with the necessary methods for command execution
  // This matches the structure expected by other command handlers
  return {
    say: async (message) => {
      try {
        console.log(`Attempting to send Slack message to channel ${channel}`);
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
        console.log('Slack message sent successfully');
      } catch (error) {
        console.error(`Error sending Slack message: ${error.message}`);
        console.error(error.stack);
        // Don't throw the error so workflow can continue even if Slack notification fails
      }
    },
    channel: { id: channel },
    channelId: channel,
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
 * @param {Object} context - The context for the workflow
 * @returns {Promise<Object>} - Result of disabling imports and audits
 */
async function disable(siteUrl, imsOrgId, importTypes, auditTypes, slackContext, context) {
  const { say } = slackContext;

  try {
    await say(`:gear: Disabling imports and audits for ${siteUrl}`);

    const toggleImports = ToggleImports(context);
    const disableImport = 'disable';

    const importPromises = importTypes.map(async (importType) => {
      const result = await toggleImports.handleExecution([
        disableImport,
        siteUrl,
        importType,
      ], slackContext);
      return { importType, result };
    });
    const importResults = await Promise.all(importPromises);

    const toggleAudits = ToggleAudits(context);
    const disableAudit = 'disable';

    const auditPromises = auditTypes.map(async (auditType) => {
      const result = await toggleAudits.handleExecution([
        disableAudit,
        siteUrl,
        auditType,
      ], slackContext);
      return { auditType, result };
    });
    const auditResults = await Promise.all(auditPromises);

    await say(`:white_check_mark: Successfully disabled imports and audits for ${siteUrl}`);
    await say(':tada: Workflow completed successfully!');

    return {
      success: true,
      message: 'Successfully disabled imports and audits',
      siteUrl,
      imsOrgId,
      disabledImports: importTypes,
      disabledAudits: auditTypes,
      importResults,
      auditResults,
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
 * @param {string} params.message - The error message to send
 * @param {Object} slackContext - The Slack context for sending notifications
 * @returns {Promise<Object>} - Command execution result
 */
async function handleWorkflowCommand(command, params, slackContext) {
  console.log(`Handling workflow command: ${command} with params:`, JSON.stringify(params, null, 2));

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
      try {
        const formattedMessage = `:x: ${message}`;
        console.log(`Sending notification message: ${formattedMessage}`);
        await say(formattedMessage);
        return {
          statusCode: 200,
          body: {
            message: 'Error notification sent',
            sentMessage: formattedMessage,
          },
        };
      } catch (error) {
        console.error(`Error in notify command: ${error.message}`);
        return {
          statusCode: 500,
          body: {
            error: `Failed to send notification: ${error.message}`,
          },
        };
      }
    }

    case 'run-scrape': {
      try {
        console.log(`Initiating scrape for site: ${siteUrl}`);
        const runScrape = RunScrape(context);
        const result = await runScrape.handleExecution([
          siteUrl,
        ], slackContext);

        console.log('Scrape initiated successfully');
        await say(':hourglass: Scrape operation initiated. Waiting 20 minutes for it to complete...');
        return {
          statusCode: 200,
          body: {
            message: 'Scrape initiated successfully',
            siteUrl,
            imsOrgId,
            result,
            lambda: 'spacecat-api-service',
          },
        };
      } catch (error) {
        console.error(`Error in run-scrape command: ${error.message}`);
        console.error(error.stack);
        await say(`:x: Scrape failed for ${siteUrl}: ${error.message}`);
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
      try {
        console.log(`Initiating batch audits for site: ${siteUrl}, audit types: ${auditTypes.join(', ')}`);
        const auditResults = await processBatchAudits(
          siteUrl,
          imsOrgId,
          auditTypes,
          slackContext,
          context,
        );
        console.log('Batch audits initiated successfully');
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
      } catch (error) {
        console.error(`Error in run-batch-audits command: ${error.message}`);
        console.error(error.stack);
        await say(`:x: Batch audit failed for ${siteUrl}: ${error.message}`);
        return {
          statusCode: 500,
          body: {
            error: `Batch audit failed: ${error.message}`,
            siteUrl,
            imsOrgId,
          },
        };
      }
    }

    case 'disable-imports-audits': {
      try {
        console.log(`Disabling imports and audits for site: ${siteUrl}`);
        const disableResults = await disable(
          siteUrl,
          imsOrgId,
          importTypes,
          auditTypes,
          slackContext,
          context,
        );
        console.log('Successfully disabled imports and audits');
        return {
          statusCode: 200,
          body: {
            message: 'Successfully disabled imports and audits',
            siteUrl,
            imsOrgId,
            results: disableResults,
          },
        };
      } catch (error) {
        console.error(`Error in disable-imports-audits command: ${error.message}`);
        console.error(error.stack);
        await say(`:x: Failed to disable imports and audits for ${siteUrl}: ${error.message}`);
        return {
          statusCode: 500,
          body: {
            error: `Disable imports and audits failed: ${error.message}`,
            siteUrl,
            imsOrgId,
          },
        };
      }
    }

    default: {
      const validCommands = ['run-scrape', 'run-batch-audits', 'disable-imports-audits', 'notify'];
      const errorMessage = `Unknown command: '${command}'. Supported commands are: ${validCommands.join(', ')}.`;
      console.error(errorMessage);
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
 * @param {string} [event.command] - Command to execute (onboard, import, audit)
 * @param {string} [event.message] - The message to send
 * @returns {Object} - Result of the workflow execution
 */
export async function handler(event) {
  try {
    console.log('Step Functions workflow handler invoked with event:', JSON.stringify(event, null, 2));

    const {
      siteUrl,
      imsOrgId,
      slackChannel,
      importTypes = [],
      auditTypes = [],
      command,
      message,
    } = event;

    // First create the Slack context for notifications
    let slackContext;
    try {
      console.log('Creating Slack context for channel:', slackChannel);
      slackContext = createSlackContext(slackChannel);
      console.log('Slack context created successfully');
    } catch (slackError) {
      console.error('Error creating Slack context:', slackError.message);
      console.error(slackError.stack);
      return {
        status: 'error',
        message: `Failed to create Slack context: ${slackError.message}`,
        error: slackError.message,
      };
    }

    const { say } = slackContext;

    try {
      // If no command is specified, return an error
      if (!command) {
        const validCommands = ['run-scrape', 'run-batch-audits', 'disable-imports-audits', 'notify'];
        console.warn('No command specified in event');
        await say(`:warning: Command parameter is required. Please specify one of: *${validCommands.join(', ')}*`);
        return {
          status: 'error',
          message: `Command parameter is required. Valid commands: ${validCommands.join(', ')}`,
          validCommands,
        };
      }

      console.log(`Executing command: ${command}`);
      // Process command
      return await handleWorkflowCommand(command, {
        siteUrl,
        imsOrgId,
        importTypes,
        auditTypes,
        message,
      }, slackContext);
    } catch (error) {
      console.error(`Error during workflow execution: ${error.message}`);
      console.error(error.stack);
      await say(`:x: Workflow failed for ${siteUrl}: ${error.message}`);
      return {
        status: 'error',
        message: `Workflow failed for ${siteUrl}: ${error.message}`,
        error: error.message,
      };
    }
  } catch (error) {
    console.error('Unhandled error in workflow handler:', error.message);
    console.error(error.stack);
    return {
      status: 'error',
      message: `Unhandled error in workflow handler: ${error.message}`,
      error: error.message,
    };
  }
}

// Export named functions for testing and reuse
export {
  handleWorkflowCommand,
  processBatchAudits,
  disable,
};
/* c8 ignore end */
