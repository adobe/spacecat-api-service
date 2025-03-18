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

import { createDataAccess } from '@adobe/spacecat-shared-data-access';
import { hasText } from '@adobe/spacecat-shared-utils';
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  decodeJwt,
  jwtVerify,
} from 'jose';

import configProd from './config/ims.js';
import configDev from './config/ims-stg.js';

import AbstractHandler from './abstract.js';
import AuthInfo from '../auth-info.js';
import getAcls from '../rbac/acls.js';

const IGNORED_PROFILE_PROPS = [
  'id',
  'type',
  'as_id',
  'ctp',
  'pac',
  'rtid',
  'moi',
  'rtea',
  'user_id',
  'fg',
  'aa_id',
];

const loadConfig = (context) => {
  const funcVersion = context.func?.version;
  const isDev = /^(ci\d*|david)$/i.test(funcVersion); // TODO revert back
  context.log.debug(`Function version: ${funcVersion} (isDev: ${isDev})`);
  /* c8 ignore next */
  return isDev ? configDev : configProd;
};

const getBearerToken = (context) => {
  const authorizationHeader = context.pathInfo?.headers?.authorization || '';

  if (!authorizationHeader.startsWith('Bearer ')) {
    return null;
  }

  return authorizationHeader.replace('Bearer ', '');
};

const transformProfile = (payload) => {
  console.log('§§§ IMS payload pure:', payload);
  const profile = { ...payload };

  profile.email = payload.user_id;
  IGNORED_PROFILE_PROPS.forEach((prop) => delete profile[prop]);

  return profile;
};

export default class AdobeImsHandler extends AbstractHandler {
  constructor(log) {
    super('ims', log);
    this.jwksCache = null;
  }

  async #getJwksUri(config) {
    if (!this.jwksCache) {
      /* c8 ignore next 3 */
      this.jwksCache = config.discovery.jwks
        ? createLocalJWKSet(config.discovery.jwks)
        : createRemoteJWKSet(new URL(config.discovery.jwks_uri));
    }

