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

import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

/**
 * Wrapper function to enable access to SSM capabilities via the context.
 * When wrapped with this function, the client is available as context.ssm.ssmClient
 *
 * @param {UniversalAction} fn
 * @returns {function(object, UniversalContext): Promise<Response>}
 */
export function ssmClientWrapper(fn) {
  return async (request, context) => {
    if (!context.ssm) {
      // Create an SSM client and add it to the context
      const { region } = context.runtime;

      context.ssm = {
        ssmClient: new SSMClient({ region }),
        GetParameterCommand,
      };
    }
    return fn(request, context);
  };
}

export default ssmClientWrapper;
