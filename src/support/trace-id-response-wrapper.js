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

import { getTraceId } from '@adobe/spacecat-shared-utils';

/**
 * Adds `x-trace-id` to the HTTP response for distributed tracing.
 * Prefer {@link context.traceId} (e.g. from incoming request / SQS propagation), else AWS X-Ray.
 *
 * @param {function} fn - Inner wrapped handler
 * @returns {function(object, object): Promise<Response>}
 */
export function traceIdResponseWrapper(fn) {
  return async (message, context) => {
    const response = await fn(message, context);
    const traceId = context.traceId || getTraceId();
    if (traceId && response?.headers?.set) {
      response.headers.set('x-trace-id', traceId);
    }
    return response;
  };
}