    return this.jwksCache;
  }

  async #validateToken(token, config) {
    const decoded = await decodeJwt(token);
    if (config.name !== decoded.as) {
      throw new Error(`Token not issued by expected idp: ${config.name} != ${decoded.as}`);
    }

    const jwks = await this.#getJwksUri(config);
    const { payload } = await jwtVerify(token, jwks);

    const now = Date.now();
    const expiresIn = Number.parseInt(payload.expires_in, 10);
    const createdAt = Number.parseInt(payload.created_at, 10);

    if (Number.isNaN(expiresIn) || Number.isNaN(createdAt)) {
      throw new Error('expires_in and created_at claims must be numbers');
    }

    if (createdAt >= now) {
      throw new Error('created_at should be in the past');
    }

    const ttl = Math.floor((createdAt + expiresIn - now) / 1000);
    if (ttl <= 0) {
      throw new Error('token expired');
    }

    payload.ttl = ttl;

    return payload;
  }

  // eslint-disable-next-line class-methods-use-this
  async #addSampleRoles(aclAccess, item, force) {
    // only add sample data if it's not already there
    const role = await aclAccess.Role.findByIndexKeys({
      imsOrgId: item.imsOrgId,
      identity: item.identity,
    });

    if (role) {
      console.log('§§§ role already exists:', role.getId());
      if (!force) {
        return null;
      }
    }

    const created = await aclAccess.Role.create(item);
    return created;
  }

  // eslint-disable-next-line class-methods-use-this
  async #addSampleAcls(aclAccess, item) {
    console.log('§§§ creating acl:', item);
    const acl = await aclAccess.Acl.create(item);

    const lookedup = await aclAccess.Acl.findByIndexKeys({
      roleName: item.roleName,
      imsOrgId: item.imsOrgId,
    });
    console.log('§§§ acl looked up:', lookedup.getId());

    return acl;
  }

  // eslint-disable-next-line class-methods-use-this
  async #fillModel(aclAccess) {
    const r1 = await this.#addSampleRoles(aclAccess, {
      imsOrgId: 'F4646ED9626926AA0A49420E@AdobeOrg',
      identity: 'imsID:374B0263626BA96D0A49421B@f71261f462692705494128.e',
      name: 'mysite-importer',
    });
    if (!r1) {
      return;
    }
    // its a new one
    console.log('§§§ New role created:', r1);

    await this.#addSampleAcls(aclAccess, {
      roleName: 'mysite-importer',
      imsOrgId: 'F4646ED9626926AA0A49420E@AdobeOrg',
      acls: [
        {
          actions: ['C', 'R', 'U', 'D'],
          path: '/organization/45678',
        },
      ],
    });

    await this.#addSampleRoles(aclAccess, {
      imsOrgId: 'F4646ED9626926AA0A49420E@AdobeOrg',
      identity: 'imsID:374B0263626BA96D0A49421B@f71261f462692705494128.e',
      name: 'test-account-writer',
    }, true);
    console.log('§§§ New role created r2');

    await this.#addSampleAcls(aclAccess, {
      roleName: 'test-account-writer',
      imsOrgId: 'F4646ED9626926AA0A49420E@AdobeOrg',
      acls: [
        {
          actions: ['C', 'R', 'U', 'D'],
          path: '/organization/0f8ff270-968e-4007-aea1-2fa1c5e3332c',
        },
        {
          actions: ['C', 'R', 'U', 'D'],
          path: '/organization/77d14008-649f-4be2-8d40-cba150995410/site/**',
        },
      ],
    });
    await this.#addSampleRoles(aclAccess, {
      imsOrgId: 'F4646ED9626926AA0A49420E@AdobeOrg',
      identity: 'imsOrgID:F4646ED9626926AA0A49420E@AdobeOrg',
      name: 'test-account-reader',
    }, true);
    console.log('§§§ New role created r3');

    await this.#addSampleAcls(aclAccess, {
      roleName: 'test-account-reader',
      imsOrgId: 'F4646ED9626926AA0A49420E@AdobeOrg',
      acls: [
        {
          actions: ['R'],
          path: '/organization/0f8ff270-968e-4007-aea1-2fa1c5e3332c',
        },
        {
          actions: ['R'],
          path: '/organization/77d14008-649f-4be2-8d40-cba150995410',
        },
        {
          actions: ['R'],
          path: '/organization/77d14008-649f-4be2-8d40-cba150995410/site/b57fb90d-a847-4f18-b80e-283ff7145345',
        },
      ],
    });

    await this.#addSampleRoles(aclAccess, {
      imsOrgId: 'F4646ED9626926AA0A49420E@AdobeOrg',
      identity: 'imsOrgID/groupID:F4646ED9626926AA0A49420E/560518161',
      name: 'another-account-reader',
    }, true);
    await this.#addSampleRoles(aclAccess, {
      imsOrgId: 'F4646ED9626926AA0A49420E@AdobeOrg',
      identity: 'imsOrgID/groupID:F4646ED9626926AA0A49420E/560518161',
      name: 'another-account-writer',
    }, true);
    await this.#addSampleRoles(aclAccess, {
      imsOrgId: '43101FC962E3B1BF0A494217@AdobeOrg',
      identity: 'apiKeyID:7b0784db-e05b-4329-acba-84575313fb81',
      name: 'test-account-reader',
    }, true);
    console.log('§§§ New role created r4');

    await this.#addSampleAcls(aclAccess, {
      roleName: 'test-account-reader',
      imsOrgId: '43101FC962E3B1BF0A494217@AdobeOrg',
      acls: [
        {
          actions: ['R'],
          path: '/organization/77d14008-649f-4be2-8d40-cba150995410',
        },
        {
          actions: ['R'],
          path: '/organization/77d14008-649f-4be2-8d40-cba150995410/site/b57fb90d-a847-4f18-b80e-283ff7145345',
        },
      ],
    });
  }

  // eslint-disable-next-line class-methods-use-this
  async #getAclAccess(context) {
    console.log('§§§ Getting ACL Access');

    const { log } = context;
    return createDataAccess({
      tableNameData: 'spacecat-services-rbac-dev',
    }, log);
  }

  async checkAuth(request, context) {
    // This is only temporarily to put some things in the database
    // /* */
    // console.log('§§§ Get ACL Access via model');
    // const aclAccess = await this.#getAclAccess(context);
    // console.log('§§§ Done getting ACL Access via model');
    // await this.#fillModel(aclAccess);
    // /* */

    // console.log('§§§ context in ims:', JSON.stringify(context));
    const token = getBearerToken(context);
    if (!hasText(token)) {
      this.log('No bearer token provided', 'debug');
      return null;
    }

    try {
      const imsProfile = await context.imsClient.getImsUserProfile(token);
      console.log('§§§ ims profile:', JSON.stringify(imsProfile));
      const acls = await getAcls({
        imsUserId: imsProfile.userId,
        imsOrgs: imsProfile.organizations,
        imsGroups: imsProfile.orgDetails,
      }, context.log); // TODO pass config

      const config = loadConfig(context);
      const payload = await this.#validateToken(token, config);
      const profile = transformProfile(payload);

      return new AuthInfo()
        .withType(this.name)
        .withAuthenticated(true)
        .withProfile(profile)
        .withRBAC(acls);
    } catch (e) {
      this.log(`Failed to validate token: ${e.message}`, 'error');
      console.log('§§§ ims error:', e);
    }

    return null;
  }
}
