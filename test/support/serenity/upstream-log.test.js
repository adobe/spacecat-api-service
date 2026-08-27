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
import { upstreamLogPayload, logUpstreamError } from '../../../src/support/serenity/upstream-log.js';
import { SerenityTransportError } from '../../../src/support/serenity/serenity-transport-error.js';
import { ElementsTransportError } from '../../../src/support/elements/errors.js';

use(sinonChai);

describe('upstream-log', () => {
  describe('upstreamLogPayload', () => {
    it('merges the error fields over the request context', () => {
      const err = new SerenityTransportError(
        403,
        'Semrush GET https://gw/v1/workspaces/ws-1/family failed: 403',
        { message: 'no role' },
        { method: 'GET', endpoint: '/v1/workspaces/ws-1/family' },
      );
      const payload = upstreamLogPayload(err, { spaceCatId: 'org-1', brandId: 'brand-1', workspaceId: 'ws-1' });
      expect(payload.status).to.equal(403);
      expect(payload.method).to.equal('GET');
      expect(payload.endpoint).to.equal('/v1/workspaces/ws-1/family');
      expect(payload.spaceCatId).to.equal('org-1');
      expect(payload.brandId).to.equal('brand-1');
      expect(payload.workspaceId).to.equal('ws-1');
      expect(payload.message).to.include('failed: 403');
      expect(payload.body).to.equal(JSON.stringify({ message: 'no role' }));
    });

    it('emits the workspace/element ids an ElementsTransportError carries', () => {
      const err = new ElementsTransportError(403, 'Elements API POST https://gw/x failed: 403', 'denied', {
        method: 'POST', endpoint: '/x', workspaceId: 'ws-9', elementId: 'el-1',
      });
      const payload = upstreamLogPayload(err, {});
      expect(payload.workspaceId).to.equal('ws-9');
      expect(payload.elementId).to.equal('el-1');
      expect(payload.body).to.equal('denied');
    });

    it('lets the error-attached workspaceId win over the request-context one', () => {
      const err = new ElementsTransportError(500, 'x', null, { workspaceId: 'ws-from-error' });
      const payload = upstreamLogPayload(err, { workspaceId: 'ws-from-ctx' });
      expect(payload.workspaceId).to.equal('ws-from-error');
    });

    it('omits body when the error carries none (null or undefined)', () => {
      expect(upstreamLogPayload(new SerenityTransportError(504, 'timed out', null), {}))
        .to.not.have.property('body');
      expect(upstreamLogPayload(new SerenityTransportError(504, 'timed out'), {}))
        .to.not.have.property('body');
    });

    it('scrubs secrets from the body before logging', () => {
      const err = new SerenityTransportError(403, 'failed', {
        detail: 'call with Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345 was refused',
      });
      const payload = upstreamLogPayload(err, {});
      expect(payload.body).to.not.include('abcdefghijklmnopqrstuvwxyz012345');
      expect(payload.body).to.include('[[REDACTED:bearer_token]]');
    });

    it('truncates an oversized body to the bound', () => {
      const err = new SerenityTransportError(500, 'failed', 'x'.repeat(5000));
      const payload = upstreamLogPayload(err, {});
      expect(payload.body).to.have.length.below(2100);
      expect(payload.body).to.match(/\.\.\.\[truncated\]$/);
    });

    it('tolerates a non-object error', () => {
      const payload = upstreamLogPayload(undefined, { spaceCatId: 'org-1' });
      expect(payload).to.deep.equal({ spaceCatId: 'org-1' });
    });
  });

  describe('logUpstreamError', () => {
    it('emits one line with the label and the JSON payload parseable from the message', () => {
      const log = { error: sinon.stub() };
      const err = new SerenityTransportError(409, 'conflict upstream', { code: 'dup' }, { method: 'POST', endpoint: '/v3/prompts' });
      logUpstreamError(log, 'Serenity upstream error', err, { brandId: 'brand-1' });
      expect(log.error).to.have.been.calledOnce;
      const line = log.error.firstCall.args[0];
      // The STACK rides along as the second argument (never the error object:
      // console.error would render its raw un-scrubbed .body); the JSON
      // payload in the message stays parse-able regardless.
      expect(log.error.firstCall.args[1]).to.equal(err.stack);
      expect(line.startsWith('Serenity upstream error {')).to.equal(true);
      const parsed = JSON.parse(line.slice('Serenity upstream error '.length));
      expect(parsed.status).to.equal(409);
      expect(parsed.method).to.equal('POST');
      expect(parsed.endpoint).to.equal('/v3/prompts');
      expect(parsed.brandId).to.equal('brand-1');
    });

    it('never lets the raw body reach any log argument', () => {
      const log = { error: sinon.stub() };
      const err = new SerenityTransportError(403, 'failed', {
        hint: 'sent Bearer abcdefghijklmnopqrstuvwxyz012345',
      });
      logUpstreamError(log, 'Serenity upstream error', err);
      const rendered = log.error.firstCall.args.map(String).join(' ');
      expect(rendered).to.not.include('abcdefghijklmnopqrstuvwxyz012345');
      expect(rendered).to.include('[[REDACTED:bearer_token]]');
    });

    it('logs a single argument when the value is not an Error', () => {
      const log = { error: sinon.stub() };
      logUpstreamError(log, 'Serenity upstream error', 'not-an-error', { brandId: 'brand-1' });
      expect(log.error.firstCall.args).to.have.length(1);
      const parsed = JSON.parse(log.error.firstCall.args[0].slice('Serenity upstream error '.length));
      expect(parsed.brandId).to.equal('brand-1');
    });
  });
});
