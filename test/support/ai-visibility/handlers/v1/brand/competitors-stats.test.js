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
import sinon from 'sinon';
import { create } from '@bufbuild/protobuf';
import { StatsResponseSchema } from '@quazar/ai-seo-ts/v2/competitor/messages_pb.js';
import { SEARCH_TYPE_ENUM } from '@quazar/ai-seo-ts/v2/source/enums_pb.js';
import { handleCompetitorsStats } from '../../../../../../src/support/ai-visibility/handlers/v1/brand/competitors-stats.js';

function sp(query) {
  return new URLSearchParams(query);
}

describe('AI Visibility – v1 brand/competitors-stats search_type (LLMO-7101)', () => {
  let sandbox;
  let clients;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    clients = {
      competitorClient: {
        stats: sandbox.stub().resolves(
          create(StatsResponseSchema, { byBrand: [] }),
        ),
      },
      // The legacy v1 client stays wired for handlers/competitors.js; this handler
      // must no longer reach for it.
      crMetricsClient: {
        stats: sandbox.stub(),
      },
    };
  });

  afterEach(() => sandbox.restore());

  describe('handleCompetitorsStats', () => {
    it('resolves search_type DOMAIN for an apex domain', async () => {
      await handleCompetitorsStats(sp('domain=intuit.com&competitors=hrblock.com'), clients);
      expect(clients.competitorClient.stats.firstCall.args[0].searchType)
        .to.equal(SEARCH_TYPE_ENUM.DOMAIN);
    });

    it('resolves search_type SUBDOMAIN for a non-www subdomain', async () => {
      await handleCompetitorsStats(sp('domain=turbotax.intuit.com&competitors=hrblock.com'), clients);
      expect(clients.competitorClient.stats.firstCall.args[0].searchType)
        .to.equal(SEARCH_TYPE_ENUM.SUBDOMAIN);
    });

    it('resolves search_type DOMAIN for a bare www subdomain', async () => {
      await handleCompetitorsStats(sp('domain=www.intuit.com&competitors=hrblock.com'), clients);
      expect(clients.competitorClient.stats.firstCall.args[0].searchType)
        .to.equal(SEARCH_TYPE_ENUM.DOMAIN);
    });

    it('calls the v2 competitor service and not the legacy v1 metrics client', async () => {
      await handleCompetitorsStats(sp('domain=intuit.com&competitors=hrblock.com'), clients);
      expect(clients.competitorClient.stats).to.have.property('callCount', 1);
      expect(clients.crMetricsClient.stats).to.have.property('callCount', 0);
    });
  });
});
