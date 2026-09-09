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
import { StatsByLLMResponseSchema } from '@quazar/ai-seo-ts/v2/brand/messages_pb.js';
import { SEARCH_TYPE_ENUM } from '@quazar/ai-seo-ts/v2/source/enums_pb.js';
import { handleStatsByLLM } from '../../../../../../src/support/ai-visibility/handlers/v1/brand/stats-by-llm.js';

function sp(query) {
  return new URLSearchParams(query);
}

describe('AI Visibility – v1 brand/stats-by-llm search_type (LLMO-7288)', () => {
  let sandbox;
  let clients;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    clients = {
      brandClient: {
        statsByLLM: sandbox.stub().resolves(
          create(StatsByLLMResponseSchema, { byLlm: [] }),
        ),
      },
    };
  });

  afterEach(() => sandbox.restore());

  describe('handleStatsByLLM', () => {
    it('resolves search_type DOMAIN for an apex domain', async () => {
      await handleStatsByLLM(sp('domain=intuit.com'), clients);
      expect(clients.brandClient.statsByLLM.firstCall.args[0].searchType)
        .to.equal(SEARCH_TYPE_ENUM.DOMAIN);
    });

    it('resolves search_type SUBDOMAIN for a non-www subdomain', async () => {
      await handleStatsByLLM(sp('domain=quickbooks.intuit.com'), clients);
      expect(clients.brandClient.statsByLLM.firstCall.args[0].searchType)
        .to.equal(SEARCH_TYPE_ENUM.SUBDOMAIN);
    });

    it('resolves search_type DOMAIN for a bare www subdomain', async () => {
      await handleStatsByLLM(sp('domain=www.intuit.com'), clients);
      expect(clients.brandClient.statsByLLM.firstCall.args[0].searchType)
        .to.equal(SEARCH_TYPE_ENUM.DOMAIN);
    });
  });
});
