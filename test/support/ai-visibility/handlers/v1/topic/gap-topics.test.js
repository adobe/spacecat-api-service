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

/* eslint-disable max-len -- AI Visibility gap-topics target_date tests */

import { expect } from 'chai';
import sinon from 'sinon';
import { create } from '@bufbuild/protobuf';
import {
  GapTopicsResponseSchema,
  GapTopicsTotalsResponseSchema,
} from '@quazar/ai-seo-ts/v2/topic/messages_pb.js';
import { ExportResponseSchema } from '@quazar/ai-seo-ts/v2/common/messages_pb.js';
import { handleGapTopics } from '../../../../../../src/support/ai-visibility/handlers/v1/topic/gap-topics.js';
import { handleGapTopicsTotals } from '../../../../../../src/support/ai-visibility/handlers/v1/topic/gap-topics-totals.js';
import { handleGapTopicsExport } from '../../../../../../src/support/ai-visibility/handlers/v1/topic/gap-topics-export.js';

function sp(query) {
  return new URLSearchParams(query);
}

// Shared params so the only thing varying between cases is the `date` snapshot value.
const BASE = 'domain=example.com&competitors=rival.com';

describe('AI Visibility – v1 gap-topics target_date (LLMO-5963)', () => {
  let sandbox;
  let clients;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    clients = {
      topicClient: {
        gapTopics: sandbox.stub().resolves(create(GapTopicsResponseSchema, { topics: [] })),
        gapTopicsTotals: sandbox.stub().resolves(create(GapTopicsTotalsResponseSchema, { totals: [] })),
        gapTopicsExport: sandbox.stub().resolves(create(ExportResponseSchema, {})),
      },
    };
  });

  afterEach(() => sandbox.restore());

  describe('handleGapTopics', () => {
    it('forwards an exact YYYY-MM-DD date as target_date', async () => {
      await handleGapTopics(sp(`${BASE}&date=2026-06-30`), clients);
      expect(clients.topicClient.gapTopics.firstCall.args[0].targetDate).to.equal('2026-06-30');
    });

    it('drops a month-only YYYY-MM date so upstream uses the latest snapshot', async () => {
      await handleGapTopics(sp(`${BASE}&date=2026-07`), clients);
      expect(clients.topicClient.gapTopics.firstCall.args[0].targetDate).to.be.undefined;
    });
  });

  describe('handleGapTopicsTotals', () => {
    it('forwards an exact YYYY-MM-DD date as target_date', async () => {
      await handleGapTopicsTotals(sp(`${BASE}&date=2026-06-30`), clients);
      expect(clients.topicClient.gapTopicsTotals.firstCall.args[0].targetDate).to.equal('2026-06-30');
    });

    it('drops a month-only YYYY-MM date', async () => {
      await handleGapTopicsTotals(sp(`${BASE}&date=2026-07`), clients);
      expect(clients.topicClient.gapTopicsTotals.firstCall.args[0].targetDate).to.be.undefined;
    });
  });

  describe('handleGapTopicsExport', () => {
    it('forwards an exact YYYY-MM-DD date as target_date on the nested request', async () => {
      await handleGapTopicsExport(sp(`${BASE}&date=2026-06-30`), clients);
      expect(clients.topicClient.gapTopicsExport.firstCall.args[0].request.targetDate).to.equal('2026-06-30');
    });

    it('drops a month-only YYYY-MM date', async () => {
      await handleGapTopicsExport(sp(`${BASE}&date=2026-07`), clients);
      expect(clients.topicClient.gapTopicsExport.firstCall.args[0].request.targetDate).to.be.undefined;
    });
  });
});
