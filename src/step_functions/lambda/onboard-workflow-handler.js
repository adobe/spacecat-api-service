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
import { handler as workflowHandler } from '../workflow-handler.js';

export async function handler(event, context) {
  // Validate that the request is coming from an authorized Step Functions state machine
  // This validation is done using IAM roles, not tokens
  console.log('Step Functions handler invoked with event:', JSON.stringify(event));

  // Log authentication context
  console.log('Authentication method: IAM role-based (no auth tokens needed)');
  console.log('Lambda context:', {
    functionName: context.functionName,
    functionVersion: context.functionVersion,
    awsRequestId: context.awsRequestId,
    logGroupName: context.logGroupName,
    logStreamName: context.logStreamName,
    invokedFunctionArn: context.invokedFunctionArn,
  });

  if (context.clientContext) {
    console.log('Client context available:', JSON.stringify(context.clientContext));
  }

  if (context.identity) {
    console.log('Identity available:', JSON.stringify(context.identity));
  }

  try {
    // Directly invoke the workflow handler
    console.log('Forwarding request to workflow handler with IAM role credentials');
    return workflowHandler(event, context);
  } catch (error) {
    console.error('Error in onboard-workflow-handler:', error.message);
    console.error('Error stack:', error.stack);
    throw error; // Re-throw to ensure Step Functions detects the failure
  }
}
