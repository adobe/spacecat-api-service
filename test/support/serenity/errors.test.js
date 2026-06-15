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
  isAllocationFailure,
  isWorkspaceNotReady,
  isWorkspaceDrift,
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

  describe('isAllocationFailure', () => {
    it('matches a 405 with a non-JSON (HTML string) body', () => {
      const e = new SerenityTransportError(405, 'method not allowed', '<html>405</html>');
      expect(isAllocationFailure(e)).to.be.true;
    });
    it('rejects a 405 with a JSON (object) body', () => {
      const e = new SerenityTransportError(405, 'method not allowed', { code: 'method_not_allowed' });
      expect(isAllocationFailure(e)).to.be.false;
    });
    it('rejects other statuses and foreign error shapes', () => {
      expect(isAllocationFailure(new SerenityTransportError(403, 'no', '<html/>'))).to.be.false;
      expect(isAllocationFailure({ status: 405, body: '<html/>' })).to.be.false;
    });
  });

  describe('isWorkspaceNotReady', () => {
    it('matches a SerenityTransportError with status 500', () => {
      expect(isWorkspaceNotReady(new SerenityTransportError(500, 'not ready'))).to.be.true;
    });
    it('rejects other statuses and foreign shapes', () => {
      expect(isWorkspaceNotReady(new SerenityTransportError(404, 'x'))).to.be.false;
      expect(isWorkspaceNotReady({ status: 500 })).to.be.false;
    });
  });

  describe('isWorkspaceDrift', () => {
    it('matches a SerenityTransportError with status 403', () => {
      expect(isWorkspaceDrift(new SerenityTransportError(403, 'invalid access attempt'))).to.be.true;
    });
    it('rejects other statuses and foreign shapes', () => {
      expect(isWorkspaceDrift(new SerenityTransportError(404, 'x'))).to.be.false;
      expect(isWorkspaceDrift({ status: 403 })).to.be.false;
    });
  });

  describe('ERROR_CODES', () => {
    it('exposes the sub-workspace provisioning tokens and is frozen', () => {
      expect(ERROR_CODES.ALLOCATION_FAILURE).to.equal('allocationFailure');
      expect(ERROR_CODES.WORKSPACE_NOT_READY).to.equal('workspaceNotReady');
      expect(ERROR_CODES.WORKSPACE_DRIFT).to.equal('workspaceDrift');
      expect(ERROR_CODES.AMBIGUOUS_WORKSPACE).to.equal('ambiguousWorkspace');
      expect(Object.isFrozen(ERROR_CODES)).to.be.true;
    });
  });
});
