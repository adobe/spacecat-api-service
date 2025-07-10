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
import { AWSAthenaClient } from '@adobe/spacecat-shared-athena-client';

/**
 * Athena client factory wrapper for context injection.
 * If context.athenaClientFactory is already set, does nothing.
 * Otherwise, injects a factory that takes outputFolder and returns an AWSAthenaClient.
 *
 * @param {function} fn - The handler to wrap.
 * @returns {function} - Wrapped handler.
 */
export function athenaClientWrapper(fn) {
  return async (request, context) => {
    if (!context.athenaClientFactory) {
      context.athenaClientFactory = (outputFolder) => AWSAthenaClient
        .fromContext(
          context,
          outputFolder,
        );
    }
    return fn(request, context);
  };
}
