/*
 * Copyright 2025 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

// eslint-disable-next-line import/no-extraneous-dependencies
import { generateKeyPair, exportSPKI, SignJWT } from 'jose';

const ISSUER = 'https://spacecat.experiencecloud.live';
const AUDIENCE = 'spacecat-users';
const IMS_ORG_IDENT = 'AAAAAAAABBBBBBBBCCCCCCCC';

let keys;

export async function initAuth() {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const publicKeyPEM = await exportSPKI(publicKey);
  const publicKeyB64 = Buffer.from(publicKeyPEM).toString('base64');
  keys = { publicKey, privateKey, publicKeyB64 };
  return keys;
}

export function getPublicKeyB64() {
  return keys.publicKeyB64;
}

export function getImsOrgIdent() {
  return IMS_ORG_IDENT;
}

async function signToken(payload, expiresIn = '24h') {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime(expiresIn)
    .sign(keys.privateKey);
}

export async function createAdminToken() {
  return signToken({
    sub: 'test-admin@adobe.com',
    email: 'test-admin@adobe.com',
    is_admin: true,
    is_llmo_administrator: false,
    tenants: [{
      id: IMS_ORG_IDENT,
      subServices: [],
      entitlement: {},
    }],
  });
}

export async function createUserToken() {
  return signToken({
    sub: 'test-user@example.com',
    email: 'test-user@example.com',
    is_admin: false,
    is_llmo_administrator: false,
    tenants: [{
      id: IMS_ORG_IDENT,
      subServices: [],
      entitlement: {},
    }],
  });
}

export async function createTrialUserToken() {
  return signToken({
    sub: 'test-trial@example.com',
    email: 'test-trial@example.com',
    trial_email: 'test-trial@example.com',
    first_name: 'Test',
    last_name: 'Trial',
    is_admin: false,
    is_llmo_administrator: false,
    tenants: [{
      id: IMS_ORG_IDENT,
      subServices: [],
      entitlement: {},
    }],
  });
}

export async function createAllTokens() {
  const [admin, user, trialUser] = await Promise.all([
    createAdminToken(),
    createUserToken(),
    createTrialUserToken(),
  ]);
  return { admin, user, trialUser };
}
