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
const ORG_3_IMS_ORG_IDENT = 'GGGGGGGGHHHHHHHHIIIIIIII';
const ORG_3_ID = '33330000-3333-4333-b333-000000000333';

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
    is_s2s_admin: true,
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

/**
 * Delegated agency user — primary tenant is ORG_3, has a LLMO delegation entry pointing
 * back to ORG_1 (Path A: delegated_tenants_complete=true).
 * Includes trial_email so the FREE_TRIAL validateEntitlement branch finds TRIAL_USER_2
 * instead of attempting to create a new trial user.
 */
export async function createDelegatedUserToken() {
  return signToken({
    sub: 'test-delegate@example.com',
    email: 'test-delegate@example.com',
    trial_email: 'test-delegate@example.com',
    first_name: 'Test',
    last_name: 'Delegate',
    is_admin: false,
    is_llmo_administrator: false,
    tenants: [{ id: ORG_3_IMS_ORG_IDENT, subServices: [], entitlement: {} }],
    delegated_tenants: [{
      id: IMS_ORG_IDENT,
      sourceOrganizationId: ORG_3_ID,
      productCode: 'LLMO',
      role: 'agency',
    }],
    delegated_tenants_complete: true,
  });
}

/**
 * Truncated delegated user — same as delegatedUser but delegated_tenants_complete=false
 * (Path B: skip JWT gate, use getDelegatedTenants()[0].sourceOrganizationId for DB lookup).
 */
export async function createDelegatedUserTruncatedToken() {
  return signToken({
    sub: 'test-delegate-truncated@example.com',
    email: 'test-delegate-truncated@example.com',
    trial_email: 'test-delegate@example.com',
    is_admin: false,
    is_llmo_administrator: false,
    tenants: [{ id: ORG_3_IMS_ORG_IDENT, subServices: [], entitlement: {} }],
    delegated_tenants: [{
      id: IMS_ORG_IDENT,
      sourceOrganizationId: ORG_3_ID,
      productCode: 'LLMO',
      role: 'agency',
    }],
    delegated_tenants_complete: false,
  });
}

/**
 * Truncated delegated user with missing sourceOrganizationId — exercises the
 * Path B "!sourceOrganizationId → log.warn → return false" branch.
 */
export async function createDelegatedUserNoSourceToken() {
  return signToken({
    sub: 'test-delegate-nosource@example.com',
    email: 'test-delegate-nosource@example.com',
    is_admin: false,
    is_llmo_administrator: false,
    tenants: [{ id: ORG_3_IMS_ORG_IDENT, subServices: [], entitlement: {} }],
    delegated_tenants: [{ id: IMS_ORG_IDENT, productCode: 'LLMO', role: 'agency' }],
    delegated_tenants_complete: false,
  });
}

/**
 * Read-only admin — is_admin: false, is_read_only_admin: true.
 * The readOnlyAdminWrapper evaluates a LaunchDarkly feature flag before granting
 * access; without LD configured (e.g. in IT tests) the wrapper is fail-closed
 * and returns 403 for all routes. Use this persona to verify fail-closed behaviour
 * or in environments where the LD flag is enabled.
 */
export async function createReadOnlyAdminToken() {
  return signToken({
    sub: 'test-readonly-admin@adobe.com',
    email: 'test-readonly-admin@adobe.com',
    is_admin: false,
    is_read_only_admin: true,
    is_llmo_administrator: false,
    tenants: [{
      id: IMS_ORG_IDENT,
      subServices: [],
      entitlement: {},
    }],
  });
}

export async function createAllTokens() {
  const [
    admin, user, trialUser, delegatedUser, delegatedUserTruncated, delegatedUserNoSource,
    readOnlyAdmin,
  ] = await Promise.all([
    createAdminToken(),
    createUserToken(),
    createTrialUserToken(),
    createDelegatedUserToken(),
    createDelegatedUserTruncatedToken(),
    createDelegatedUserNoSourceToken(),
    createReadOnlyAdminToken(),
  ]);
  return {
    admin,
    user,
    trialUser,
    delegatedUser,
    delegatedUserTruncated,
    delegatedUserNoSource,
    readOnlyAdmin,
  };
}
