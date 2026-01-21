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

import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';
import { isObject } from '@adobe/spacecat-shared-utils';

import BaseCommand from './base.js';
import {
  postErrorMessage,
  postSiteNotFoundMessage,
} from '../../../utils/slack/base.js';

const PHRASES = ['generate a11y codefix'];

/**
 * Factory function to create the GenerateA11yCodefix command.
 *
 * @param {Object} context - The context object.
 * @return {Object} The GenerateA11yCodefix command object.
 * @constructor
 */
function GenerateA11yCodefixCommand(context) {
  const baseCommand = BaseCommand({
    id: 'generate-a11y-codefix',
    name: 'Generate A11y Codefix',
    description: 'Generates accessibility code fixes by sending a request to Mystique. Requires specifying the S3 archive name.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} --site-id {site-id} --opportunity-id {opp-id} --suggestion-id {sugg-id} [{sugg-id-2} ...] --archive {archive-name}\nOr: ${PHRASES[0]} {site-id} {opp-id} {sugg-id} [{sugg-id-2} ...] --archive {archive-name}`,
  });

  const { dataAccess, log, env } = context;
  const { Site, Opportunity, Suggestion } = dataAccess;

  /**
   * Checks if an S3 object exists.
   *
   * @param {Object} s3Client - The S3 client.
   * @param {string} bucket - The S3 bucket name.
   * @param {string} key - The S3 object key.
   * @returns {Promise<boolean>} True if object exists, false otherwise.
   */
  async function checkS3ObjectExists(s3Client, bucket, key) {
    try {
      await s3Client.send(new HeadObjectCommand({
        Bucket: bucket,
        Key: key,
      }));
      return true;
    } catch (error) {
      if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
        return false;
      }
      // Re-throw other errors (permissions, etc.)
      throw error;
    }
  }

  /**
   * Sends a message to the Mystique SQS queue.
   *
   * @param {Object} sqsClient - The SQS client.
   * @param {string} queueUrl - The SQS queue URL.
   * @param {Object} message - The message payload.
   * @returns {Promise<string>} The message ID.
   */
  async function sendToSQS(sqsClient, queueUrl, message) {
    const command = new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(message),
      MessageAttributes: {
        type: {
          DataType: 'String',
          StringValue: message.type,
        },
        siteId: {
          DataType: 'String',
          StringValue: message.siteId,
        },
      },
    });

    const result = await sqsClient.send(command);
    return result.MessageId;
  }

  /**
   * Helper function to build issue description.
   *
   * @param {Object} issue - The issue object.
   * @returns {string} The issue description.
   */
  function buildIssueDescription(issue) {
    const issueType = issue.type || 'unknown';
    return issue.description || `Accessibility issue: ${issueType}`;
  }

  /**
   * Execute function for SendMystiqueFixCommand.
   *
   * @param {Array} args - The arguments provided to the command.
   * @param {Object} slackContext - The Slack context object.
   * @param {Function} slackContext.say - The Slack say function.
   * @returns {Promise} A promise that resolves when the operation is complete.
   */
  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;

    try {
      if (args.length === 0) {
        await say(baseCommand.usage());
        return;
      }

      // Parse named and positional arguments
      let siteIdInput = null;
      let opportunityIdInput = null;
      let suggestionIdsInput = [];
      let archiveName = null;

      // Helper function to extract flag value
      const getFlagValue = (flag) => {
        const index = args.findIndex((arg) => arg === flag);
        return (index !== -1 && index < args.length - 1) ? args[index + 1] : null;
      };

      // Helper function to extract multiple values after a flag (until next flag or end)
      const getMultipleFlagValues = (flag) => {
        const values = [];
        const index = args.findIndex((arg) => arg === flag);

        if (index === -1 || index >= args.length - 1) {
          return values;
        }

        // Collect all values after the flag until we hit another flag (starts with --)
        for (let i = index + 1; i < args.length; i += 1) {
          if (args[i].startsWith('--')) {
            break;
          }
          values.push(args[i]);
        }

        return values;
      };

      // Check for named arguments
      const hasSiteIdFlag = args.includes('--site-id');
      const hasOpportunityIdFlag = args.includes('--opportunity-id');
      const hasSuggestionIdFlag = args.includes('--suggestion-id');

      if (hasSiteIdFlag || hasOpportunityIdFlag || hasSuggestionIdFlag) {
        // Named arguments mode
        siteIdInput = getFlagValue('--site-id');
        opportunityIdInput = getFlagValue('--opportunity-id');
        suggestionIdsInput = getMultipleFlagValues('--suggestion-id');
        archiveName = getFlagValue('--archive');
      } else {
        // Positional arguments mode (backward compatibility)
        let processedArgs = [...args];

        // Extract --archive flag
        const archiveIndex = args.findIndex((arg) => arg === '--archive');
        if (archiveIndex !== -1 && archiveIndex < args.length - 1) {
          archiveName = args[archiveIndex + 1];
          processedArgs = [...args.slice(0, archiveIndex), ...args.slice(archiveIndex + 2)];
        }

        [siteIdInput, opportunityIdInput, ...suggestionIdsInput] = processedArgs;
      }

      // Validate inputs
      if (!siteIdInput || !opportunityIdInput || suggestionIdsInput.length === 0) {
        await say(`:warning: Missing required parameters. ${baseCommand.usage()}`);
        return;
      }

      // Require --archive flag
      if (!archiveName) {
        await say({
          text: ':warning: Archive name required',
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: ':warning: *Archive name is required*\n\n'
                  + 'Specify using `--archive {name}`\n\n'
                  + `Example (named args):\n\`@spacecat generate a11y codefix --site-id ${siteIdInput} --opportunity-id ${opportunityIdInput} --suggestion-id ${suggestionIdsInput.join(' ')} --archive MyRepo.tar.gz\`\n\n`
                  + `Example (positional):\n\`@spacecat generate a11y codefix ${siteIdInput} ${opportunityIdInput} ${suggestionIdsInput.join(' ')} --archive MyRepo.tar.gz\``,
              },
            },
          ],
        });
        return;
      }

      await say(':hourglass_flowing_sand: Processing fix request...');

      // Get environment variables
      const {
        AWS_REGION,
        AWS_ACCESS_KEY_ID,
        AWS_SECRET_ACCESS_KEY,
        AWS_SESSION_TOKEN,
        SQS_SPACECAT_TO_MYSTIQUE_QUEUE_URL,
      } = env;

      if (!SQS_SPACECAT_TO_MYSTIQUE_QUEUE_URL) {
        throw new Error('SQS_SPACECAT_TO_MYSTIQUE_QUEUE_URL not configured');
      }

      // S3 bucket for code archives (used in message payload only)
      const mystiqueBucket = 'spacecat-prod-mystique-assets';

      // Initialize AWS clients
      const awsConfig = {
        region: AWS_REGION || 'us-east-1',
      };

      if (AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY) {
        awsConfig.credentials = {
          accessKeyId: AWS_ACCESS_KEY_ID,
          secretAccessKey: AWS_SECRET_ACCESS_KEY,
          ...(AWS_SESSION_TOKEN && { sessionToken: AWS_SESSION_TOKEN }),
        };
      }

      const s3Client = new S3Client(awsConfig);
      const sqsClient = new SQSClient(awsConfig);

      // Fetch site
      const site = await Site.findById(siteIdInput);
      if (!isObject(site)) {
        await postSiteNotFoundMessage(say, siteIdInput);
        return;
      }

      // Fetch opportunity
      const opportunity = await Opportunity.findById(opportunityIdInput);
      if (!isObject(opportunity)) {
        await say(`:warning: Opportunity not found: ${opportunityIdInput}`);
        return;
      }

      // Fetch suggestions
      const suggestions = await Promise.all(
        suggestionIdsInput.map((id) => Suggestion.findById(id)),
      );

      const validSuggestions = suggestions.filter(isObject);

      if (validSuggestions.length === 0) {
        await say(':warning: No valid suggestions found.');
        return;
      }

      // Validate site has code configuration
      const code = site.getCode();
      if (!isObject(code) || !code.owner || !code.repo || !code.url || !code.ref) {
        await say(`:warning: Site ${site.getBaseURL()} does not have proper code configuration (owner, repo, url, ref).`);
        return;
      }

      // Validate the specified code archive exists in S3
      const existingKey = `tmp/codefix/source/${archiveName}`;
      log.info(`Checking if archive exists: s3://${mystiqueBucket}/${existingKey}`);

      const archiveExists = await checkS3ObjectExists(s3Client, mystiqueBucket, existingKey);

      if (!archiveExists) {
        await say(`:warning: Archive \`${archiveName}\` not found`);
        return;
      }

      log.info(`Archive exists in S3: ${existingKey}`);
      await say(`:hourglass_flowing_sand: Using code archive: \`${archiveName}\`. Preparing fix request...`);

      // Get URL from first suggestion (all suggestions should be for same opportunity)
      const firstSuggestion = validSuggestions[0];
      const suggestionData = firstSuggestion.getData();
      const pageUrl = suggestionData.url || site.getBaseURL();

      // Build issuesList in the format expected by Mystique
      const issuesList = validSuggestions.flatMap((s) => {
        const suggestionId = s.getId();
        const data = s.getData();
        const dataIssues = data.issues || [];

        return dataIssues.flatMap((issue) => {
          const htmlWithIssues = issue.htmlWithIssues || [];
          const issueType = issue.type || 'unknown';
          const issueDescription = buildIssueDescription(issue);

          // If there are htmlWithIssues, create one entry per HTML issue
          if (htmlWithIssues.length > 0) {
            return htmlWithIssues.map((html) => ({
              issue_name: issueType,
              issue_description: issueDescription,
              faulty_line: html.update_from || html.updateFrom || '',
              target_selector: html.target_selector || html.targetSelector || '',
              suggestion_id: suggestionId,
            }));
          }

          // Fallback: create one entry for the issue without HTML details
          return [{
            issue_name: issueType,
            issue_description: issueDescription,
            faulty_line: '',
            target_selector: '',
            suggestion_id: suggestionId,
          }];
        });
      });

      // Use opportunity ID as audit ID for tracking
      const auditId = opportunity.getId();

      // Get aggregation key from first suggestion (used by Mystique to group fixes)
      const aggregationKey = suggestionData.aggregationKey || `slack-${Date.now()}`;

      // Create SQS message payload - MUST match Python script format exactly
      const messagePayload = {
        type: 'guidance:accessibility-remediation',
        siteId: site.getId(),
        auditId,
        time: new Date().toISOString(),
        data: {
          url: pageUrl,
          opportunityId: opportunity.getId(),
          aggregationKey,
          issuesList,
          codeBucket: mystiqueBucket,
          codePath: existingKey,
        },
      };

      // Send to SQS
      const sqsMessageId = await sendToSQS(
        sqsClient,
        SQS_SPACECAT_TO_MYSTIQUE_QUEUE_URL,
        messagePayload,
      );

      const siteUrl = site.getBaseURL();
      await say({
        text: ':white_check_mark: Fix request sent successfully!',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: ':white_check_mark: *Fix request sent to Mystique!*\n\n'
                + `• *Site:* <${siteUrl}|${siteUrl}>\n`
                + `• *URL:* ${pageUrl}\n`
                + `• *Opportunity:* ${opportunity.getType()}\n`
                + `• *Suggestions:* ${validSuggestions.length}\n`
                + `• *Issues:* ${issuesList.length}\n`
                + `• *Message ID:* ${sqsMessageId}\n`
                + `• *Audit ID:* ${auditId}\n`
                + `• *Code Archive:* \`${existingKey}\``,
            },
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: 'Mystique will process this request and generate code fixes. Results will be available in S3.',
              },
            ],
          },
        ],
      });
    } catch (error) {
      log.error('Error sending Mystique fix request:', error);
      await postErrorMessage(say, error);
    }
  };

  baseCommand.init(context);

  return {
    ...baseCommand,
    handleExecution,
  };
}

export default GenerateA11yCodefixCommand;
