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

import { expect, use } from 'chai';
import sinon from 'sinon';
import chaiAsPromised from 'chai-as-promised';
import fs from 'fs';
import { importPKCS8, SignJWT } from 'jose';

import publicJwk from '../../fixtures/auth/ims/public-jwks.js';
import AdobeImsHandler from '../../../src/auth/handlers/ims.js';
import AbstractHandler from '../../../src/auth/handlers/abstract.js';
import AuthInfo from '../../../src/auth/auth-info.js';

use(chaiAsPromised);

const privateKey = fs.readFileSync('test/fixtures/auth/ims/private_key.pem', 'utf8');

const createToken = async (payload, exp = 3600) => {
  const key = await importPKCS8(privateKey, 'RS256');
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: publicJwk.keys[0].kid })
    .setIssuedAt()
    .setExpirationTime(`${exp} sec`)
    .sign(key);
};
const imsIdpConfigDev = {
  name: 'ims-na1-stg1',
  discoveryUrl: 'https://ims-na1-stg1.adobelogin.com/ims/.well-known/openid-configuration',
  discovery: {
    issuer: 'https://ims-na1-stg1.adobelogin.com',
    authorization_endpoint: 'https://ims-na1-stg1.adobelogin.com/ims/authorize/v2',
    token_endpoint: 'https://ims-na1-stg1.adobelogin.com/ims/token/v3',
    userinfo_endpoint: 'https://ims-na1-stg1.adobelogin.com/ims/userinfo/v2',
    revocation_endpoint: 'https://ims-na1-stg1.adobelogin.com/ims/revoke',
    jwks_uri: 'https://ims-na1-stg1.adobelogin.com/ims/keys',
  },
};

