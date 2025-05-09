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
  // Minimal logging
  console.log(`Onboard workflow handler invoked for site: ${event.siteUrl || 'unknown'}`);
  console.log(`Command: ${event.command || 'none'}`);
  console.log(`Auth token present: ${!!event.authToken}`);

  // Directly invoke the workflow handler with auth token
  return workflowHandler(event, context);
}
