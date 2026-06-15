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
import { checkDateRange, MAX_DATE_RANGE_DAYS } from '../../../src/controllers/llmo/traffic-date-range.js';

describe('checkDateRange', () => {
  it('passes when both bounds are omitted (handler uses its default window)', () => {
    expect(checkDateRange({})).to.equal(null);
    expect(checkDateRange(undefined)).to.equal(null);
  });

  it('passes a 28-day range', () => {
    expect(checkDateRange({ startDate: '2026-01-01', endDate: '2026-01-28' })).to.equal(null);
  });

  it('passes the maximum allowed range exactly', () => {
    // inclusive span of MAX_DATE_RANGE_DAYS days
    expect(checkDateRange({ startDate: '2026-04-05', endDate: '2026-06-05' })).to.equal(null);
  });

  it('accepts snake_case aliases', () => {
    expect(checkDateRange({ start_date: '2026-01-01', end_date: '2026-01-28' })).to.equal(null);
  });

  it('rejects a range one day over the maximum', () => {
    const err = checkDateRange({ startDate: '2026-04-04', endDate: '2026-06-05' });
    expect(err).to.match(/Date range too large: 63 days/);
  });

  it('rejects the incident range (2026-02-13 → 2026-06-05, 113 days inclusive)', () => {
    const err = checkDateRange({ startDate: '2026-02-13', endDate: '2026-06-05' });
    expect(err).to.match(/Date range too large: 113 days/);
  });

  it('rejects a reversed range', () => {
    expect(checkDateRange({ startDate: '2026-06-05', endDate: '2026-01-01' }))
      .to.equal('startDate must be on or before endDate');
  });

  it('rejects when only one bound is provided', () => {
    expect(checkDateRange({ startDate: '2026-01-01' }))
      .to.match(/Both startDate and endDate are required/);
    expect(checkDateRange({ endDate: '2026-01-28' }))
      .to.match(/Both startDate and endDate are required/);
  });

  it('passes a single-day range (startDate === endDate, span = 1 day)', () => {
    expect(checkDateRange({ startDate: '2026-03-15', endDate: '2026-03-15' })).to.equal(null);
  });

  it('rejects a malformed date', () => {
    expect(checkDateRange({ startDate: '2026-1-1', endDate: '2026-01-28' }))
      .to.match(/Invalid startDate/);
    expect(checkDateRange({ startDate: '2026-01-01', endDate: 'not-a-date' }))
      .to.match(/Invalid endDate/);
  });

  it('rejects a non-real calendar date', () => {
    expect(checkDateRange({ startDate: '2026-02-30', endDate: '2026-03-01' }))
      .to.match(/Invalid startDate/);
    expect(checkDateRange({ startDate: '2026-01-01', endDate: '2026-13-01' }))
      .to.match(/Invalid endDate/);
  });

  it('exposes the cap constant', () => {
    expect(MAX_DATE_RANGE_DAYS).to.equal(62);
  });
});
