/*
 * Copyright 2026 Adobe. All rights reserved.
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
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

/**
 * Wrapper function to enable access to AWS Secrets Manager via the context.
 * When wrapped with this function, a v2-style adapter is available as context.sm.smClient.
 * The adapter exposes getSecretValue / putSecretValue to satisfy the interface expected
 * by ticket-client's OAuthCredentialManager.
 *
 * @param {UniversalAction} fn
 * @returns {function(object, UniversalContext): Promise<Response>}
 */
export function smClientWrapper(fn) {
  return async (request, context) => {
    if (!context.sm) {
      const rawSmClient = new SecretsManagerClient();
      context.sm = {
        smClient: {
          getSecretValue: (params) => rawSmClient.send(new GetSecretValueCommand(params)),
          putSecretValue: (params) => rawSmClient.send(new PutSecretValueCommand(params)),
        },
      };
    }
    return fn(request, context);
  };
}
