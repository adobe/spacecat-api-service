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
 * Pure ISO-week date helpers for the Semrush elements layer.
 *
 * Extracted here so the support/elements layer does NOT import from the controller
 * layer (`controllers/llmo/llmo-brand-presence.js`) — keeping the dependency direction
 * correct (support ← controllers) and avoiding partial-export cycles. Copied verbatim
 * from that controller to guarantee identical week boundaries, including year-edge cases
 * (e.g. `2026-W01` → `2025-12-29`).
 *
 * TODO(LLMO-6011, productization): dedupe by having `llmo-brand-presence.js` import these
 * from here instead of keeping its own copies.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/* c8 ignore start -- LLMO-6011 POC endpoint; unit tests intentionally deferred */
function parseIsoWeek(weekStr) {
  const match = /^(\d{4})-W(\d{2})$/.exec(weekStr);
  if (!match) {
    return { weekNumber: 0, year: 0 };
  }
  return {
    year: Number.parseInt(match[1], 10),
    weekNumber: Number.parseInt(match[2], 10),
  };
}

/**
 * Returns startDate (Monday) and endDate (Sunday) for an ISO week string (YYYY-Wnn).
 * @param {string} isoWeek - e.g. "2026-W11"
 * @returns {{ startDate: string, endDate: string } | null} - YYYY-MM-DD or null if invalid
 */
export function getWeekDateRange(isoWeek) {
  const { year, weekNumber: week } = parseIsoWeek(isoWeek);
  if (!year || week < 1 || week > 53) {
    return null;
  }
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const dayOfWeek = jan4.getUTCDay();
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const week1MondayMs = jan4.getTime() + mondayOffset * MS_PER_DAY;
  const targetMondayMs = week1MondayMs + (week - 1) * 7 * MS_PER_DAY;
  const targetSundayMs = targetMondayMs + 6 * MS_PER_DAY;
  const toYMD = (ms) => {
    const d = new Date(ms);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  return {
    startDate: toYMD(targetMondayMs),
    endDate: toYMD(targetSundayMs),
  };
}

/**
 * Converts a date string (YYYY-MM-DD) to an ISO week string (YYYY-Wnn).
 * @param {string} dateStr - e.g. "2026-03-15"
 * @returns {string} e.g. "2026-W11"
 */
export function dateToIsoWeek(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const dayOfWeek = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayOfWeek);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNumber = Math.ceil(((d - yearStart) / MS_PER_DAY + 1) / 7);
  const year = d.getUTCFullYear();
  return `${year}-W${String(weekNumber).padStart(2, '0')}`;
}

/**
 * Generates every ISO week (YYYY-Wnn) between minDate and maxDate, inclusive,
 * sorted newest-first.
 * @param {string|null} minDate - Earliest date (YYYY-MM-DD)
 * @param {string|null} maxDate - Latest date (YYYY-MM-DD)
 * @returns {string[]} ISO week strings sorted descending
 */
export function generateIsoWeekRange(minDate, maxDate) {
  if (!minDate || !maxDate) {
    return [];
  }
  const minRange = getWeekDateRange(dateToIsoWeek(minDate));
  const maxRange = getWeekDateRange(dateToIsoWeek(maxDate));
  if (!minRange || !maxRange) {
    return [];
  }

  const result = [];
  let currentMs = new Date(`${minRange.startDate}T00:00:00Z`).getTime();
  const maxMs = new Date(`${maxRange.startDate}T00:00:00Z`).getTime();

  while (currentMs <= maxMs) {
    const d = new Date(currentMs);
    const y = d.getUTCFullYear();
    const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    result.push(dateToIsoWeek(`${y}-${mo}-${day}`));
    currentMs += 7 * MS_PER_DAY;
  }

  return result.sort((a, b) => b.localeCompare(a));
}
/* c8 ignore stop */
