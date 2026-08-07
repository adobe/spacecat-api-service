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
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import { mintSemrushImsToken } from '../../../src/support/serenity/semrush-ims-token.js';

use(sinonChai);

const ENV = {
  IMS_HOST: 'ims-na1-stg1.adobelogin.com',
  SEMRUSH_IMS_TECH_ID: 'tech-client-id',
  SEMRUSH_IMS_TECH_SECRET: 'tech-client-secret',
};

function fakeResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: sinon.stub().resolves(body),
  };
}

function fakeLog() {
  return { error: sinon.stub() };
}

describe('mintSemrushImsToken', () => {
  let fetchStub;

  beforeEach(() => {
    fetchStub = sinon.stub(globalThis, 'fetch');
  });

  afterEach(() => sinon.restore());

  it('mints a token via client_credentials and returns the access_token', async () => {
    fetchStub.resolves(fakeResponse(200, { access_token: 'minted-abc', token_type: 'bearer' }));

    const token = await mintSemrushImsToken(ENV, fakeLog());

    expect(token).to.equal('minted-abc');
    expect(fetchStub).to.have.been.calledOnce;
    const [url, opts] = fetchStub.firstCall.args;
    expect(url).to.equal('https://ims-na1-stg1.adobelogin.com/ims/token/v3');
    expect(opts.method).to.equal('POST');
    expect(opts.headers['Content-Type']).to.equal('application/x-www-form-urlencoded');
    const body = opts.body.toString();
    expect(body).to.include('grant_type=client_credentials');
    expect(body).to.include('client_id=tech-client-id');
    expect(body).to.include('client_secret=tech-client-secret');
    // Default scopes include the operative user_management_sdk scope.
    expect(body).to.include('user_management_sdk');
  });

  it('accepts a full-origin IMS_HOST', async () => {
    fetchStub.resolves(fakeResponse(200, { access_token: 't' }));
    await mintSemrushImsToken({ ...ENV, IMS_HOST: 'https://ims-na1.adobelogin.com' }, fakeLog());
    expect(fetchStub.firstCall.args[0]).to.equal('https://ims-na1.adobelogin.com/ims/token/v3');
  });

  it('honours a SEMRUSH_IMS_TECH_SCOPE override', async () => {
    fetchStub.resolves(fakeResponse(200, { access_token: 't' }));
    await mintSemrushImsToken({ ...ENV, SEMRUSH_IMS_TECH_SCOPE: 'openid,AdobeID' }, fakeLog());
    expect(fetchStub.firstCall.args[1].body.toString()).to.include('scope=openid%2CAdobeID');
  });

  it('throws 503 when the tech credentials are missing (no fetch)', async () => {
    let err;
    try {
      await mintSemrushImsToken({ IMS_HOST: ENV.IMS_HOST }, fakeLog());
    } catch (e) {
      err = e;
    }
    expect(err?.status).to.equal(503);
    expect(fetchStub).to.not.have.been.called;
  });

  it('throws 503 when IMS_HOST is missing', async () => {
    let err;
    try {
      await mintSemrushImsToken(
        { SEMRUSH_IMS_TECH_ID: 'x', SEMRUSH_IMS_TECH_SECRET: 'y' },
        fakeLog(),
      );
    } catch (e) {
      err = e;
    }
    expect(err?.status).to.equal(503);
    expect(fetchStub).to.not.have.been.called;
  });

  it('throws 502 and logs the IMS error when the response has no access_token', async () => {
    const log = fakeLog();
    fetchStub.resolves(fakeResponse(400, { error: 'invalid_client' }));

    let err;
    try {
      await mintSemrushImsToken(ENV, log);
    } catch (e) {
      err = e;
    }
    expect(err?.status).to.equal(502);
    expect(log.error).to.have.been.calledOnce;
    // The IMS error code is surfaced to the log, never the credentials/token.
    expect(log.error.firstCall.args[1]).to.include({ status: 400, imsError: 'invalid_client' });
  });

  it('throws 502 when the fetch itself rejects (network error)', async () => {
    fetchStub.rejects(new Error('econnrefused'));
    let err;
    try {
      await mintSemrushImsToken(ENV, fakeLog());
    } catch (e) {
      err = e;
    }
    expect(err?.status).to.equal(502);
  });
});
