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

import { expect, use } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import { KEYWORD_INTENT_ENUM } from '@quazar/ai-seo-ts/v2/fanout/enums_pb.js';
import {
  intentNameFromEnum,
  resolveTopicMetricsBatched,
} from '../../../src/support/fanout/semrush-client.js';

use(sinonChai);

describe('intentNameFromEnum', () => {
  it('maps known enum values to their string names', () => {
    expect(intentNameFromEnum([KEYWORD_INTENT_ENUM.COMMERCIAL])).to.equal('COMMERCIAL');
    expect(intentNameFromEnum([KEYWORD_INTENT_ENUM.INFORMATIONAL])).to.equal('INFORMATIONAL');
    expect(intentNameFromEnum([KEYWORD_INTENT_ENUM.NAVIGATIONAL])).to.equal('NAVIGATIONAL');
    expect(intentNameFromEnum([KEYWORD_INTENT_ENUM.TRANSACTIONAL])).to.equal('TRANSACTIONAL');
    expect(intentNameFromEnum([KEYWORD_INTENT_ENUM.UNSPECIFIED])).to.equal('UNSPECIFIED');
  });

  it('picks the first intent from a multi-label array', () => {
    expect(intentNameFromEnum([
      KEYWORD_INTENT_ENUM.COMMERCIAL,
      KEYWORD_INTENT_ENUM.INFORMATIONAL,
    ])).to.equal('COMMERCIAL');
  });

  it('returns undefined for empty or null input', () => {
    expect(intentNameFromEnum([])).to.equal(undefined);
    expect(intentNameFromEnum(null)).to.equal(undefined);
    expect(intentNameFromEnum(undefined)).to.equal(undefined);
  });

  it('falls back to UNSPECIFIED for unknown enum values', () => {
    expect(intentNameFromEnum([999])).to.equal('UNSPECIFIED');
  });
});

describe('resolveTopicMetricsBatched', () => {
  let fanoutClient;
  let log;

  beforeEach(() => {
    fanoutClient = { resolveTopicMetrics: sinon.stub() };
    log = { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() };
  });

  it('returns an empty result for empty topic input without calling Semrush', async () => {
    const out = await resolveTopicMetricsBatched({ fanoutClient, topics: [], log });

    expect(out.byOriginal.size).to.equal(0);
    expect(out.isoDate).to.equal(null);
    expect(fanoutClient.resolveTopicMetrics).not.to.have.been.called;
  });

  it('chunks the topic list into batches of batchSize', async () => {
    fanoutClient.resolveTopicMetrics.callsFake(({ topics }) => Promise.resolve({
      isoDate: '2026-05-08',
      topicMetrics: topics.map((name) => ({ originalTopic: name })),
    }));

    const topics = Array.from({ length: 7 }, (_, i) => `t${i}`);
    const out = await resolveTopicMetricsBatched({
      fanoutClient, topics, batchSize: 3, concurrency: 1, log,
    });

    expect(fanoutClient.resolveTopicMetrics).to.have.been.calledThrice;
    expect(fanoutClient.resolveTopicMetrics.getCall(0).args[0].topics).to.have.length(3);
    expect(fanoutClient.resolveTopicMetrics.getCall(1).args[0].topics).to.have.length(3);
    expect(fanoutClient.resolveTopicMetrics.getCall(2).args[0].topics).to.have.length(1);
    expect(out.byOriginal.size).to.equal(7);
    expect(out.isoDate).to.equal('2026-05-08');
  });

  it('retries with backoff on rate-limit errors (code 8)', async () => {
    const rateErr = Object.assign(new Error('quota'), { code: 8 });
    fanoutClient.resolveTopicMetrics
      .onFirstCall().rejects(rateErr)
      .onSecondCall().resolves({ isoDate: '2026-05-08', topicMetrics: [] });

    // Avoid sleeping for real in the test.
    const clock = sinon.useFakeTimers();
    try {
      const promise = resolveTopicMetricsBatched({
        fanoutClient, topics: ['a'], batchSize: 100, concurrency: 1, log,
      });
      await clock.tickAsync(600); // ≥ 500ms first retry delay
      await promise;
      expect(fanoutClient.resolveTopicMetrics).to.have.been.calledTwice;
      expect(log.warn).to.have.been.called;
    } finally {
      clock.restore();
    }
  });

  it('rethrows after exhausting retries', async () => {
    const rateErr = Object.assign(new Error('quota'), { code: 8 });
    fanoutClient.resolveTopicMetrics.rejects(rateErr);

    const clock = sinon.useFakeTimers();
    try {
      const promise = resolveTopicMetricsBatched({
        fanoutClient, topics: ['a'], batchSize: 100, concurrency: 1, log,
      });
      // Tick past 500 + 2000 + 8000 = 10500ms of retries
      await clock.tickAsync(15_000);
      let thrown;
      try {
        await promise;
      } catch (e) {
        thrown = e;
      }
      expect(thrown?.message).to.equal('quota');
      // initial + 3 retries
      expect(fanoutClient.resolveTopicMetrics.callCount).to.equal(4);
    } finally {
      clock.restore();
    }
  });

  it('does not retry non-rate-limit errors', async () => {
    fanoutClient.resolveTopicMetrics.rejects(new Error('schema mismatch'));

    let thrown;
    try {
      await resolveTopicMetricsBatched({
        fanoutClient, topics: ['a'], batchSize: 100, concurrency: 1, log,
      });
    } catch (e) {
      thrown = e;
    }

    expect(thrown?.message).to.equal('schema mismatch');
    expect(fanoutClient.resolveTopicMetrics).to.have.been.calledOnce;
  });
});
