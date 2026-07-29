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

import { ProjectEngineApiError } from '@adobe/spacecat-shared-project-engine-client';
import {
  isUpstreamGone,
  ERROR_CODES,
  isPoolExhausted,
  isWorkspaceNotReady,
  isMeteredQuota,
  isRateLimited,
  toQuotaExceededError,
  isSemrushTransportError,
  unwrapTransportCause,
} from '../../../src/support/serenity/errors.js';
import { SerenityTransportError } from '../../../src/support/serenity/rest-transport.js';

use(sinonChai);

// A Project Engine HTTP failure. The facade throws this directly (LLMO-6386, adaptPE retired);
// it carries the same `.status`/`.body` the classifiers key on. `method` is immaterial to
// classification, so a fixed 'POST' is used throughout.
const peErr = (status, body) => new ProjectEngineApiError(status, 'POST', body);

describe('serenity error classification', () => {
  // LLMO-6386: a failing Semrush call now surfaces as ONE of two typed errors — Project Engine
  // ops throw ProjectEngineApiError directly (adaptPE retired), User Manager / brand-topics ops
  // still throw SerenityTransportError. Every classifier must recognise both and reject everything
  // else (plain Errors, ad-hoc objects carrying a matching `.status`).
  describe('isSemrushTransportError', () => {
    it('matches both Semrush transport error types', () => {
      expect(isSemrushTransportError(new SerenityTransportError(500, 'boom'))).to.be.true;
      expect(isSemrushTransportError(peErr(500, null))).to.be.true;
    });
    it('rejects plain Errors, ad-hoc objects, and nullish values', () => {
      expect(isSemrushTransportError(new Error('x'))).to.be.false;
      expect(isSemrushTransportError(new TypeError('x'))).to.be.false;
      expect(isSemrushTransportError({ status: 404, body: 'x' })).to.be.false;
      expect(isSemrushTransportError(null)).to.be.false;
      expect(isSemrushTransportError(undefined)).to.be.false;
    });
  });

  describe('unwrapTransportCause', () => {
    it('unwraps a status-undefined ProjectEngineApiError to its cause (auth 401 preserved)', () => {
      const cause = new SerenityTransportError(401, 'missing token');
      const wrapped = new ProjectEngineApiError(undefined, 'POST', null, { cause });
      expect(unwrapTransportCause(wrapped)).to.equal(cause);
    });
    it('unwraps to a raw network cause (so the generic 500 path is preserved)', () => {
      const cause = new Error('fetch failed');
      const wrapped = new ProjectEngineApiError(undefined, 'GET', null, { cause });
      expect(unwrapTransportCause(wrapped)).to.equal(cause);
    });
    it('leaves a ProjectEngineApiError that carried an HTTP status unchanged', () => {
      const e = peErr(405, '<html>405</html>');
      expect(unwrapTransportCause(e)).to.equal(e);
    });
    it('leaves a status-undefined ProjectEngineApiError with no cause unchanged', () => {
      const e = new ProjectEngineApiError(undefined, 'POST', null);
      expect(unwrapTransportCause(e)).to.equal(e);
    });
    it('passes a SerenityTransportError and other errors through unchanged', () => {
      const ste = new SerenityTransportError(504, 'timeout');
      expect(unwrapTransportCause(ste)).to.equal(ste);
      const plain = new Error('x');
      expect(unwrapTransportCause(plain)).to.equal(plain);
    });
  });

  describe('isUpstreamGone', () => {
    it('matches a SerenityTransportError with status 404', () => {
      expect(isUpstreamGone(new SerenityTransportError(404, 'gone'))).to.be.true;
    });
    it('matches a ProjectEngineApiError with status 404', () => {
      expect(isUpstreamGone(peErr(404, { message: 'not found' }))).to.be.true;
    });
    it('rejects non-404 and non-transport-error shapes', () => {
      expect(isUpstreamGone(new SerenityTransportError(500, 'boom'))).to.be.false;
      expect(isUpstreamGone(peErr(500, null))).to.be.false;
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
      expect(ERROR_CODES.PUBLISH_QUOTA_EXHAUSTED).to.equal('publishQuotaExhausted');
      expect(ERROR_CODES.QUOTA_EXCEEDED).to.equal('quotaExceeded');
      expect(Object.isFrozen(ERROR_CODES)).to.be.true;
    });
  });

  // serenity-docs#72 §2/§4.1 — case 1 (brand carve exhausted, allocator OFF, production today).
  describe('toQuotaExceededError', () => {
    it('returns a 409 ErrorWithStatusCode carrying the quotaExceeded token', () => {
      const e = toQuotaExceededError();
      expect(e.status).to.equal(409);
      expect(e.code).to.equal(ERROR_CODES.QUOTA_EXCEEDED);
    });

    it('the message carries no internal ids/upstream detail (client-safe, mirrors orgPoolExhausted/brandAiLimit)', () => {
      const e = toQuotaExceededError();
      expect(e.message).to.not.match(/workspace|project|semrush/i);
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

    it('isPoolExhausted: also matches a ProjectEngineApiError 422 with the units message', () => {
      expect(isPoolExhausted(peErr(422, { message: 'insufficient available units' }))).to.be.true;
      expect(isPoolExhausted(peErr(422, { message: 'workspace not ready' }))).to.be.false;
      expect(isPoolExhausted(peErr(500, { message: 'insufficient available units' }))).to.be.false;
    });

    it('isPoolExhausted: matches a bare STRING body (bodyText string path), both error types', () => {
      // The gateway can return a bare text body (not JSON); bodyText lowercases it and matches.
      expect(isPoolExhausted(err(422, 'Insufficient Available Units in subscription'))).to.be.true;
      expect(isPoolExhausted(peErr(422, 'insufficient available units'))).to.be.true;
    });

    it('isPoolExhausted: a null/empty body is not a match (bodyText falsy-body path)', () => {
      // unwrap normalises an empty upstream body to null; bodyText must yield '' → no match.
      expect(isPoolExhausted(err(422, null))).to.be.false;
      expect(isPoolExhausted(peErr(422, null))).to.be.false;
    });

    it('isWorkspaceNotReady: only the transient 422 lock', () => {
      expect(isWorkspaceNotReady(err(422, { message: 'workspace not ready' }))).to.be.true;
      expect(isWorkspaceNotReady(err(422, { message: 'insufficient available units' }))).to.be.false;
    });

    it('isWorkspaceNotReady: also matches a ProjectEngineApiError transient 422 lock', () => {
      expect(isWorkspaceNotReady(peErr(422, { message: 'workspace not ready' }))).to.be.true;
      expect(isWorkspaceNotReady(peErr(422, { message: 'insufficient available units' }))).to.be.false;
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

    it('isMeteredQuota: same body-SHAPE rule for a ProjectEngineApiError 405', () => {
      // The disguised-405 quota rejection can now arrive as a ProjectEngineApiError (it is a
      // metered publish/prompt-write, all Project Engine ops). String body → absorbed; JSON body
      // → a genuine app-level 405 that is not absorbed.
      expect(isMeteredQuota(peErr(405, '<html>405 Not Allowed</html>'))).to.be.true;
      expect(isMeteredQuota(peErr(405, ''))).to.be.false;
      expect(isMeteredQuota(peErr(405, { message: 'Method Not Allowed' }))).to.be.false;
      expect(isMeteredQuota(peErr(404, null))).to.be.false;
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

    it('isRateLimited: also matches a ProjectEngineApiError 429', () => {
      expect(isRateLimited(peErr(429, null))).to.be.true;
      expect(isRateLimited(peErr(503, null))).to.be.false;
    });

    it('the disguised-405 metric still fires for a ProjectEngineApiError 405', async () => {
      const recordMeteredQuotaClassifier = sinon.stub();
      const { isMeteredQuota: mocked } = await esmock(
        '../../../src/support/serenity/errors.js',
        { '../../../src/support/serenity/allocation-metrics.js': { recordMeteredQuotaClassifier } },
      );
      mocked(peErr(405, '<html>405 Not Allowed</html>'));
      expect(recordMeteredQuotaClassifier).to.have.been.calledOnceWith(true);
    });
  });
});
