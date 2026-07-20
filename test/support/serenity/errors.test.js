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
import esmock from 'esmock';

import {
  isUpstreamGone,
  ERROR_CODES,
  isPoolExhausted,
  isWorkspaceNotReady,
  isMeteredQuota,
  isRateLimited,
} from '../../../src/support/serenity/errors.js';
import { SerenityTransportError } from '../../../src/support/serenity/rest-transport.js';

use(sinonChai);

describe('serenity error classification', () => {
  describe('isUpstreamGone', () => {
    it('matches a SerenityTransportError with status 404', () => {
      expect(isUpstreamGone(new SerenityTransportError(404, 'gone'))).to.be.true;
    });
    it('rejects non-404 and non-SerenityTransportError shapes', () => {
      expect(isUpstreamGone(new SerenityTransportError(500, 'boom'))).to.be.false;
      expect(isUpstreamGone({ status: 404 })).to.be.false;
      expect(isUpstreamGone(new Error('x'))).to.be.false;
    });
  });

  describe('ERROR_CODES', () => {
    it('exposes the serenity error tokens and is frozen', () => {
      expect(ERROR_CODES.MARKET_NOT_FOUND).to.equal('marketNotFound');
      expect(ERROR_CODES.AMBIGUOUS_WORKSPACE).to.equal('ambiguousWorkspace');
      expect(ERROR_CODES.LINKED_SUBWORKSPACES).to.equal('linkedSubworkspaces');
      expect(ERROR_CODES.ORG_POOL_EXHAUSTED).to.equal('orgPoolExhausted');
      expect(ERROR_CODES.BRAND_AI_LIMIT).to.equal('brandAiLimit');
      expect(Object.isFrozen(ERROR_CODES)).to.be.true;
    });
  });

  describe('dynamic-allocation classifiers (body/message, not status alone)', () => {
    const err = (status, body) => new SerenityTransportError(status, 'upstream', body);

    it('isPoolExhausted: only a 422 whose message says insufficient units', () => {
      expect(isPoolExhausted(err(422, { message: 'insufficient available units in subscription' }))).to.be.true;
      expect(isPoolExhausted(err(422, { message: 'workspace not ready' }))).to.be.false; // transient, not exhaustion
      expect(isPoolExhausted(err(422, {}))).to.be.false; // object without a message → no match
      expect(isPoolExhausted(err(500, { message: 'insufficient available units' }))).to.be.false;
      expect(isPoolExhausted(new Error('x'))).to.be.false;
    });

    it('isWorkspaceNotReady: only the transient 422 lock', () => {
      expect(isWorkspaceNotReady(err(422, { message: 'workspace not ready' }))).to.be.true;
      expect(isWorkspaceNotReady(err(422, { message: 'insufficient available units' }))).to.be.false;
    });

    it('isMeteredQuota: keys on body SHAPE, not content — a string body is the disguised quota rejection, a JSON body is a genuine app-level error', () => {
      // Live-verified pinned fixture (Rainer, LLMO-6190, LLMO-Dev-2) — the real disguised-405 body
      // carries NO "quota"/"allocation exhausted" text at all, just a bare nginx page.
      const PINNED_DISGUISED_405_BODY = '<html>\r\n<head><title>405 Not Allowed</title></head>\r\n<body>\r\n<center><h1>405 Not Allowed</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n';
      expect(isMeteredQuota(err(405, PINNED_DISGUISED_405_BODY))).to.be.true;
      expect(isMeteredQuota(err(405, 'quota exceeded'))).to.be.true; // any non-empty string body
      expect(isMeteredQuota(err(405, ''))).to.be.false; // empty string carries no signal
      // A genuine app-level Method-Not-Allowed always arrives as JSON on this gateway — never
      // absorbed, regardless of what its message says.
      expect(isMeteredQuota(err(405, { message: 'Method Not Allowed' }))).to.be.false;
      expect(isMeteredQuota(err(405, { message: 'Quota exceeded' }))).to.be.false;
      expect(isMeteredQuota(err(405, null))).to.be.false;
      expect(isMeteredQuota(err(404, null))).to.be.false;
    });

    describe('isMeteredQuota — MeteredQuotaClassifier metric only fires for actual 405s', () => {
      let sandbox;
      let recordMeteredQuotaClassifier;
      let isMeteredQuotaMocked;

      beforeEach(async () => {
        sandbox = sinon.createSandbox();
        recordMeteredQuotaClassifier = sandbox.stub();
        ({ isMeteredQuota: isMeteredQuotaMocked } = await esmock(
          '../../../src/support/serenity/errors.js',
          { '../../../src/support/serenity/allocation-metrics.js': { recordMeteredQuotaClassifier } },
        ));
      });

      afterEach(() => sandbox.restore());

      it('does NOT emit the metric for a non-405 (would drown the 405 ratio otherwise)', () => {
        isMeteredQuotaMocked(err(404, null));
        isMeteredQuotaMocked(new TypeError('boom'));
        expect(recordMeteredQuotaClassifier).to.not.have.been.called;
      });

      it('emits Matched=true for the disguised-405 shape (string body)', () => {
        isMeteredQuotaMocked(err(405, '<html>405 Not Allowed</html>'));
        expect(recordMeteredQuotaClassifier).to.have.been.calledOnceWith(true);
      });

      it('emits Matched=false for a legitimate (JSON-bodied) 405', () => {
        isMeteredQuotaMocked(err(405, { message: 'Method Not Allowed' }));
        expect(recordMeteredQuotaClassifier).to.have.been.calledOnceWith(false);
      });
    });

    it('isRateLimited: a 429', () => {
      expect(isRateLimited(err(429, null))).to.be.true;
      expect(isRateLimited(err(503, null))).to.be.false;
    });
  });
});
