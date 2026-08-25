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

import { expect } from 'chai';
import {
  addDaysToDate,
  splitDateRangeIntoWeeksBackward,
} from '../../../src/support/elements/week-utils.js';

describe('week-utils (trends backward-split helpers)', () => {
  describe('addDaysToDate', () => {
    it('adds positive days', () => {
      expect(addDaysToDate('2026-07-01', 6)).to.equal('2026-07-07');
    });

    it('subtracts negative days', () => {
      expect(addDaysToDate('2026-07-01', -1)).to.equal('2026-06-30');
    });

    it('handles month/year boundaries', () => {
      expect(addDaysToDate('2026-01-01', -1)).to.equal('2025-12-31');
    });
  });

  describe('splitDateRangeIntoWeeksBackward', () => {
    it('splits an exact 14-day range into two 7-day weeks, oldest-first', () => {
      const weeks = splitDateRangeIntoWeeksBackward('2026-07-01', '2026-07-14');
      expect(weeks).to.deep.equal([
        { startDate: '2026-07-01', endDate: '2026-07-07' },
        { startDate: '2026-07-08', endDate: '2026-07-14' },
      ]);
    });

    it('clamps the oldest week to startDate when the range is not a multiple of 7', () => {
      const weeks = splitDateRangeIntoWeeksBackward('2026-07-03', '2026-07-14');
      expect(weeks[0]).to.deep.equal({ startDate: '2026-07-03', endDate: '2026-07-07' });
      expect(weeks[1]).to.deep.equal({ startDate: '2026-07-08', endDate: '2026-07-14' });
    });

    it('caps the result at maxWeeks, keeping the most recent weeks', () => {
      const weeks = splitDateRangeIntoWeeksBackward('2026-01-01', '2026-07-14', 7, 2);
      expect(weeks).to.have.lengthOf(2);
      expect(weeks[weeks.length - 1].endDate).to.equal('2026-07-14');
    });

    it('returns a single week when the range is shorter than one week', () => {
      const weeks = splitDateRangeIntoWeeksBackward('2026-07-12', '2026-07-14');
      expect(weeks).to.deep.equal([{ startDate: '2026-07-12', endDate: '2026-07-14' }]);
    });
  });
});
