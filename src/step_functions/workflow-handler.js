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
import RunScrape from '../support/slack/commands/run-scrape.js';
import RunAudit from '../support/slack/commands/run-audit.js';
import ToggleImports from '../support/slack/commands/toggle-site-import.js';
import ToggleAudits from '../support/slack/commands/toggle-site-audit.js';

/**
 * Create a context for Slack notifications
 *
 * @param {string} channel - Slack channel ID
 * @returns {Object} - Slack context
 * @throws {Error} If channel is not provided
 */
function createSlackContext(channel) {
  console.log(`Creating Slack context for channel: ${channel}`);
  // Validate required parameters
  if (!channel) {
    throw new Error('Slack channel ID is required for notifications. Check that slackChannel is provided in the workflow input.');
  }

  // Get the Slack token from the environment
  const slackBotToken = process.env.SLACK_BOT_TOKEN;
  console.log(`Slack bot token available: ${!!slackBotToken}`);
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
      // Use the channel passed from onboard.js as the ops channel
      // This ensures we always send messages to the same channel where the command was initiated
      SLACK_OPS_CHANNEL_WORKSPACE_INTERNAL: channel,
    },
  };

  try {
    // Create the Slack client using the shared client library
    // Using WORKSPACE_INTERNAL as it matches what's defined in the library
    const slackClient = BaseSlackClient.createFrom(lambdaContext, SLACK_TARGETS.WORKSPACE_INTERNAL);
    console.log('Slack client created successfully');

    // Create a Slack context object with the necessary methods for command execution
    // This matches the structure expected by other command handlers
    return {
      say: async (message) => {
        try {
          console.log(`Sending Slack message to channel ${channel}`);
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
          // Don't throw the error so workflow can continue even if Slack notification fails
        }
      },
      channel: { id: channel },
      channelId: channel,
    };
  } catch (error) {
    console.error(`Error creating Slack client: ${error.message}`);
    throw error;
  }
}

/**
 * Creates a standard API service context
 *
 * @param {Object} event - The input event which may contain an auth token
 * @returns {Object} - Context object with data access and other required properties
 */
