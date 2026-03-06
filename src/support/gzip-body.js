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

import { gunzipSync } from 'zlib';
import { Request } from '@adobe/fetch';

/**
 * Middleware that decompresses gzip-encoded request bodies.
 * If the request has a `Content-Encoding: gzip` header, it reads the raw body,
 * decompresses it, and forwards a new request with the decompressed body.
 * Non-gzipped requests pass through unchanged.
 */
export default function gzipBody(func) {
  return async (request, context) => {
    if (request.headers.get('content-encoding') === 'gzip') {
      const compressed = Buffer.from(await request.arrayBuffer());
      const decompressed = gunzipSync(compressed);

      const headers = request.headers.raw();
      delete headers['content-encoding'];

      const newRequest = new Request(request.url, {
        method: request.method,
        headers,
        body: decompressed,
      });

      return func(newRequest, context);
    }

    return func(request, context);
  };
}
