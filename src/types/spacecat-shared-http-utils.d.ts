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

// Corrective type augmentation for @adobe/spacecat-shared-http-utils.
//
// The package's shipped index.d.ts over-narrows the JSON response builders'
// `body` parameter to `string`, but at runtime they accept `object | string`
// and JSON-stringify it — see the package's own `createResponse` JSDoc
// (`@param {object|string|Buffer} body`) which `ok`/`created`/`accepted`/`found`
// all delegate to. Without this correction, every idiomatic `ok({ ... })` call
// in a `// @ts-check`'d controller is a false TS2345 ("not assignable to
// parameter of type 'string'").
//
// These overloads merge with (not replace) the published declarations and only
// correct the published types to match the documented runtime contract — they
// do not change behaviour. See docs/decisions/005-opt-in-type-checking.md.
import { Response } from '@adobe/fetch';

declare module '@adobe/spacecat-shared-http-utils' {
  // `null` is accepted at runtime (it JSON-stringifies to `null`); callers pass
  // it to emit an empty-bodied response with a custom status, e.g. 204.
  export function createResponse(
    body: object | string | null,
    status?: number,
    headers?: object,
  ): Response;
  export function ok(body?: object | string, headers?: object): Response;
  export function created(body?: object | string, headers?: object): Response;
  export function accepted(body?: object | string, headers?: object): Response;
  export function found(location: string, body?: object | string): Response;
}