function createServiceContext(event = {}) {
  const { authToken } = event;
  console.log(`Creating service context. Auth token present: ${!!authToken}`);

  return {
    dataAccess,
    // Add necessary service credentials for API calls
    env: {
      ...process.env,
      // Add any required authentication tokens from environment variables
      SPACECAT_SERVICE_TOKEN: process.env.SPACECAT_SERVICE_TOKEN,
      SCRAPING_JOBS_QUEUE_URL: process.env.SCRAPING_JOBS_QUEUE_URL,
      AUDIT_JOBS_QUEUE_URL: process.env.AUDIT_JOBS_QUEUE_URL,
    },
    // Include auth header for downstream requests if token is provided
    pathInfo: authToken ? {
      headers: {
        // Use either x-edge-authorization or standard authorization header
        // This ensures compatibility with both header formats
        authorization: authToken,
        'x-edge-authorization': authToken,
      },
    } : undefined,
    // Set up SQS client for message sending
    sqs: {
      sendMessage: async (queueUrl, messageBody) => {
        // Import the SQS client on-demand to avoid initialization cost if not needed
        const { SQSClient, SendMessageCommand } = await import('@aws-sdk/client-sqs');

        console.log('Creating SQS client using Lambda IAM role credentials');
        const sqs = new SQSClient();
        const command = new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify(messageBody),
        });

        try {
          console.log(`Sending SQS message to ${queueUrl}`);
          console.log(`Message type: ${messageBody.type || 'unknown'}`);
          const result = await sqs.send(command);
          console.log(`SQS message sent successfully. MessageID: ${result.MessageId}`);
          return result;
        } catch (error) {
          console.error(`Error sending SQS message: ${error.message}`);
          throw error;
        }
      },
    },
    // Add logging functions
    log: {
      debug: console.log,
      info: console.log,
      warn: console.warn,
      error: console.error,
    },
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
  // Minimal logging
  console.log(`Handling workflow command: ${command}`);
  console.log(`Site URL: ${params.siteUrl}`);
  console.log(`IMS Org ID: ${params.imsOrgId}`);

  const {
    siteUrl,
    imsOrgId,
    importTypes,
    auditTypes,
    message,
    authToken,
  } = params;

  const { say } = slackContext;

  // Create a service context with all the necessary access and credentials
  const serviceContext = createServiceContext({ authToken });

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
        // Let Step Functions know this failed
        throw new Error(`Failed to send notification: ${error.message}`);
      }
    }

    case 'run-scrape': {
      try {
        console.log(`Initiating scrape for site: ${siteUrl}`);
        const runScrape = RunScrape(serviceContext);
        const result = await runScrape.handleExecution([
          siteUrl,
        ], slackContext);

        // Check for errors in the result
        if (result && (result.error || (result.status && result.status >= 400))) {
          // If there's an error in the result, throw it to trigger the Step Functions error path
          throw new Error(result.error || `Scrape operation failed with status ${result.status}`);
        }

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

        // Throw the error to ensure Step Functions catches it and follows the error path
        throw new Error(`Scrape failed: ${error.message}`);
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
          serviceContext,
        );

        // Check for errors in the results
        if (auditResults && auditResults.error) {
          throw new Error(auditResults.error);
        }

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

        // Throw the error to ensure Step Functions catches it and follows the error path
        throw new Error(`Batch audit failed: ${error.message}`);
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
          serviceContext,
        );

        // Check for errors in the results
        if (disableResults && disableResults.error) {
          throw new Error(disableResults.error);
        }

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

        // Throw the error to ensure Step Functions catches it and follows the error path
        throw new Error(`Disable imports and audits failed: ${error.message}`);
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
 * Lambda handler function for workflow processing - directly invoked by Step Functions
 *
 * @param {Object} event - Lambda event object from Step Functions
 * @param {string} event.siteUrl - URL of the site to onboard
 * @param {string} event.imsOrgId - IMS organization ID
 * @param {string} [event.slackChannel] - Slack channel to send notifications to
 * @param {string} [event.command] - Command to execute (run-scrape, run-batch-audits, etc.)
 * @param {string} [event.message] - The message to send for notifications
 * @param {string} [event.authToken] - Authorization token to use for API calls
 * @returns {Object} - Result of the workflow execution
 */
export async function handler(event) {
  try {
    // Minimal logging
    console.log(`Workflow handler invoked for site: ${event.siteUrl}`);
    console.log(`Command: ${event.command || 'none'}`);
    console.log(`Auth token present: ${!!event.authToken}`);

    const {
      siteUrl,
      imsOrgId,
      slackChannel,
      importTypes = [],
      auditTypes = [],
      command,
      message,
      authToken,
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
      // For Slack context errors, we return an error but don't throw
      // This allows the workflow to continue even if notifications fail
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

        // This is a validation error - throw it to trigger the Step Functions error path
        throw new Error(`Command parameter is required. Valid commands: ${validCommands.join(', ')}`);
      }

      console.log(`Executing command: ${command} with IAM role authorization`);
      // Process command
      return await handleWorkflowCommand(command, {
        siteUrl,
        imsOrgId,
        importTypes,
        auditTypes,
        message,
        authToken,
      }, slackContext);
    } catch (error) {
      console.error(`Error during workflow execution: ${error.message}`);
      console.error(error.stack);

      // Try to notify via Slack, but don't fail if this doesn't work
      try {
        await say(`:x: Workflow failed for ${siteUrl}: ${error.message}`);
      } catch (slackError) {
        console.error('Failed to send Slack notification about error:', slackError.message);
      }

      // Re-throw the error to ensure Step Functions catches it
      throw error;
    }
  } catch (error) {
    console.error('Unhandled error in workflow handler:', error.message);
    console.error(error.stack);
    // Re-throw for Step Functions error handling
    throw error;
  }
}

// Export named functions for testing and reuse
export {
  handleWorkflowCommand,
  processBatchAudits,
  disable,
  createServiceContext,
};
/* c8 ignore end */
