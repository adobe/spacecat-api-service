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

/* eslint-env mocha */

import { expect } from 'chai';
import { TokenDto } from '../../src/dto/token.js';

describe('TokenDto', () => {
  const mockToken = {
    getId: () => '223e4567-e89b-12d3-a456-426614174001',
    getSiteId: () => '123e4567-e89b-12d3-a456-426614174000',
    getTokenType: () => 'grant_cwv',
    getCycle: () => '2025-03',
    getTotal: () => 100,
    getUsed: () => 25,
    getRemaining: () => 75,
    getCreatedAt: () => '2025-03-01T00:00:00Z',
    getUpdatedAt: () => '2025-03-10T00:00:00Z',
  };

  it('converts a token to JSON with all fields', () => {
    const result = TokenDto.toJSON(mockToken);

    expect(result).to.deep.equal({
      id: '223e4567-e89b-12d3-a456-426614174001',
      siteId: '123e4567-e89b-12d3-a456-426614174000',
      tokenType: 'grant_cwv',
      cycle: '2025-03',
      total: 100,
      used: 25,
      remaining: 75,
      createdAt: '2025-03-01T00:00:00Z',
      updatedAt: '2025-03-10T00:00:00Z',
    });
  });

  it('handles zero values correctly', () => {
    const zeroToken = {
      ...mockToken,
      getTotal: () => 0,
      getUsed: () => 0,
      getRemaining: () => 0,
    };

    const result = TokenDto.toJSON(zeroToken);

    expect(result.total).to.equal(0);
    expect(result.used).to.equal(0);
    expect(result.remaining).to.equal(0);
  });

  it('handles fully consumed token', () => {
    const fullyUsedToken = {
      ...mockToken,
      getTotal: () => 3,
      getUsed: () => 3,
      getRemaining: () => 0,
    };

    const result = TokenDto.toJSON(fullyUsedToken);

    expect(result.total).to.equal(3);
    expect(result.used).to.equal(3);
    expect(result.remaining).to.equal(0);
  });
});
