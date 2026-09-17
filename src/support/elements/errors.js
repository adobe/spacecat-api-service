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

/**
 * Error thrown when the Semrush Elements API upstream returns a non-2xx response.
 * `status` carries the upstream HTTP status; `body` is the parsed JSON (or raw text).
 * The controller's mapError does NOT leak `.body` to clients — it is kept for server-side logging.
 *
 * `requestInfo` carries the structured request descriptor (`method`, upstream
 * URL path as `endpoint`, and the workspace/element ids of the call) for the
 * structured upstream-error log line (SITES-49993), attached at the throw
 * sites in elements-transport.js.
 */
export class ElementsTransportError extends Error {
  /**
   * @param {number} status - the upstream HTTP status.
   * @param {string} message
   * @param {any} [body] - parsed JSON, raw text, or null for an empty body.
   * @param {object} [requestInfo]
   * @param {string} [requestInfo.method] - HTTP method of the upstream call.
   * @param {string} [requestInfo.endpoint] - upstream URL path (no host).
   * @param {string} [requestInfo.workspaceId] - id of the workspace called.
   * @param {string} [requestInfo.elementId] - id of the element called.
   */
  constructor(status, message, body, requestInfo = {}) {
    super(message);
    this.name = 'ElementsTransportError';
    this.status = status;
    this.body = body;
    this.method = requestInfo.method;
    this.endpoint = requestInfo.endpoint;
    this.workspaceId = requestInfo.workspaceId;
    this.elementId = requestInfo.elementId;
  }
}
