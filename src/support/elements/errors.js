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
 */
export class ElementsTransportError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = 'ElementsTransportError';
    this.status = status;
    this.body = body;
  }
}
