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

// Guardrail for the agentic-traffic / referral-traffic analytical endpoints
// (SITES-46098). An unbounded date range lets a single query scan months of
// partitions and hit the 30s statement timeout, saturating the Aurora reader.
// Cap the requested span so over-wide queries are rejected (400) before they
// reach Postgres.
export const MAX_DATE_RANGE_DAYS = 62; // ~2 months

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

// Rejects malformed and non-real dates (e.g. 2026-02-30, 2026-13-01) by
// round-tripping through Date and comparing back to the input.
function isRealDate(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
    return false;
  }
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) {
    return false;
  }
  return d.toISOString().slice(0, 10) === value;
}

/**
 * Validate the requested date range on a traffic query.
 *
 * Reads camelCase and snake_case aliases from the request data. When both
 * bounds are omitted the caller relies on the handler's default window, so
 * there is nothing to validate.
 *
 * @param {object} [data] - context.data (parsed query params)
 * @returns {string|null} an error message for a 400 response, or null if valid
 */
export function checkDateRange(data) {
  const q = data || {};
  const startRaw = q.startDate || q.start_date;
  const endRaw = q.endDate || q.end_date;

  if (startRaw == null && endRaw == null) {
    return null;
  }
  if (startRaw == null || endRaw == null) {
    return 'Both startDate and endDate are required when either is provided';
  }
  if (!isRealDate(startRaw)) {
    return 'Invalid startDate: expected a real YYYY-MM-DD date';
  }
  if (!isRealDate(endRaw)) {
    return 'Invalid endDate: expected a real YYYY-MM-DD date';
  }

  const start = new Date(`${startRaw}T00:00:00Z`);
  const end = new Date(`${endRaw}T00:00:00Z`);
  if (start > end) {
    return 'startDate must be on or before endDate';
  }

  const spanDays = Math.round((end - start) / MS_PER_DAY) + 1; // inclusive
  if (spanDays > MAX_DATE_RANGE_DAYS) {
    return `Date range too large: ${spanDays} days requested, max is ${MAX_DATE_RANGE_DAYS} days`;
  }

  return null;
}
