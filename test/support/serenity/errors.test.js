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
      expect(Object.isFrozen(ERROR_CODES)).to.be.true;
    });
  });
});
