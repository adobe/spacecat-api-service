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
  isPublishQuotaExhausted,
  ERROR_CODES,
} from '../../../src/support/serenity/errors.js';
import { SerenityTransportError } from '../../../src/support/serenity/rest-transport.js';

describe('support/serenity/errors.js', () => {
  describe('isUpstreamGone', () => {
    it('is true for a SerenityTransportError with status 404', () => {
      expect(isUpstreamGone(new SerenityTransportError(404, 'gone'))).to.be.true;
    });

    it('is false for other statuses / non-transport errors / look-alikes', () => {
      expect(isUpstreamGone(new SerenityTransportError(500, 'boom'))).to.be.false;
      expect(isUpstreamGone(new Error('plain'))).to.be.false;
      expect(isUpstreamGone({ status: 404 })).to.be.false;
      expect(isUpstreamGone(null)).to.be.false;
    });
  });

  describe('isPublishQuotaExhausted', () => {
    it('is true only for a 405 SerenityTransportError carrying text/html', () => {
      const e = new SerenityTransportError(405, 'nope', '<html>405</html>', 'text/html');
      expect(isPublishQuotaExhausted(e)).to.be.true;
    });

    it('matches text/html with a charset suffix (case-insensitive)', () => {
      const e = new SerenityTransportError(405, 'nope', '<html/>', 'Text/HTML; charset=UTF-8');
      expect(isPublishQuotaExhausted(e)).to.be.true;
    });

    it('is false for a 405 that carries a JSON envelope (real app-layer 405)', () => {
      const e = new SerenityTransportError(405, 'method not allowed', { error: 'x' }, 'application/json');
      expect(isPublishQuotaExhausted(e)).to.be.false;
    });

    it('is false for a 405 with no content-type', () => {
      const e = new SerenityTransportError(405, 'nope', null);
      expect(isPublishQuotaExhausted(e)).to.be.false;
    });

    it('is false for other statuses, even with text/html', () => {
      const e = new SerenityTransportError(503, 'down', '<html/>', 'text/html');
      expect(isPublishQuotaExhausted(e)).to.be.false;
    });

    it('is false for non-transport errors and look-alikes', () => {
      expect(isPublishQuotaExhausted(new Error('plain'))).to.be.false;
      expect(isPublishQuotaExhausted({ status: 405, contentType: 'text/html' })).to.be.false;
      expect(isPublishQuotaExhausted(null)).to.be.false;
    });
  });

  describe('ERROR_CODES', () => {
    it('exposes the publish-quota token and is frozen', () => {
      expect(ERROR_CODES.PUBLISH_QUOTA_EXHAUSTED).to.equal('publishQuotaExhausted');
      expect(ERROR_CODES.MARKET_NOT_FOUND).to.equal('marketNotFound');
      expect(Object.isFrozen(ERROR_CODES)).to.be.true;
    });
  });
});
