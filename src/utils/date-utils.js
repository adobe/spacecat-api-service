/*
 * Copyright 2024 Adobe. All rights reserved.
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
 * Checks if the provided startDate & endDate is a valid interval
 * @param startDate - A starting date
 * @param endDate - An ending date
 * @returns {boolean} - true/false based on the validity of the interval
 */
export function isValidDateInterval(startDate, endDate) {
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(startDate)) {
    return false;
  }
  if (!dateRegex.test(endDate)) {
    return false;
  }
  const parsedStartDate = new Date(startDate);
  if (Number.isNaN(parsedStartDate.getTime())) {
    return false;
  }
  const parsedEndDate = new Date(endDate);
  if (Number.isNaN(parsedEndDate.getTime())) {
    return false;
  }

  return parsedStartDate < parsedEndDate
        && (parsedEndDate - parsedStartDate) <= 1000 * 60 * 60 * 24 * 365 * 2; // 2 years
}

/**
 * True when `value` is a real `YYYY-MM-DD` calendar date. Rejects malformed shapes and
 * impossible dates (e.g. `2026-13-45`) by round-tripping through Date. shared-utils
 * `isIsoDate` requires a full datetime, not the date-only form Overview surfaces send.
 * @param {*} value - the value to validate
 * @returns {boolean} true when `value` is a valid `YYYY-MM-DD` date
 */
export function isYmdDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
