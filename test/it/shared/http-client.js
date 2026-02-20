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

/**
 * Creates an HTTP client with three pre-configured auth personas.
 *
 * @param {string} baseUrl - The dev server base URL (e.g., http://localhost:3002)
 * @param {{ admin: string, user: string, trialUser: string }} tokens - JWT tokens
 * @returns {{ admin: object, user: object, trialUser: object }}
 */
export function createHttpClient(baseUrl, tokens) {
  async function request(method, path, body, token, extraHeaders = {}) {
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'x-product': 'ASO',
      ...extraHeaders,
    };

    // Allow callers to omit default headers by setting them to undefined/null
    Object.keys(headers).forEach((key) => {
      if (headers[key] == null) delete headers[key];
    });

    const options = { method, headers };
    if (body !== null && body !== undefined) {
      options.body = JSON.stringify(body);
    }

    const res = await fetch(`${baseUrl}${path}`, options);
    const text = await res.text();

    let parsedBody = null;
    if (text) {
      try {
        parsedBody = JSON.parse(text);
      } catch {
        parsedBody = text;
      }
    }

    return {
      status: res.status,
      headers: res.headers,
      body: parsedBody,
    };
  }

  function makeMethods(token) {
    return {
      get: (path, extraHeaders) => request('GET', path, null, token, extraHeaders),
      post: (path, body, extraHeaders) => request('POST', path, body, token, extraHeaders),
      patch: (path, body, extraHeaders) => request('PATCH', path, body, token, extraHeaders),
      delete: (path, extraHeaders) => request('DELETE', path, null, token, extraHeaders),
      deleteWithBody: (path, body, extraHeaders) => request('DELETE', path, body, token, extraHeaders),
    };
  }

  return {
    admin: makeMethods(tokens.admin),
    user: makeMethods(tokens.user),
    trialUser: makeMethods(tokens.trialUser),
  };
}
