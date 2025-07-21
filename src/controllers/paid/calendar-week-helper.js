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
const MILLISECONDS_IN_A_DAY = 24 * 60 * 60 * 1000;
const MILLISECONDS_IN_A_WEEK = 7 * MILLISECONDS_IN_A_DAY;

const getFirstMondayOfYear = (year) => {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  return new Date(Date.UTC(year, 0, 4 - (jan4.getUTCDay() || 7) + 1));
};

const getThursdayOfWeek = (date) => {
  const thursday = new Date(date.getTime());
  thursday.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  return thursday;
};

const has53CalendarWeeks = (year) => {
  const lastDayOfYear = new Date(Date.UTC(year, 11, 31));
  const lastThursday = getThursdayOfWeek(lastDayOfYear);
  const firstMonday = getFirstMondayOfYear(year);
  const thursdayOfFirstWeek = new Date(firstMonday.getTime() + 3 * MILLISECONDS_IN_A_DAY);

  const maxWeek = Math.ceil((lastThursday.getTime() - thursdayOfFirstWeek.getTime())
    / MILLISECONDS_IN_A_WEEK) + 1;

  return maxWeek === 53;
};

const isValidWeek = (week, year) => {
  if (year < 100 || week < 1) return false;
  if (week === 53) return has53CalendarWeeks(year);
  return week <= 52;
};

const getLastFullCalendarWeek = () => {
  const currentDate = new Date();
  currentDate.setUTCHours(0, 0, 0, 0);

  const previousWeekDate = new Date(currentDate.getTime() - MILLISECONDS_IN_A_WEEK);

  const thursdayOfPreviousWeek = getThursdayOfWeek(previousWeekDate);
  const year = thursdayOfPreviousWeek.getUTCFullYear();

  const firstMonday = getFirstMondayOfYear(year);
  const thursdayOfFirstWeek = new Date(firstMonday.getTime() + 3 * MILLISECONDS_IN_A_DAY);

  const week = Math.ceil((thursdayOfPreviousWeek.getTime() - thursdayOfFirstWeek.getTime())
    / MILLISECONDS_IN_A_WEEK) + 1;

  return { week, year };
};

export function getDateRanges(week, year) {
  let effectiveWeek = week;
  let effectiveYear = year;

  if (!isValidWeek(effectiveWeek, effectiveYear)) {
    const lastFullWeek = getLastFullCalendarWeek();
    effectiveWeek = lastFullWeek.week;
    effectiveYear = lastFullWeek.year;
  }

  const firstMonday = getFirstMondayOfYear(effectiveYear);
  const startDate = new Date(firstMonday.getTime() + (effectiveWeek - 1) * MILLISECONDS_IN_A_WEEK);
  const endDate = new Date(startDate.getTime() + 6 * MILLISECONDS_IN_A_DAY);
  endDate.setUTCHours(23, 59, 59, 999);
  const startMonth = startDate.getUTCMonth() + 1;
  const endMonth = endDate.getUTCMonth() + 1;
  const startYear = startDate.getUTCFullYear();

  if (startMonth === endMonth) {
    return [{
      year: startYear,
      month: startMonth,
      startTime: startDate.toISOString(),
      endTime: endDate.toISOString(),
    }];
  }

  const endYear = endDate.getUTCFullYear();

  const endOfFirstMonth = new Date(Date.UTC(
    startYear,
    startDate.getUTCMonth() + 1,
    0,
    23,
    59,
    59,
    999,
  )).toISOString();

  const startOfSecondMonth = new Date(Date.UTC(
    endYear,
    endDate.getUTCMonth(),
    1,
  )).toISOString();

  return [
    {
      year: startYear,
      month: startMonth,
      startTime: startDate.toISOString(),
      endTime: endOfFirstMonth,
    },
    {
      year: endYear,
      month: endMonth,
      startTime: startOfSecondMonth,
      endTime: endDate.toISOString(),
    },
  ];
}
