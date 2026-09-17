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
import { BrandCompetitorsResponseSchema } from '@quazar/ai-seo-ts/v2/competitor/messages_pb.js';
import { SEARCH_TYPE_ENUM } from '@quazar/ai-seo-ts/v2/source/enums_pb.js';
import { handleCompetitors } from '../../../../../../src/support/ai-visibility/handlers/v1/brand/competitors.js';

function sp(query) {
  return new URLSearchParams(query);
}

describe('AI Visibility – v1 brand/competitors search_type (LLMO-7016)', () => {
  let sandbox;
  let clients;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    clients = {
      competitorClient: {
        brandCompetitors: sandbox.stub().resolves(
          create(BrandCompetitorsResponseSchema, { competitors: [] }),
        ),
      },
    };
  });

  afterEach(() => sandbox.restore());

  describe('handleCompetitors', () => {
    it('returns 400 when domain is missing', async () => {
      const res = await handleCompetitors(sp(''), clients);
      expect(res.status).to.equal(400);
      expect(res.body.error).to.equal('invalid_request');
    });

    it('resolves search_type DOMAIN for an apex domain', async () => {
      await handleCompetitors(sp('domain=intuit.com'), clients);
      expect(clients.competitorClient.brandCompetitors.firstCall.args[0].searchType)
        .to.equal(SEARCH_TYPE_ENUM.DOMAIN);
    });

    it('resolves search_type SUBDOMAIN for a non-www subdomain', async () => {
      await handleCompetitors(sp('domain=quickbooks.intuit.com'), clients);
      expect(clients.competitorClient.brandCompetitors.firstCall.args[0].searchType)
        .to.equal(SEARCH_TYPE_ENUM.SUBDOMAIN);
    });

    it('resolves search_type DOMAIN for a bare www subdomain', async () => {
      await handleCompetitors(sp('domain=www.intuit.com'), clients);
      expect(clients.competitorClient.brandCompetitors.firstCall.args[0].searchType)
        .to.equal(SEARCH_TYPE_ENUM.DOMAIN);
    });
  });
});
