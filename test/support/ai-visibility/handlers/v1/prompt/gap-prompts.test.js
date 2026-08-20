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

/* eslint-disable max-len -- AI Visibility gap-prompts search_type tests */

import { expect } from 'chai';
import sinon from 'sinon';
import { create } from '@bufbuild/protobuf';
import {
  GapPromptsResponseSchema,
  GapPromptsTotalsResponseSchema,
} from '@quazar/ai-seo-ts/v2/prompt/messages_pb.js';
import { ExportResponseSchema } from '@quazar/ai-seo-ts/v2/common/messages_pb.js';
import { SEARCH_TYPE_ENUM } from '@quazar/ai-seo-ts/v2/source/enums_pb.js';
import { handleGapPrompts } from '../../../../../../src/support/ai-visibility/handlers/v1/prompt/gap-prompts.js';
import { handleGapPromptsTotals } from '../../../../../../src/support/ai-visibility/handlers/v1/prompt/gap-prompts-totals.js';
import { handleGapPromptsExport } from '../../../../../../src/support/ai-visibility/handlers/v1/prompt/gap-prompts-export.js';

function sp(query) {
  return new URLSearchParams(query);
}

const APEX = 'domain=intuit.com&competitors=rival.com';
const SUBDOMAIN = 'domain=quickbooks.intuit.com&competitors=rival.com';

describe('AI Visibility – v1 gap-prompts search_type (LLMO-7082)', () => {
  let sandbox;
  let clients;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    clients = {
      promptClient: {
        gapPrompts: sandbox.stub().resolves(create(GapPromptsResponseSchema, { prompts: [] })),
        gapPromptsTotals: sandbox.stub().resolves(create(GapPromptsTotalsResponseSchema, { totals: [] })),
        gapPromptsExport: sandbox.stub().resolves(create(ExportResponseSchema, {})),
      },
    };
  });

  afterEach(() => sandbox.restore());

  describe('handleGapPrompts', () => {
    it('resolves search_type DOMAIN for an apex domain on both list and totals requests', async () => {
      await handleGapPrompts(sp(APEX), clients);
      expect(clients.promptClient.gapPrompts.firstCall.args[0].searchType).to.equal(SEARCH_TYPE_ENUM.DOMAIN);
      expect(clients.promptClient.gapPromptsTotals.firstCall.args[0].searchType).to.equal(SEARCH_TYPE_ENUM.DOMAIN);
    });

    it('resolves search_type SUBDOMAIN for a non-www subdomain on both list and totals requests', async () => {
      await handleGapPrompts(sp(SUBDOMAIN), clients);
      expect(clients.promptClient.gapPrompts.firstCall.args[0].searchType).to.equal(SEARCH_TYPE_ENUM.SUBDOMAIN);
      expect(clients.promptClient.gapPromptsTotals.firstCall.args[0].searchType).to.equal(SEARCH_TYPE_ENUM.SUBDOMAIN);
    });
  });

  describe('handleGapPromptsTotals', () => {
    it('resolves search_type DOMAIN for an apex domain', async () => {
      await handleGapPromptsTotals(sp(APEX), clients);
      expect(clients.promptClient.gapPromptsTotals.firstCall.args[0].searchType).to.equal(SEARCH_TYPE_ENUM.DOMAIN);
    });

    it('resolves search_type SUBDOMAIN for a non-www subdomain', async () => {
      await handleGapPromptsTotals(sp(SUBDOMAIN), clients);
      expect(clients.promptClient.gapPromptsTotals.firstCall.args[0].searchType).to.equal(SEARCH_TYPE_ENUM.SUBDOMAIN);
    });
  });

  describe('handleGapPromptsExport', () => {
    it('resolves search_type DOMAIN for an apex domain on the nested request', async () => {
      await handleGapPromptsExport(sp(APEX), clients);
      expect(clients.promptClient.gapPromptsExport.firstCall.args[0].request.searchType).to.equal(SEARCH_TYPE_ENUM.DOMAIN);
    });

    it('resolves search_type SUBDOMAIN for a non-www subdomain on the nested request', async () => {
      await handleGapPromptsExport(sp(SUBDOMAIN), clients);
      expect(clients.promptClient.gapPromptsExport.firstCall.args[0].request.searchType).to.equal(SEARCH_TYPE_ENUM.SUBDOMAIN);
    });
  });
});
