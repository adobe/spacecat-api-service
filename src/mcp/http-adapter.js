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

/* c8 ignore start */
import { Buffer } from 'buffer';
import { MAX_BODY_SIZE } from '../utils/validations.js';

export function toNodeRequest(fetchRequest) {
  const headers = {};
  fetchRequest.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return {
    method: fetchRequest.method,
    headers,
    // minimal event emitter interface expected by transport
    on() {},
  };
}

export function createMockResponse() {
  const chunks = [];
  let totalLength = 0;
  const headers = {};
  let statusCode = 200;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  return {
    writeHead(status, h = {}) {
      if (this.headersSent) {
        throw new Error('Headers already sent');
      }
      statusCode = status;
      Object.assign(headers, h);
      this.headersSent = true;
      return this;
    },
    write(data) {
      if (!data) return;
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      totalLength += buf.length;
      if (totalLength > MAX_BODY_SIZE) {
        throw new Error('Response body exceeds maximum allowed size (4 MB)');
      }
      chunks.push(buf);
    },
    end(data) {
      if (data) this.write(data);
      this.finished = true;
      resolveDone();
    },
    flushHeaders() {
      this.headersFlushed = true;
    },
    emit() {},
    on() {},
    get body() {
      return Buffer.concat(chunks, Math.min(totalLength, MAX_BODY_SIZE)).toString();
    },
    get status() {
      return statusCode;
    },
    get headers() {
      return headers;
    },
    done,
  };
}

/* c8 ignore end */
