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

import {
  isUpstreamGone,
  ERROR_CODES,
  isPoolExhausted,
  isWorkspaceNotReady,
  isMeteredQuota,
  isRateLimited,
} from '../../../src/support/serenity/errors.js';
import { SerenityTransportError } from '../../../src/support/serenity/rest-transport.js';

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
      expect(isPoolExhausted(err(500, { message: 'insufficient available units' }))).to.be.false;
      expect(isPoolExhausted(new Error('x'))).to.be.false;
    });

    it('isWorkspaceNotReady: only the transient 422 lock', () => {
      expect(isWorkspaceNotReady(err(422, { message: 'workspace not ready' }))).to.be.true;
      expect(isWorkspaceNotReady(err(422, { message: 'insufficient available units' }))).to.be.false;
    });

    it('isMeteredQuota: a 405 with a quota message, a text/html body, or no body', () => {
      expect(isMeteredQuota(err(405, { message: 'Quota exceeded' }))).to.be.true;
      expect(isMeteredQuota(err(405, '<html>method not allowed</html>'))).to.be.true;
      expect(isMeteredQuota(err(405, null))).to.be.true;
      expect(isMeteredQuota(err(404, null))).to.be.false;
    });

    it('isRateLimited: a 429', () => {
      expect(isRateLimited(err(429, null))).to.be.true;
      expect(isRateLimited(err(503, null))).to.be.false;
    });
  });
});
