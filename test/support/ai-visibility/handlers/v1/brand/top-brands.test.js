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
import { TopBrandsByDomainResponseSchema } from '@quazar/ai-seo-ts/v2/brand/messages_pb.js';
import { SEARCH_TYPE_ENUM } from '@quazar/ai-seo-ts/v2/source/enums_pb.js';
import { handleTopBrands } from '../../../../../../src/support/ai-visibility/handlers/v1/brand/top-brands.js';

function sp(query) {
  return new URLSearchParams(query);
}

describe('AI Visibility – v1 brand/top-brands search_type (LLMO-7261)', () => {
  let sandbox;
  let clients;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    clients = {
      brandClient: {
        topBrandsByDomain: sandbox.stub().resolves(
          create(TopBrandsByDomainResponseSchema, { brands: [] }),
        ),
      },
    };
  });

  afterEach(() => sandbox.restore());

  describe('handleTopBrands', () => {
    it('resolves search_type DOMAIN for an apex domain', async () => {
      await handleTopBrands(sp('domain=intuit.com'), clients);
      expect(clients.brandClient.topBrandsByDomain.firstCall.args[0].searchType)
        .to.equal(SEARCH_TYPE_ENUM.DOMAIN);
    });

    it('resolves search_type SUBDOMAIN for a non-www subdomain', async () => {
      await handleTopBrands(sp('domain=quickbooks.intuit.com'), clients);
      expect(clients.brandClient.topBrandsByDomain.firstCall.args[0].searchType)
        .to.equal(SEARCH_TYPE_ENUM.SUBDOMAIN);
    });

    it('resolves search_type DOMAIN for a bare www subdomain', async () => {
      await handleTopBrands(sp('domain=www.intuit.com'), clients);
      expect(clients.brandClient.topBrandsByDomain.firstCall.args[0].searchType)
        .to.equal(SEARCH_TYPE_ENUM.DOMAIN);
    });

    it('returns 400 and issues no gRPC call when domain is missing', async () => {
      const result = await handleTopBrands(sp(''), clients);
      expect(result.status).to.equal(400);
      expect(clients.brandClient.topBrandsByDomain).to.have.property('callCount', 0);
    });
  });
});
