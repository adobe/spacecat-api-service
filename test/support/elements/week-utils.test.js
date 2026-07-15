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

/*
 * Tests for the ISO-week date helpers (LLMO-6011 POC, previously c8-ignored).
 * These power the URL Inspector / Brand Presence week pickers, and the year-edge
 * math (a week that starts in the previous calendar year) is exactly the kind of
 * off-by-one that silently corrupts a week filter — so it is pinned explicitly.
 */

import { expect } from 'chai';
import {
  getWeekDateRange,
  dateToIsoWeek,
  generateIsoWeekRange,
} from '../../../src/support/elements/week-utils.js';

describe('week-utils', () => {
  describe('getWeekDateRange', () => {
    it('returns Monday→Sunday for a valid ISO week', () => {
      const range = getWeekDateRange('2026-W11');
      expect(range).to.deep.equal({ startDate: '2026-03-09', endDate: '2026-03-15' });
      // Monday start, Sunday end, exactly 6 days apart
      const days = (new Date(range.endDate) - new Date(range.startDate)) / (1000 * 60 * 60 * 24);
      expect(days).to.equal(6);
      expect(new Date(`${range.startDate}T00:00:00Z`).getUTCDay()).to.equal(1); // Monday
    });

    it('handles the year-edge week that starts in the previous calendar year', () => {
      // ISO 2026-W01 begins Mon 2025-12-29 (Jan 4 2026 is a Sunday → mondayOffset -6).
      expect(getWeekDateRange('2026-W01')).to.deep.equal({
        startDate: '2025-12-29',
        endDate: '2026-01-04',
      });
    });

    it('handles a year whose Jan 4 is not a Sunday (else branch of the Monday offset)', () => {
      // Jan 4 2025 is a Saturday → mondayOffset = 1 - 6; ISO 2025-W01 begins 2024-12-30.
      expect(getWeekDateRange('2025-W01')).to.deep.equal({
        startDate: '2024-12-30',
        endDate: '2025-01-05',
      });
    });

    it('returns null for malformed or out-of-range weeks', () => {
      expect(getWeekDateRange('garbage')).to.equal(null);
      expect(getWeekDateRange('2026-W00')).to.equal(null);
      expect(getWeekDateRange('2026-W54')).to.equal(null);
      expect(getWeekDateRange('')).to.equal(null);
    });
  });

  describe('dateToIsoWeek', () => {
    it('maps a date to its ISO week', () => {
      expect(dateToIsoWeek('2026-03-15')).to.equal('2026-W11');
    });

    it('assigns a late-December date to the following year\'s W01 when appropriate', () => {
      // Mon 2025-12-29 is the start of ISO 2026-W01.
      expect(dateToIsoWeek('2025-12-29')).to.equal('2026-W01');
    });

    it('round-trips with getWeekDateRange (a week\'s Monday maps back to that week)', () => {
      const { startDate } = getWeekDateRange('2026-W11');
      expect(dateToIsoWeek(startDate)).to.equal('2026-W11');
    });
  });

  describe('generateIsoWeekRange', () => {
    it('returns every ISO week in the span, newest-first', () => {
      expect(generateIsoWeekRange('2026-03-01', '2026-03-15')).to.deep.equal([
        '2026-W11', '2026-W10', '2026-W09',
      ]);
    });

    it('returns a single week when min and max fall in the same week', () => {
      expect(generateIsoWeekRange('2026-03-09', '2026-03-15')).to.deep.equal(['2026-W11']);
    });

    it('returns [] when either bound is missing', () => {
      expect(generateIsoWeekRange(null, '2026-03-15')).to.deep.equal([]);
      expect(generateIsoWeekRange('2026-03-01', null)).to.deep.equal([]);
    });

    it('returns [] when a bound cannot be parsed into a week', () => {
      expect(generateIsoWeekRange('garbage', '2026-03-15')).to.deep.equal([]);
    });
  });
});
