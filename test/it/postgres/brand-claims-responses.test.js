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
import { ctx } from './harness.js';
import { resetPostgres, seedBrandMarketsFixture } from './seed.js';
import { BRAND_1_ID, ORG_1_ID } from '../shared/seed-ids.js';

describe('Brand Claims response feed persistence boundaries', () => {
  beforeEach(async () => {
    await resetPostgres();
    await seedBrandMarketsFixture();
  });

  it('rejects a soft-deleted market mapping before constructing an upstream request', async () => {
    const url = `/v2/orgs/${ORG_1_ID}/brands/${BRAND_1_ID}`
      + '/serenity/brand-presence/responses'
      + '?geoTargetId=2276&languageCode=de&date=2026-09-07';
    const response = await ctx.httpClient.admin.get(url);

    expect(response.status).to.equal(404);
    expect(response.body.message).to.equal('No owned Semrush project matches the requested market');
  });
});
