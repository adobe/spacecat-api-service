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
/* eslint-env mocha */
import { expect } from 'chai';
import sinon from 'sinon';
import { CloudManagerClient, createCloudManagerClient } from '../../src/support/cloud-manager.js';

const payload = (obj) => ({ Payload: Buffer.from(JSON.stringify(obj)) });
const log = { info: () => {}, warn: () => {}, error: () => {} };

describe('CloudManagerClient', () => {
  let sandbox;
  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });
  afterEach(() => {
    sandbox.restore();
  });

  describe('enabled', () => {
    it('is false without a function name', () => {
      expect(new CloudManagerClient({ log }).enabled).to.equal(false);
    });
    it('is true with a function name', () => {
      expect(new CloudManagerClient({ functionName: 'fn', log }).enabled).to.equal(true);
    });
  });

  describe('invokeAction', () => {
    it('sends an InvokeCommand and parses the JSON payload', async () => {
      const c = new CloudManagerClient({ functionName: 'fn', log });
      const send = sandbox.stub(c.client, 'send').resolves(payload({ ok: true, statusCode: 200 }));
      const res = await c.invokeAction({ action: 'get_program', programId: 'p1' });
      expect(res).to.deep.equal({ ok: true, statusCode: 200 });
      const sent = send.firstCall.args[0].input;
      expect(sent.FunctionName).to.equal('fn');
      expect(sent.InvocationType).to.equal('RequestResponse');
      expect(JSON.parse(Buffer.from(sent.Payload).toString())).to.deep.equal({ action: 'get_program', programId: 'p1' });
    });

    it('throws when not configured', async () => {
      const c = new CloudManagerClient({ log });
      await expect(c.invokeAction({ action: 'x' })).to.be.rejectedWith(/not configured/);
    });

    it('throws on a Lambda FunctionError', async () => {
      const c = new CloudManagerClient({ functionName: 'fn', log });
      sandbox.stub(c.client, 'send').resolves({ FunctionError: 'Unhandled', Payload: Buffer.from('{"errorMessage":"boom"}') });
      await expect(c.invokeAction({ action: 'x' })).to.be.rejectedWith(/connector error \(Unhandled\)/);
    });

    it('throws on a non-JSON payload', async () => {
      const c = new CloudManagerClient({ functionName: 'fn', log });
      sandbox.stub(c.client, 'send').resolves({ Payload: Buffer.from('not json') });
      await expect(c.invokeAction({ action: 'x' })).to.be.rejectedWith(/non-JSON/);
    });
  });

  describe('verifyProgram (graceful degradation)', () => {
    it('degrades (no throw) when the connector is not configured', async () => {
      const res = await new CloudManagerClient({ log }).verifyProgram('p1');
      expect(res).to.deep.equal({ verified: false, degraded: true });
    });

    it('degrades when no programId is supplied', async () => {
      const c = new CloudManagerClient({ functionName: 'fn', log });
      const send = sandbox.stub(c.client, 'send');
      const res = await c.verifyProgram(undefined);
      expect(res.degraded).to.equal(true);
      expect(send.called).to.equal(false);
    });

    it('returns verified:true when CM confirms the program', async () => {
      const c = new CloudManagerClient({ functionName: 'fn', log });
      sandbox.stub(c.client, 'send').resolves(payload({ ok: true, statusCode: 200, data: { id: 'p1' } }));
      const res = await c.verifyProgram('p1');
      expect(res.verified).to.equal(true);
      expect(res.program).to.deep.equal({ id: 'p1' });
    });

    it('returns verified:false (not degraded) when CM responds not-ok', async () => {
      const c = new CloudManagerClient({ functionName: 'fn', log });
      sandbox.stub(c.client, 'send').resolves(payload({ ok: false, statusCode: 404 }));
      const res = await c.verifyProgram('p1');
      expect(res).to.include({ verified: false, statusCode: 404 });
      expect(res.degraded).to.equal(undefined);
    });

    it('degrades when the invocation throws (e.g. AccessDenied before IAM grant)', async () => {
      const c = new CloudManagerClient({ functionName: 'fn', log });
      sandbox.stub(c.client, 'send').rejects(new Error('AccessDeniedException'));
      const res = await c.verifyProgram('p1');
      expect(res).to.include({ verified: false, degraded: true });
      expect(res.error).to.match(/AccessDenied/);
    });
  });

  describe('createCloudManagerClient', () => {
    it('reads function name from env and region from runtime', () => {
      const c = createCloudManagerClient({
        env: { CM_CONNECTOR_FUNCTION_NAME: 'spacecat-services--cm-connector' },
        runtime: { region: 'us-east-1' },
        log,
      });
      expect(c.enabled).to.equal(true);
      expect(c.functionName).to.equal('spacecat-services--cm-connector');
    });

    it('is disabled when the env var is absent', () => {
      expect(createCloudManagerClient({ env: {}, log }).enabled).to.equal(false);
    });
  });
});
