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

import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { hasText } from '@adobe/spacecat-shared-utils';

const sfnClient = new SFNClient();

/**
 * Step Functions execution names must be 1–80 chars and may only contain
 * letters, numbers, hyphens, or underscores
 * (see https://docs.aws.amazon.com/step-functions/latest/apireference/API_StartExecution.html).
 * This helper enforces those constraints and falls back to a timestamped name
 * when input is missing or becomes empty after sanitization.
 */
export const sanitizeExecutionName = (value) => {
  const sanitizedInput = (value || `agent-${Date.now()}`).replace(/[^A-Za-z0-9-_]/g, '');
  const safe = sanitizedInput.length > 0 ? sanitizedInput : `agent-${Date.now()}`;
  return safe.slice(0, 80);
};

/**
 * Starts the generic agent workflow Step Function.
 *
 * @param {object} context - Lambda context containing env/log.
 * @param {object} input - Payload passed to the workflow.
 * @param {object} [options] - Optional settings.
 * @param {string} [options.executionName] - Preferred execution name.
 * @returns {Promise<string>} Execution name that was used.
 */
export const startAgentWorkflow = async (context, input, options = {}) => {
  const arn = context?.env?.AGENT_WORKFLOW_STATE_MACHINE_ARN;
  if (!hasText(arn)) {
    throw new Error('AGENT_WORKFLOW_STATE_MACHINE_ARN is not configured');
  }

  const preferredName = options.executionName
    || `agent-${input?.agentId || 'unknown'}-${input?.siteId || 'global'}-${Date.now()}`;
  const executionName = sanitizeExecutionName(preferredName);

  const command = new StartExecutionCommand({
    stateMachineArn: arn,
    name: executionName,
    input: JSON.stringify(input),
  });

  await sfnClient.send(command);
  context?.log?.info?.(`agent-workflow: started ${input?.agentId || 'unknown'} (${executionName})`);
  return executionName;
};
