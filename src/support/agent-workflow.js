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
import { sanitizeExecutionName } from './utils.js';

const sfnClient = new SFNClient();

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
