/*
 * Copyright 2024 Adobe. All rights reserved.
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

import chai from 'chai';
import nock from 'nock';
import sinon from 'sinon';
import chaiAsPromised from 'chai-as-promised';
import fs from 'fs';
import { importPKCS8, SignJWT } from 'jose';

import publicJwk from '../../../fixtures/auth/ims/public-jwks.js';
import AdobeImsHandler from '../../../../src/support/auth/handlers/ims.js';
import AbstractHandler from '../../../../src/support/auth/handlers/abstract.js';
import AuthInfo from '../../../../src/support/auth/auth-info.js';

chai.use(chaiAsPromised);

const { expect } = chai;

const privateKey = fs.readFileSync('test/fixtures/auth/ims/private_key.pem', 'utf8');

const createToken = async (payload, exp = 3600) => {
  const key = await importPKCS8(privateKey, 'RS256');
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: publicJwk.keys[0].kid })
    .setIssuedAt()
    .setExpirationTime(`${exp} sec`)
    .sign(key);
};

describe('AdobeImsHandler', () => {
  let logStub;
  let handler;

  beforeEach(() => {
    logStub = {
      debug: sinon.stub(),
      info: sinon.stub(),
      error: sinon.stub(),
    };
    handler = new AdobeImsHandler(logStub);
  });

  afterEach(() => {
    sinon.restore();
  });

  it('is an instance of AbstractHandler', () => {
    expect(handler).to.be.instanceof(AbstractHandler);
  });

  it('sets the name and logger properties correctly', () => {
    expect(handler.name).to.equal('ims');
    expect(handler.logger).to.equal(logStub);
  });

  it('logs messages correctly', () => {
    handler.log('test message', 'info');

    expect(logStub.info.calledWith('[ims] test message')).to.be.true;
  });

  it('returns null when there is no authorization header', async () => {
    const context = {};
    const result = await handler.checkAuth({}, context);

    expect(result).to.be.null;
  });

  it('returns null when "Bearer " is missing from the authorization header', async () => {
    const context = { pathInfo: { headers: { authorization: 'some-token' } } };
    const result = await handler.checkAuth({}, context);

    expect(result).to.be.null;
  });

  it('returns null when the token is empty', async () => {
    const context = { pathInfo: { headers: { authorization: 'Bearer ' } } };
    const result = await handler.checkAuth({}, context);

    expect(result).to.be.null;
    expect(logStub.debug.calledWith('[ims] No bearer token provided')).to.be.true;
  });

  it('returns null when the token was issued by a different idp', async () => {
    const token = await createToken({ as: 'ims-na1' });
    const context = {
      log: logStub,
      func: { version: 'ci1234' },
      pathInfo: { headers: { authorization: `Bearer ${token}` } },
    };
    const result = await handler.checkAuth({}, context);

    expect(result).to.be.null;
    expect(logStub.error.calledWith('[ims] Failed to validate token: Token not issued by expected idp: ims-na1-stg1 != ims-na1')).to.be.true;
  });

  describe('token validation', () => {
    beforeEach(() => {
      nock('https://ims-na1.adobelogin.com')
        .get('/ims/keys')
        .reply(200, JSON.stringify(publicJwk));
    });

    afterEach(() => {
      nock.cleanAll();
    });

    it('returns null when created_at is not a number', async () => {
      const token = await createToken({ as: 'ims-na1', created_at: 'not-a-number', expires_in: 3600 });
      const context = {
        log: logStub,
        pathInfo: { headers: { authorization: `Bearer ${token}` } },
      };
      const result = await handler.checkAuth({}, context);

      expect(result).to.be.null;
      expect(logStub.error.calledWith('[ims] Failed to validate token: expires_in and created_at claims must be numbers')).to.be.true;
    });

    it('returns null when expires_in is not a number', async () => {
      const token = await createToken({ as: 'ims-na1', created_at: Date.now(), expires_in: 'not-a-number' });
      const context = {
        log: logStub,
        pathInfo: { headers: { authorization: `Bearer ${token}` } },
      };
      const result = await handler.checkAuth({}, context);

      expect(result).to.be.null;
      expect(logStub.error.calledWith('[ims] Failed to validate token: expires_in and created_at claims must be numbers')).to.be.true;
    });

    it('returns null when created_at is in the future', async () => {
      const token = await createToken({ as: 'ims-na1', created_at: Date.now() + 1000, expires_in: 3600 });
      const context = {
        log: logStub,
        pathInfo: { headers: { authorization: `Bearer ${token}` } },
      };
      const result = await handler.checkAuth({}, context);

      expect(result).to.be.null;
      expect(logStub.error.calledWith('[ims] Failed to validate token: created_at should be in the past')).to.be.true;
    });

    it('returns null when the token is expired', async () => {
      const token = await createToken({ as: 'ims-na1', created_at: Date.now(), expires_in: 0 });
      const context = {
        log: logStub,
        pathInfo: { headers: { authorization: `Bearer ${token}` } },
      };
      const result = await handler.checkAuth({}, context);

      expect(result).to.be.null;
      expect(logStub.error.calledWith('[ims] Failed to validate token: token expired')).to.be.true;
    });

    it('successfully validates a token and returns the profile', async () => {
      const now = Date.now();
      const token = await createToken({
        user_id: 'test-user', as: 'ims-na1', created_at: now, expires_in: 3600,
      });
      const context = {
        log: logStub,
        pathInfo: { headers: { authorization: `Bearer ${token}` } },
      };
      const result = await handler.checkAuth({}, context);

      expect(result).to.be.instanceof(AuthInfo);
      expect(result.authenticated).to.be.true;
      expect(result.profile).to.be.an('object');
      expect(result.profile).to.have.property('as', 'ims-na1');
      expect(result.profile).to.have.property('email', 'test-user');
      expect(result.profile).to.not.have.property('user_id');
      expect(result.profile).to.have.property('created_at', now);
      expect(result.profile).to.have.property('ttl', 3);
    });
  });
});
