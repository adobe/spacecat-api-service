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
import { enableExperimentTrackingSchema } from '../../src/schemas/experiment-tracking.js';

describe('enableExperimentTrackingSchema', () => {
  it('accepts a valid payload', () => {
    const r = enableExperimentTrackingSchema.safeParse({
      experimentId: '11111111-1111-4111-8111-111111111111',
      provider: 'geo-experiment',
    });
    expect(r.success).to.equal(true);
  });

  it('accepts an optional ISO startedAt', () => {
    const r = enableExperimentTrackingSchema.safeParse({
      experimentId: '11111111-1111-4111-8111-111111111111',
      provider: 'geo-experiment',
      startedAt: '2026-05-06T14:00:00Z',
    });
    expect(r.success).to.equal(true);
  });

  it('rejects a non-uuid experimentId', () => {
    const r = enableExperimentTrackingSchema.safeParse({
      experimentId: 'not-a-uuid',
      provider: 'geo-experiment',
    });
    expect(r.success).to.equal(false);
  });

  it('rejects an unknown provider', () => {
    const r = enableExperimentTrackingSchema.safeParse({
      experimentId: '11111111-1111-4111-8111-111111111111',
      provider: 'something-else',
    });
    expect(r.success).to.equal(false);
  });

  it('rejects a malformed startedAt', () => {
    const r = enableExperimentTrackingSchema.safeParse({
      experimentId: '11111111-1111-4111-8111-111111111111',
      provider: 'geo-experiment',
      startedAt: 'yesterday',
    });
    expect(r.success).to.equal(false);
  });
});
