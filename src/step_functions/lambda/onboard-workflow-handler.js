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
  console.log('Step Functions handler invoked with event:', JSON.stringify({
    ...event,
    authToken: event.authToken ? 'TOKEN_PROVIDED' : 'NO_TOKEN',
  }));

  // Check if auth token is available
  if (event.authToken) {
    console.log('Using provided auth token for API authentication instead of IAM role');
  } else {
    console.log('WARNING: No auth token provided in event. API calls requiring authentication may fail.');
  }

  // Directly invoke the workflow handler with auth token
  return workflowHandler(event, context);
}
