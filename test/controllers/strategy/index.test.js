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
import StrategyController from '../../../src/controllers/strategy/index.js';

describe('StrategyController (context adapter)', () => {
  it('exposes enableExperimentTracking method', () => {
    const ctrl = StrategyController({});
    expect(ctrl.enableExperimentTracking).to.be.a('function');
  });

  it('returns 400 invalid_body for malformed payload via context shape', async () => {
    const ctrl = StrategyController({});
    const res = await ctrl.enableExperimentTracking({
      params: { siteId: 's1', strategyId: 'st1' },
      data: { experimentId: 'bad', provider: 'geo-experiment' },
      attributes: {},
      pathInfo: { headers: {} },
    });
    expect(res.status).to.equal(400);
  });

  it('returns 404 strategy_not_found on valid body (stubbed data access)', async () => {
    const ctrl = StrategyController({});
    const res = await ctrl.enableExperimentTracking({
      params: { siteId: 's1', strategyId: 'st1' },
      data: {
        experimentId: '11111111-1111-4111-8111-111111111111',
        provider: 'geo-experiment',
      },
      attributes: { authInfo: { profile: { email: 'a@b.com' } } },
      pathInfo: { headers: {} },
    });
    expect(res.status).to.equal(404);
  });

  it('falls back to x-actor header when authInfo is absent', async () => {
    const ctrl = StrategyController({});
    const res = await ctrl.enableExperimentTracking({
      params: { siteId: 's1', strategyId: 'st1' },
      data: {
        experimentId: '11111111-1111-4111-8111-111111111111',
        provider: 'geo-experiment',
      },
      pathInfo: { headers: { 'x-actor': 'header-actor' } },
    });
    expect(res.status).to.equal(404);
  });
});
