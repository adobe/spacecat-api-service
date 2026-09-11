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
  isOnestopAuthEnabled,
  generatePkce,
  signState,
  verifyState,
  callbackRedirectUri,
  buildAuthorizeUrl,
  exchangeCodeForToken,
  activateBrandAsOperator,
} from '../../src/support/ims-oauth.js';

const ENABLED_ENV = {
  IMS_OAUTH_CLIENT_ID: 'client-abc',
  IMS_OAUTH_CLIENT_SECRET: 'secret-xyz',
  IMS_OAUTH_STATE_SECRET: 'state-signing-secret',
  SPACECAT_API_BASE_URL: 'https://api.example.com',
};

describe('ims-oauth (LLMO-7369 Path A)', () => {
  describe('isOnestopAuthEnabled', () => {
    it('is false by default (no config) — the flow is inert', () => {
      expect(isOnestopAuthEnabled({})).to.equal(false);
      expect(isOnestopAuthEnabled(undefined)).to.equal(false);
    });
    it('needs all three of client id, secret and state secret', () => {
      expect(isOnestopAuthEnabled({ IMS_OAUTH_CLIENT_ID: 'a', IMS_OAUTH_CLIENT_SECRET: 'b' })).to.equal(false);
      expect(isOnestopAuthEnabled(ENABLED_ENV)).to.equal(true);
    });
  });

  describe('generatePkce', () => {
    it('produces a verifier and its S256 challenge', () => {
      const { verifier, challenge } = generatePkce();
      expect(verifier).to.be.a('string').with.length.greaterThan(20);
      expect(challenge).to.be.a('string').with.length.greaterThan(20);
      expect(challenge).to.not.equal(verifier);
    });
  });

  describe('signState / verifyState', () => {
    const secret = 'signing-secret';

    it('round-trips a payload', () => {
      const token = signState({ orgId: 'o', brandId: 'b', verifier: 'v' }, secret);
      const decoded = verifyState(token, secret);
      expect(decoded).to.include({ orgId: 'o', brandId: 'b', verifier: 'v' });
      expect(decoded.exp).to.be.a('number');
      expect(decoded.nonce).to.be.a('string');
    });

    it('rejects a tampered payload', () => {
      const token = signState({ orgId: 'o' }, secret);
      const [data, sig] = token.split('.');
      const tampered = `${Buffer.from('{"orgId":"evil"}').toString('base64url')}.${sig}`;
      expect(verifyState(tampered, secret)).to.equal(null);
      expect(verifyState(`${data}.deadbeef`, secret)).to.equal(null);
    });

    it('rejects a wrong secret', () => {
      const token = signState({ orgId: 'o' }, secret);
      expect(verifyState(token, 'other-secret')).to.equal(null);
    });

    it('rejects an expired token', () => {
      const past = Date.now() - (60 * 60 * 1000);
      const token = signState({ orgId: 'o' }, secret, past);
      expect(verifyState(token, secret)).to.equal(null);
    });

    it('rejects malformed input', () => {
      expect(verifyState('', secret)).to.equal(null);
      expect(verifyState('no-dot', secret)).to.equal(null);
      expect(verifyState(null, secret)).to.equal(null);
    });
  });

  describe('callbackRedirectUri', () => {
    it('derives from SPACECAT_API_BASE_URL', () => {
      expect(callbackRedirectUri(ENABLED_ENV)).to.equal('https://api.example.com/auth/ims/callback');
    });
    it('honors an explicit override', () => {
      expect(callbackRedirectUri({ IMS_OAUTH_REDIRECT_URI: 'https://x/cb' })).to.equal('https://x/cb');
    });
  });

  describe('buildAuthorizeUrl', () => {
    it('builds an IMS /authorize URL with PKCE + state, no reflected input', () => {
      const url = new URL(buildAuthorizeUrl(ENABLED_ENV, 'the-state', 'the-challenge'));
      expect(url.origin).to.equal('https://ims-na1.adobelogin.com');
      expect(url.pathname).to.equal('/ims/authorize/v2');
      expect(url.searchParams.get('client_id')).to.equal('client-abc');
      expect(url.searchParams.get('response_type')).to.equal('code');
      expect(url.searchParams.get('redirect_uri')).to.equal('https://api.example.com/auth/ims/callback');
      expect(url.searchParams.get('state')).to.equal('the-state');
      expect(url.searchParams.get('code_challenge')).to.equal('the-challenge');
      expect(url.searchParams.get('code_challenge_method')).to.equal('S256');
    });
  });

  describe('exchangeCodeForToken', () => {
    it('POSTs the authorization_code grant and returns the access token', async () => {
      let captured;
      const fetchImpl = async (u, opts) => {
        captured = { u, opts };
        return { ok: true, json: async () => ({ access_token: 'the-token' }) };
      };
      const token = await exchangeCodeForToken(ENABLED_ENV, 'the-code', 'the-verifier', fetchImpl);
      expect(token).to.equal('the-token');
      expect(captured.u).to.equal('https://ims-na1.adobelogin.com/ims/token/v3');
      expect(captured.opts.method).to.equal('POST');
      expect(captured.opts.body).to.include('grant_type=authorization_code');
      expect(captured.opts.body).to.include('code=the-code');
      expect(captured.opts.body).to.include('code_verifier=the-verifier');
    });

    it('throws on a non-OK response', async () => {
      const fetchImpl = async () => ({ ok: false, status: 400, text: async () => 'bad_request' });
      let err;
      try {
        await exchangeCodeForToken(ENABLED_ENV, 'c', 'v', fetchImpl);
      } catch (e) {
        err = e;
      }
      expect(err).to.be.an('error');
      expect(err.message).to.include('400');
    });

    it('throws when no access_token is returned', async () => {
      const fetchImpl = async () => ({ ok: true, json: async () => ({}) });
      let err;
      try {
        await exchangeCodeForToken(ENABLED_ENV, 'c', 'v', fetchImpl);
      } catch (e) {
        err = e;
      }
      expect(err).to.be.an('error');
      expect(err.message).to.include('no access_token');
    });
  });

  describe('activateBrandAsOperator', () => {
    it('POSTs /serenity/activate with the operator bearer token', async () => {
      let captured;
      const fetchImpl = async (u, opts) => {
        captured = { u, opts };
        return { ok: true, status: 200 };
      };
      const res = await activateBrandAsOperator(ENABLED_ENV, 'org-1', 'brand-1', 'tok-1', undefined, fetchImpl);
      expect(res.ok).to.equal(true);
      expect(captured.u).to.equal('https://api.example.com/v2/orgs/org-1/brands/brand-1/serenity/activate');
      expect(captured.opts.method).to.equal('POST');
      expect(captured.opts.headers.authorization).to.equal('Bearer tok-1');
      expect(captured.opts.headers['x-product']).to.equal('LLMO');
      expect(captured.opts.body).to.equal('{}');
    });

    it('includes markets when provided', async () => {
      let captured;
      const fetchImpl = async (u, opts) => {
        captured = { u, opts };
        return { ok: true, status: 200 };
      };
      const markets = [{ market: 'US', languageCode: 'en' }];
      await activateBrandAsOperator(ENABLED_ENV, 'org-1', 'brand-1', 'tok-1', markets, fetchImpl);
      expect(JSON.parse(captured.opts.body)).to.deep.equal({ markets });
    });
  });
});
