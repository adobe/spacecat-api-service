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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(value) {
  if (!DATE_RE.test(value)) {
    return false;
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

export function parsePositiveInt(value) {
  if (value === null || value === undefined || !/^\d+$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function daysBetweenInclusive(from, to) {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Math.floor((end - start) / 86_400_000) + 1;
}

/** Returns an error string, or null when the range is valid (or both dates are absent). */
export function validateDateRange(from, to, maxDays) {
  if (from === null && to === null) {
    return null;
  }
  if (from === null || to === null) {
    return 'Provide both date_from and date_to, or neither.';
  }
  if (!isValidDate(from) || !isValidDate(to)) {
    return 'Dates must be valid and in YYYY-MM-DD format.';
  }
  if (to < from) {
    return 'date_to must be equal to or after date_from.';
  }
  if (maxDays !== null && daysBetweenInclusive(from, to) > maxDays) {
    return `Date range must not exceed ${maxDays} days.`;
  }
  return null;
}
