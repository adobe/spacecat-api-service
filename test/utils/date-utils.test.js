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
/* eslint-env mocha */
import { expect } from 'chai';
import { isValidDateInterval } from '../../src/utils/date-utils.js';

describe('isValidDateInterval', () => {
  it('returns true for valid date interval within 2 years', () => {
    expect(isValidDateInterval('2023-01-01', '2024-12-31')).to.be.true;
  });

  it('returns false for invalid date formats', () => {
    expect(isValidDateInterval('2023/01/01', '2024-12-31')).to.be.false;
    expect(isValidDateInterval('2023-01-01', '2024/12/31')).to.be.false;
    expect(isValidDateInterval('01-01-2023', '31-12-2024')).to.be.false;
  });

  it('returns false for invalid dates', () => {
    expect(isValidDateInterval('2023-13-01', '2024-12-31')).to.be.false;
    expect(isValidDateInterval('2023-01-01', '2024-13-30')).to.be.false;
  });

  it('returns false when start date is after end date', () => {
    expect(isValidDateInterval('2024-12-31', '2023-01-01')).to.be.false;
  });

  it('returns false when interval is more than 2 years', () => {
    expect(isValidDateInterval('2023-01-01', '2025-01-02')).to.be.false;
  });

  it('returns true for exactly 2 years interval', () => {
    expect(isValidDateInterval('2023-01-01', '2024-12-31')).to.be.true;
  });

  it('returns true for 1 day interval', () => {
    expect(isValidDateInterval('2023-01-01', '2023-01-02')).to.be.true;
  });

  it('returns false for same day (no interval)', () => {
    expect(isValidDateInterval('2023-01-01', '2023-01-01')).to.be.false;
  });

  it('returns false when end date cannot be parsed into a valid Date object', () => {
    expect(isValidDateInterval('2023-01-01', '2024-13-01')).to.be.false;
  });
});
