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
  taxonomyCacheHeaders,
  metricsCacheHeaders,
} from '../../../src/controllers/llmo/brand-presence-cache-policy.js';

describe('brand-presence cache-policy', () => {
  it('taxonomyCacheHeaders returns the expected Cache-Control directive', () => {
    expect(taxonomyCacheHeaders()).to.deep.equal({
      'Cache-Control': 'private, max-age=3600, stale-while-revalidate=86400',
    });
  });

  it('metricsCacheHeaders returns the expected Cache-Control directive', () => {
    expect(metricsCacheHeaders()).to.deep.equal({
      'Cache-Control': 'private, max-age=300, stale-while-revalidate=900',
    });
  });

  it('returns a fresh, mutable object each call (createResponse mutates it)', () => {
    // Regression guard: createResponse() in @adobe/spacecat-shared-http-utils
    // sets Content-Type by mutating the headers object. If these helpers ever
    // returned a shared or frozen object, that mutation would throw OR leak
    // across requests.
    const a = metricsCacheHeaders();
    const b = metricsCacheHeaders();
    expect(a).to.not.equal(b);
    expect(() => {
      a['Content-Type'] = 'application/json';
    }).to.not.throw();
    expect(b['Content-Type']).to.be.undefined;
  });
});
