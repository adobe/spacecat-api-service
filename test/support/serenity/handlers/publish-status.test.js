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

import { use, expect } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';

import {
  PUBLISH_STATUS,
  PUBLISH_OUTCOME,
  readPublishStatus,
  classifyPublishStatus,
  pollProjectPublished,
} from '../../../../src/support/serenity/handlers/publish-status.js';

use(sinonChai);

const WS = 'workspace-1';
const PID = 'proj-1';

function fakeLog() {
  return {
    info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub(),
  };
}

describe('handlers/publish-status.js (LLMO-5492 / AC3)', () => {
  afterEach(() => sinon.restore());

  describe('readPublishStatus', () => {
    it('reads snake_case publish_status', () => {
      expect(readPublishStatus({ publish_status: 'live' })).to.equal('live');
    });
    it('reads camelCase publishStatus as a fallback', () => {
      expect(readPublishStatus({ publishStatus: 'publishing' })).to.equal('publishing');
    });
    it('returns null when absent / payload missing', () => {
      expect(readPublishStatus({})).to.equal(null);
      expect(readPublishStatus(null)).to.equal(null);
      expect(readPublishStatus(undefined)).to.equal(null);
    });
  });

  describe('classifyPublishStatus', () => {
    it('classifies live and live_with_unpublished_updates as published', () => {
      expect(classifyPublishStatus({ publish_status: PUBLISH_STATUS.LIVE }))
        .to.equal(PUBLISH_OUTCOME.PUBLISHED);
      const lwu = { publish_status: PUBLISH_STATUS.LIVE_WITH_UNPUBLISHED_UPDATES };
      expect(classifyPublishStatus(lwu)).to.equal(PUBLISH_OUTCOME.PUBLISHED);
    });
    it('classifies initial_publish_failed as failed', () => {
      expect(classifyPublishStatus({ publish_status: PUBLISH_STATUS.INITIAL_PUBLISH_FAILED }))
        .to.equal(PUBLISH_OUTCOME.FAILED);
    });
    it('classifies draft, publishing, and unknown/absent as pending', () => {
      expect(classifyPublishStatus({ publish_status: PUBLISH_STATUS.DRAFT }))
        .to.equal(PUBLISH_OUTCOME.PENDING);
      expect(classifyPublishStatus({ publish_status: PUBLISH_STATUS.PUBLISHING }))
        .to.equal(PUBLISH_OUTCOME.PENDING);
      expect(classifyPublishStatus({ publish_status: 'something_new' }))
        .to.equal(PUBLISH_OUTCOME.PENDING);
      expect(classifyPublishStatus({})).to.equal(PUBLISH_OUTCOME.PENDING);
    });
  });

  describe('pollProjectPublished', () => {
    it('returns published on the first read when already live', async () => {
      const transport = {
        getProjectStatus: sinon.stub().resolves({ publish_status: 'live', published_at: 'T0' }),
      };
      const result = await pollProjectPublished(transport, WS, PID);
      expect(result.outcome).to.equal(PUBLISH_OUTCOME.PUBLISHED);
      expect(result.status).to.equal('live');
      expect(result.publishedAt).to.equal('T0');
      expect(result.attempts).to.equal(1);
      expect(transport.getProjectStatus).to.have.been.calledOnceWithExactly(WS, PID);
    });

    it('returns failed with the upstream reason on initial_publish_failed', async () => {
      const transport = {
        getProjectStatus: sinon.stub().resolves({
          publish_status: 'initial_publish_failed',
          publishing_failed_reason: 'upstream rejected location',
        }),
      };
      const result = await pollProjectPublished(transport, WS, PID);
      expect(result.outcome).to.equal(PUBLISH_OUTCOME.FAILED);
      expect(result.failedReason).to.equal('upstream rejected location');
    });

    it('polls until live: draft, then publishing, then live — stops on live', async () => {
      const sleep = sinon.stub().resolves();
      const getProjectStatus = sinon.stub();
      getProjectStatus.onCall(0).resolves({ publish_status: 'draft' });
      getProjectStatus.onCall(1).resolves({ publish_status: 'publishing' });
      getProjectStatus.onCall(2).resolves({ publish_status: 'live' });

      const result = await pollProjectPublished({ getProjectStatus }, WS, PID, {
        attempts: 5, intervalMs: 10, sleep,
      });

      expect(result.outcome).to.equal(PUBLISH_OUTCOME.PUBLISHED);
      expect(getProjectStatus).to.have.been.calledThrice;
      // Slept only between reads (after attempt 1 and 2), not after the final.
      expect(sleep).to.have.been.calledTwice;
    });

    it('returns pending after exhausting attempts when never live (worker reconciles)', async () => {
      const sleep = sinon.stub().resolves();
      const transport = { getProjectStatus: sinon.stub().resolves({ publish_status: 'publishing' }) };

      const result = await pollProjectPublished(transport, WS, PID, {
        attempts: 3, intervalMs: 5, sleep,
      });

      expect(result.outcome).to.equal(PUBLISH_OUTCOME.PENDING);
      expect(result.status).to.equal('publishing');
      expect(transport.getProjectStatus).to.have.been.calledThrice;
      expect(result.attempts).to.equal(3);
    });

    it('treats a status-read error as non-fatal, logs a warning, and reports pending', async () => {
      const log = fakeLog();
      const transport = { getProjectStatus: sinon.stub().rejects(new Error('read 500')) };

      const result = await pollProjectPublished(transport, WS, PID, {
        attempts: 2, sleep: sinon.stub().resolves(), log,
      });

      // poll itself never throws; the read error is surfaced, not propagated.
      expect(result.outcome).to.equal(PUBLISH_OUTCOME.PENDING);
      expect(result.error).to.equal('read 500');
      expect(transport.getProjectStatus).to.have.been.calledTwice;
      expect(log.warn).to.have.been.called;
    });

    it('does not sleep when only a single attempt is requested', async () => {
      const sleep = sinon.stub().resolves();
      const transport = { getProjectStatus: sinon.stub().resolves({ publish_status: 'draft' }) };

      await pollProjectPublished(transport, WS, PID, { attempts: 1, intervalMs: 1000, sleep });

      expect(sleep).to.have.callCount(0);
    });

    it('uses the real setTimeout-backed delay when no sleep is injected', async () => {
      // No `sleep` override → exercises the default setTimeout-backed delay
      // between reads. Tiny interval keeps the test fast; draft→live across two
      // attempts forces exactly one real delay.
      const getProjectStatus = sinon.stub();
      getProjectStatus.onFirstCall().resolves({ publish_status: 'draft' });
      getProjectStatus.onSecondCall().resolves({ publish_status: 'live' });

      const result = await pollProjectPublished({ getProjectStatus }, WS, PID, {
        attempts: 2, intervalMs: 1,
      });

      expect(result.outcome).to.equal('published');
      expect(result.attempts).to.equal(2);
    });
  });
});