describe('AdobeImsHandler', () => {
  let logStub;
  let handler;
  let mockImsClient;
  let context;

  beforeEach(() => {
    logStub = {
      debug: sinon.stub(),
      info: sinon.stub(),
      error: sinon.stub(),
    };

    mockImsClient = {
      getImsUserProfile: sinon.stub().resolves({
        projectedProductContext: [{
          prodCtx: {
            serviceCode: 'dx_aem_perf',
            owningEntity: 'org1@AdobeOrg',
          },
        }],
      }),
      getImsUserOrganizations: sinon.stub().resolves([{
        orgRef: { ident: 'org1' },
        orgName: 'Test Org',
      }]),
    };

    handler = new AdobeImsHandler(logStub);

    imsIdpConfigDev.discovery.jwks = publicJwk;
    context = {
      func: { version: 'ci' },
      log: logStub,
      env: {
        AUTH_HANDLER_IMS: JSON.stringify(imsIdpConfigDev),
      },
      imsClient: mockImsClient,
    };
  });

  afterEach(() => {
    sinon.restore();
    delete imsIdpConfigDev.discovery.jwks;
  });

  it('is an instance of AbstractHandler', () => {
    expect(handler).to.be.instanceof(AbstractHandler);
  });

  it('sets the name and log properties correctly', () => {
    expect(handler.name).to.equal('ims');
    expect(handler.logger).to.equal(logStub);
  });

  it('logs messages correctly', () => {
    handler.log('test message', 'info');

    expect(logStub.info.calledWith('[ims] test message')).to.be.true;
  });

  it('returns null when there is no authorization header', async () => {
    const result = await handler.checkAuth({}, context);

    expect(result).to.be.null;
  });

  it('returns null when "Bearer " is missing from the authorization header', async () => {
    const result = await handler.checkAuth({}, context);

    expect(result).to.be.null;
  });

  it('returns null when the token is empty', async () => {
    const result = await handler.checkAuth({}, context);

    expect(result).to.be.null;
    expect(logStub.debug.calledWith('[ims] No bearer token provided')).to.be.true;
  });

  it('returns null when there is no ims config', async () => {
    const token = await createToken({ as: 'ims-na1' });
    const testContext = {
      log: logStub,
      func: { version: 'ci1234' },
      pathInfo: { headers: { authorization: `Bearer ${token}` } },
    };
    const result = await handler.checkAuth({}, testContext);

    expect(result).to.be.null;
  });

  it('returns null when the token was issued by a different idp', async () => {
    const token = await createToken({ as: 'ims-na1' });
    const testContext = {
      log: logStub,
      func: { version: 'ci1234' },
      pathInfo: { headers: { authorization: `Bearer ${token}` } },
      env: { AUTH_HANDLER_IMS: JSON.stringify(imsIdpConfigDev) },
      imsClient: mockImsClient,
    };
    const result = await handler.checkAuth({}, testContext);

    expect(result).to.be.null;
    expect(logStub.error.calledWith('[ims] Failed to validate token: Token not issued by expected idp: ims-na1-stg1 != ims-na1')).to.be.true;
  });

  it('throw error when context is not correct', async () => {
    const token = await createToken({ as: 'ims-na1' });
    const testContext = {
      log: logStub,
      func: { version: 'ci1234' },
      pathInfo: { headers: { authorization: `Bearer ${token}` } },
      env: { AUTH_HANDLER_IMS: 'invalid json' },
      imsClient: mockImsClient,
    };
    const result = await handler.checkAuth({}, testContext);
    expect(result).to.be.null;
  });

  describe('token validation', () => {
    it('returns null when created_at is not a number', async () => {
      const token = await createToken({ as: 'ims-na1-stg1', created_at: 'not-a-number', expires_in: 3600 });
      context.pathInfo = { headers: { authorization: `Bearer ${token}` } };

      const result = await handler.checkAuth({}, context);

      expect(result).to.be.null;
      expect(logStub.error.calledWith('[ims] Failed to validate token: expires_in and created_at claims must be numbers')).to.be.true;
    });

    it('returns null when expires_in is not a number', async () => {
      const token = await createToken({ as: 'ims-na1-stg1', created_at: Date.now(), expires_in: 'not-a-number' });
      context.pathInfo = { headers: { authorization: `Bearer ${token}` } };

      const result = await handler.checkAuth({}, context);

      expect(result).to.be.null;
      expect(logStub.error.calledWith('[ims] Failed to validate token: expires_in and created_at claims must be numbers')).to.be.true;
    });

    it('returns null when created_at is in the future', async () => {
      const token = await createToken({ as: 'ims-na1-stg1', created_at: Date.now() + 1000, expires_in: 3600 });
      context.pathInfo = { headers: { authorization: `Bearer ${token}` } };

      const result = await handler.checkAuth({}, context);

      expect(result).to.be.null;
      expect(logStub.error.calledWith('[ims] Failed to validate token: created_at should be in the past')).to.be.true;
    });

    it('returns null when the token is expired', async () => {
      const token = await createToken({ as: 'ims-na1-stg1', created_at: Date.now(), expires_in: 0 });
      context.pathInfo = { headers: { authorization: `Bearer ${token}` } };

      const result = await handler.checkAuth({}, context);

      expect(result).to.be.null;
      expect(logStub.error.calledWith('[ims] Failed to validate token: token expired')).to.be.true;
    });

    it('successfully validates a token and returns the profile', async () => {
      const now = Date.now();
      const token = await createToken({
        user_id: 'test-user',
        as: 'ims-na1-stg1',
        created_at: now,
        expires_in: 3600,
      });
      context.pathInfo = { headers: { authorization: `Bearer ${token}` } };

      const result = await handler.checkAuth({}, context);

      expect(result).to.be.instanceof(AuthInfo);
      expect(result.authenticated).to.be.true;
      expect(result.profile).to.be.an('object');
      expect(result.profile).to.have.property('as', 'ims-na1-stg1');
      expect(result.profile).to.have.property('email', 'test-user');
      expect(result.profile).to.not.have.property('user_id');
      expect(result.profile).to.have.property('created_at', now);
      expect(result.profile).to.have.property('ttl', 3);
    });
  });

  describe('tenant information', () => {
    it('successfully validates a token with tenant information', async () => {
      const token = await createToken({
        user_id: 'test-user@customer.com',
        as: 'ims-na1-stg1',
        created_at: Date.now(),
        expires_in: 3600,
      });
      context.pathInfo = { headers: { authorization: `Bearer ${token}` } };

      mockImsClient.getImsUserOrganizations.resolves([{
        orgRef: { ident: 'org1' },
        orgName: 'Test Org',
      }]);

      const result = await handler.checkAuth({}, context);

      expect(result).to.be.instanceof(AuthInfo);
      expect(result.authenticated).to.be.true;
      expect(result.scopes).to.have.lengthOf(1);
      expect(result.scopes[0]).to.deep.include({
        name: 'user',
        domains: ['org1'],
        subScopes: ['dx_aem_perf_auto_suggest', 'dx_aem_perf_auto_fix'],
      });
      expect(mockImsClient.getImsUserProfile.calledWith(token)).to.be.true;
      expect(mockImsClient.getImsUserOrganizations.calledWith(token)).to.be.true;
    });

    it('handles empty organizations array', async () => {
      const token = await createToken({
        user_id: 'test-user@customer.com',
        as: 'ims-na1-stg1',
        created_at: Date.now(),
        expires_in: 3600,
      });
      context.pathInfo = { headers: { authorization: `Bearer ${token}` } };

      // Mock IMS profile response for non-Adobe user
      mockImsClient.getImsUserProfile.resolves({
        email: 'test-user@customer.com',
      });
      mockImsClient.getImsUserOrganizations.resolves([]);

      const result = await handler.checkAuth({}, context);

      expect(result).to.be.instanceof(AuthInfo);
      expect(result.authenticated).to.be.true;
      expect(result.scopes).to.deep.equal([]);
    });

    it('handles undefined organizations', async () => {
      const token = await createToken({
        user_id: 'test-user@customer.com',
        as: 'ims-na1-stg1',
        created_at: Date.now(),
        expires_in: 3600,
      });
      context.pathInfo = { headers: { authorization: `Bearer ${token}` } };

      // Mock IMS profile response for non-Adobe user
      mockImsClient.getImsUserProfile.resolves({
        email: 'test-user@customer.com',
      });
      mockImsClient.getImsUserOrganizations.resolves(undefined);

      const result = await handler.checkAuth({}, context);

      expect(result).to.be.instanceof(AuthInfo);
      expect(result.authenticated).to.be.true;
      expect(result.scopes).to.deep.equal([]);
    });

    it('creates tenants with hardcoded subServices', async () => {
      const token = await createToken({
        user_id: 'test-user@customer.com',
        as: 'ims-na1-stg1',
        created_at: Date.now(),
        expires_in: 3600,
      });
      context.pathInfo = { headers: { authorization: `Bearer ${token}` } };

      // Mock IMS profile response for non-Adobe user
      mockImsClient.getImsUserProfile.resolves({
        email: 'test-user@customer.com',
      });
      mockImsClient.getImsUserOrganizations.resolves([{
        orgRef: { ident: 'org1' },
        orgName: 'Test Org',
      }]);

      const result = await handler.checkAuth({}, context);

      expect(result).to.be.instanceof(AuthInfo);
      expect(result.authenticated).to.be.true;
      expect(result.scopes).to.deep.equal([{
        name: 'user',
        domains: ['org1'],
        subScopes: ['dx_aem_perf_auto_suggest', 'dx_aem_perf_auto_fix'],
      }]);
    });

    it('gives only admin scope to adobe.com users', async () => {
      const token = await createToken({
        user_id: 'test-user@adobe.com',
        as: 'ims-na1-stg1',
        created_at: Date.now(),
        expires_in: 3600,
      });
      context.pathInfo = { headers: { authorization: `Bearer ${token}` } };

      // Mock IMS profile response with Adobe email
      mockImsClient.getImsUserProfile.resolves({
        email: 'test-user@adobe.com',
      });

      const result = await handler.checkAuth({}, context);

      expect(result).to.be.instanceof(AuthInfo);
      expect(result.authenticated).to.be.true;
      expect(result.scopes).to.deep.equal([{ name: 'admin' }]);
    });
  });
});
