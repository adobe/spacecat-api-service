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
 * Thrown when a request targets a product code that does not match the x-product header.
 * Caught in controller helpers to return a 403 instead of a 400.
 */
export class UnauthorizedProductError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnauthorizedProductError';
  }
}

/**
 * Throws a typed HTTP error when `error` matches a known Postgres constraint violation code.
 *
 * Storage functions handle the same handful of PG error codes (23503 FK violation,
 * 23505 unique constraint, …) and each needs to surface a different HTTP status.
 * This utility centralises the code→status→message mapping so callers declare
 * intent rather than repeating if/throw chains.
 *
 * @param {object} error - PostgREST error with `.code` and `.message` fields
 * @param {Record<string, {status: number, message: string}>} codeMap
 *   Keys are Postgres error codes; values carry the HTTP status and the
 *   client-facing message.  Postgres internals (table names, constraint names)
 *   should not appear in `message` — keep them in `.cause` for operator triage.
 */
export function throwOnPgConstraintViolation(error, codeMap) {
  const entry = codeMap[error?.code];
  if (entry) {
    const typed = new Error(entry.message, { cause: error });
    typed.status = entry.status;
    throw typed;
  }
}
