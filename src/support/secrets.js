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

import {
  SecretsManagerClient,
  CreateSecretCommand,
  UpdateSecretCommand,
  GetSecretValueCommand,
  TagResourceCommand,
} from '@aws-sdk/client-secrets-manager';

/**
 * Wrapper function to enable access to Secrets Manager capabilities via the context.
 * When wrapped with this function, the client is available as context.secrets.secretsClient
 *
 * @param {UniversalAction} fn
 * @returns {function(object, UniversalContext): Promise<Response>}
 */
export function secretsClientWrapper(fn) {
  return async (request, context) => {
    if (!context.secrets) {
      // Create a Secrets Manager client and add it to the context
      const { region } = context.runtime;

      context.secrets = {
        secretsClient: new SecretsManagerClient({ region }),
        CreateSecretCommand,
        UpdateSecretCommand,
        GetSecretValueCommand,
        TagResourceCommand,
      };
    }
    return fn(request, context);
  };
}
