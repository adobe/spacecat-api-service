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

import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';
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
];

const loadConfig = (context) => {
  const funcVersion = context.func?.version;
  const isDev = /^ci\d*$/i.test(funcVersion);
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

const getDBAcls = async (dynamoClient, orgId, roles) => {
  const input = {
    ExpressionAttributeNames: {
      '#role': 'role',
    },
    ExpressionAttributeValues: {
      ':orgid': {
        S: orgId,
      },
    },
    KeyConditionExpression: 'imsorgid = :orgid',
    ProjectionExpression: 'acl, #role',
    TableName: 'spacecat-services-acls-dev6',
  };

  const feRoles = [];
  let i = 0;
  for (const role of roles) {
    const roleID = `:role${i}`;
    feRoles.push(roleID);
    input.ExpressionAttributeValues[roleID] = {
      S: role,
    };
    i += 1;
  }
  input.FilterExpression = `#role IN (${feRoles.join(', ')})`;

  console.log('§§§ Get ACLs input:', JSON.stringify(input));
  const command = new QueryCommand(input);
  const resp = await dynamoClient.send(command);
  console.log('§§§ DynamoDB getAcls response:', JSON.stringify(resp));

  return resp.Items.map((it) => ({
    role: it.role.S,
    acl: it.acl.L.map((a) => ({
      path: a.M.path.S,
      actions: a.M.actions.SS,
    })),
  }));
};

const getDBRoles = async (dbClient, { imsUserId, imsOrgId }) => {
  const input = {
    ExpressionAttributeNames: {
      '#roles': 'roles',
    },
    ExpressionAttributeValues: {
      ':orgid': {
        S: imsOrgId,
      },
      ':userident': {
        S: `imsID:${imsUserId}`,
      },
      ':orgident': {
        S: `imsOrgID:${imsOrgId}`,
      },
    },
    KeyConditionExpression: 'orgid = :orgid',
    FilterExpression: 'identifier IN (:userident, :orgident)',
    ProjectionExpression: '#roles',
    TableName: 'spacecat-services-roles-dev4',
  };
  console.log('§§§ Get roles input:', JSON.stringify(input));
  const command = new QueryCommand(input);
  const resp = await dbClient.send(command);
  console.log('§§§ DynamoDB getRoles response:', JSON.stringify(resp));

  const roles = resp.Items.flatMap((item) => item.roles.SS);
  return new Set(roles);
};

const getAcls = async (profile) => {
  // Strangely the ID is in profile.email, because that's not an email at all
  const imsUserId = profile.email;
  const imsOrgIdEmail = profile.aa_id;
  const imsOrgId = imsOrgIdEmail?.split('@')[0];

  const dbClient = new DynamoDBClient();
  const roles = await getDBRoles(dbClient, { imsUserId, imsOrgId });
  if (roles === undefined || roles.size === 0) {
    return {};
  }

  const acls = await getDBAcls(dbClient, imsOrgId, roles);
  return {
    acls,
    aclEntities: {
      model: ['organization', 'site'],
    },
  };
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

  async checkAuth(request, context) {
    console.log('§§§ context in ims:', JSON.stringify(context));
    const token = getBearerToken(context);
    if (!hasText(token)) {
      this.log('No bearer token provided', 'debug');
      return null;
    }

    try {
      const config = loadConfig(context);
      const payload = await this.#validateToken(token, config);
      const profile = transformProfile(payload);
      const acls = await getAcls(profile);

      try {
        const imspr = await context.imsClient.getImsUserProfile(token);
        console.log('§§§ ims profile:', imspr);
      } catch (e) {
        console.log('§§§ ims profile error:', e);
      }

      return new AuthInfo()
        .withType(this.name)
        .withAuthenticated(true)
        .withProfile(profile)
        .withACLs(acls);
    } catch (e) {
      this.log(`Failed to validate token: ${e.message}`, 'error');
      console.log('§§§ ims error:', e);
    }

    return null;
  }
}
