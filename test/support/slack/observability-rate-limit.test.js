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

import { expect } from 'chai';
import {
  shouldRateLimitSlackPost,
  resetSlackRateLimit,
} from '../../../src/support/slack/observability-rate-limit.js';

describe('observability-rate-limit', () => {
  beforeEach(() => {
    resetSlackRateLimit();
  });

  it('allows the first post for a key', () => {
    expect(shouldRateLimitSlackPost('k', 1000)).to.be.false;
  });

  it('suppresses a second post for the same key within the window', () => {
    expect(shouldRateLimitSlackPost('k', 1000)).to.be.false;
    expect(shouldRateLimitSlackPost('k', 1000 + 5000)).to.be.true;
  });

  it('allows a post again once the window has elapsed', () => {
    expect(shouldRateLimitSlackPost('k', 1000)).to.be.false;
    expect(shouldRateLimitSlackPost('k', 1000 + 10000)).to.be.false;
  });

  it('tracks distinct keys independently', () => {
    expect(shouldRateLimitSlackPost('a', 1000)).to.be.false;
    expect(shouldRateLimitSlackPost('b', 1000)).to.be.false;
  });

  it('clears tracked keys when the cap is exceeded (best-effort memory bound)', () => {
    // Seed a key whose within-window re-check would normally be suppressed.
    expect(shouldRateLimitSlackPost('k', 1000)).to.be.false;
    // Fill past MAX_TRACKED_KEYS (1000) with distinct keys at the same instant;
    // the size guard clears the map on overflow.
    for (let i = 0; i < 1000; i += 1) {
      shouldRateLimitSlackPost(`fill#${i}`, 1000);
    }
    // 'k' was evicted by the clear, so a within-window re-check is allowed again.
    expect(shouldRateLimitSlackPost('k', 1000 + 5000)).to.be.false;
  });
});
