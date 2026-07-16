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
import { hasText, isObject } from '@adobe/spacecat-shared-utils';

/**
 * Sparse-fieldset projection (JSON:API / Google API `fields` convention).
 *
 * A caller opts in to a reduced payload by passing a comma-separated `fields`
 * query param (e.g. `?fields=id,baseURL,name`). When the param is absent the
 * response is returned unchanged, so behaviour is fully backwards compatible for
 * every consumer that does not send it. Only top-level keys are supported.
 */

// Always retained so projected items remain identifiable/joinable even when the
// caller forgets to request it.
const ALWAYS_INCLUDED_FIELD = 'id';

/**
 * Parses the `fields` query param into a normalized list of field names.
 * @param {string} [fieldsParam] - Raw comma-separated query param value.
 * @returns {string[]|null} Array of requested field names, or null when absent/empty.
 */
export function parseFields(fieldsParam) {
  if (!hasText(fieldsParam)) {
    return null;
  }
  const fields = fieldsParam
    .split(',')
    .map((field) => field.trim())
    .filter(Boolean);
  return fields.length > 0 ? fields : null;
}

/**
 * Projects a single object down to the requested fields.
 * Unknown field names are ignored (lenient). `id` is always retained when present.
 * @param {object} obj - Object to project (typically a DTO output).
 * @param {string[]|null} fields - Requested field names, or null for no projection.
 * @returns {object} Projected object, or the original object when fields is null.
 */
export function projectFields(obj, fields) {
  if (!fields || !isObject(obj)) {
    return obj;
  }
  const projected = {};
  if (ALWAYS_INCLUDED_FIELD in obj) {
    projected[ALWAYS_INCLUDED_FIELD] = obj[ALWAYS_INCLUDED_FIELD];
  }
  for (const field of fields) {
    if (field in obj) {
      projected[field] = obj[field];
    }
  }
  return projected;
}

/**
 * Returns true when at least one requested field exists on any of the items.
 * Used to reject a `fields` param that matches nothing (surfaces caller typos).
 * An empty list is treated as valid — there is nothing to validate against.
 * @param {object[]} items - Array of objects that would be projected.
 * @param {string[]} fields - Requested field names.
 * @returns {boolean}
 */
export function hasMatchingFields(items, fields) {
  if (!fields || !Array.isArray(items) || items.length === 0) {
    return true;
  }
  const availableKeys = new Set();
  for (const item of items) {
    if (isObject(item)) {
      Object.keys(item).forEach((key) => availableKeys.add(key));
    }
  }
  return fields.some((field) => availableKeys.has(field));
}

/**
 * Applies sparse-fieldset projection to a list of DTO objects.
 *
 * When the `fields` param is absent the list is returned unchanged. When present
 * but no requested field matches any item, an `error` message is returned so the
 * controller can respond with `badRequest`.
 * @param {object[]} items - Array of DTO objects to project.
 * @param {string} [fieldsParam] - Raw `fields` query param value.
 * @returns {{ list: object[]|null, error: string|null }} Projected list, or an error message.
 */
export function applyFieldProjection(items, fieldsParam) {
  const fields = parseFields(fieldsParam);
  if (!fields) {
    return { list: items, error: null };
  }
  if (!hasMatchingFields(items, fields)) {
    return { list: null, error: `Invalid fields: ${fields.join(', ')}` };
  }
  const list = Array.isArray(items)
    ? items.map((item) => projectFields(item, fields))
    : items;
  return { list, error: null };
}
