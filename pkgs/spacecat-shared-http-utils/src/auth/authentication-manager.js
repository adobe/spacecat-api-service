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
// import { DynamoDB } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';
import { isObject } from '@adobe/spacecat-shared-utils';

import NotAuthenticatedError from './errors/not-authenticated.js';

/**
 * Authentication manager. It will try to authenticate the request with all the provided handlers.
 * If none of the handlers are able to authenticate the request, it will throw
 * a NotAuthenticatedError.
 * @class
 */
export default class AuthenticationManager {
  constructor(log) {
    this.log = log;
    this.handlers = [];
  }

  /**
   * Register a handler. This method is private and should not be called directly.
   * The handlers are used in the order they are registered.
   * @param {AbstractHandler} Handler - The handler to be registered
   */
  #registerHandler(Handler) {
    this.handlers.push(new Handler(this.log));
  }

  getRolesx(authInfo, roleInfo) {
    const roles = [];

    for (const item of roleInfo) {
      switch (item.identtype) {
        case 'email':
          if (item.ident === authInfo.profile.email) {
            roles.push(...item.roles);
          }
          break;
        case 'imsorgid':
          if (item.ident === authInfo.profile.imgOrgID) {
            roles.push(...item.roles);
          }
          break;
        case 'imsorgid/groupname':
          for (const group of authInfo.profile.groups) {
            if (item.ident === `${authInfo.profile.imgOrgID}/${group.name}`) {
              roles.push(...item.roles);
            }
          }
          break;
        default:
          // eslint-disable-next-line no-console
          console.log('Unknown role identifier type:', item.identtype);
      }
    }

    return [...new Set(roles)];
  }

  // eslint-disable-next-line class-methods-use-this
  async getAcls(dynamoClient, orgId, roles) {
    const input = {
      ExpressionAttributeNames: {
        '#role': 'role',
      },
      ExpressionAttributeValues: {
        ':orgid': {
          S: orgId,
        },
        ':role1': {
          S: roles[0],
        },
        ':role2': {
          S: '12345-writer',
        },
      },
      KeyConditionExpression: 'imsorgid = :orgid',
      FilterExpression: '#role IN (:role1, :role2)',
      // ProjectionExpression: 'ident',
      TableName: 'spacecat-services-acls-dev6',
    };

    // FilterExpression: '(TimeId = :timeId AND begins_with ( TypeKey , :typeKey))
    // AND (awayTeam = :teamName OR homeTeam = :teamName)' i

    // use a FilterExpression with or

    console.log('§§§ Get ACLs input:', JSON.stringify(input));
    try {
      const command = new QueryCommand(input);
      const resp = await dynamoClient.send(command);
      console.log('§§§ DynamoDB getAcls response:', JSON.stringify(resp));
    } catch (e) {
      console.error('§§§ DynamoDB getAcls error:', e);
    }
  }

  // eslint-disable-next-line class-methods-use-this
  async getRoles(dbClient, { imsUserId, imsOrgId }) {
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
  }

  // eslint-disable-next-line class-methods-use-this
  async getAclsUsingBareClient(authInfo) {
    console.log('§§§ Profile email/imsUserID:', authInfo.profile?.email);

    // Strangely this is in 'email' because it's not an email address
    const imsUserId = authInfo.profile?.email;
    const imsOrgIdEmail = authInfo.profile?.aa_id;
    const imsOrgId = imsOrgIdEmail?.split('@')[0];

    // Need to get this from IMS
    // authInfo.profile.imgOrgID = 'C52E57EB5489E70A0A4C98A5';
    // authInfo.profile.groups = [
    //   { name: 'admins', id: '12345' },
    //   { name: 'readers', id: '999' },
    // ];

    const dbClient = new DynamoDBClient();
    const roles = await this.getRoles(dbClient, { imsUserId, imsOrgId });
    // const input = {
    //   ExpressionAttributeValues: {
    //     ':v1': {
    //       S: authInfo.profile.imgOrgID,
    //     },
    //   },
    //   KeyConditionExpression: 'orgid = :v1',
    //   // ProjectionExpression: 'ident',
    //   TableName: 'spacecat-services-roles-dev4',
    // };
    // const command = new QueryCommand(input);
    // const resp = await dbClient.send(command);
    // console.log('§§§ DynamoDB response:', JSON.stringify(resp));

    // const roleInfo = [];
    // for (const item of resp.Items) {
    //   roleInfo.push({
    //     ident: item.ident.S,
    //     identtype: item.identtype.S,
    //     roles: item.roles.SS,
    //   });
    // }
    // console.log('§§§ idents:', roleInfo);

    // const roles = this.getRolesx(authInfo, roleInfo);
    // console.log('§§§ roles:', roles);

    if (roles === undefined || roles.length === 0) {
      return [];
    }

    const acls = await this.getAcls(dbClient, imsOrgId, roles);
    return acls;
  }

  // // eslint-disable-next-line class-methods-use-this
  // async getAclsUsingDocumentClient(authInfo) {
  //   console.log('§§§ using document client');
  //   const client = new DynamoDBClient();
  //   const docClient = DynamoDBDocumentClient.from(client);

  //   // const params = {
  //   //   TableName: 'spacecat-services-roles-dev4',
  //   //   Key: { orgid: 'C52E57EB5489E70A0A4C98A5' },
  //   // };
  //   const input = {
  //     ExpressionAttributeValues: {
  //       ':v1': {
  //         S: 'C52E57EB5489E70A0A4C98A5',
  //       },
  //     },
  //     KeyConditionExpression: 'orgid = :v1',
  //     // ProjectionExpression: 'ident',
  //     TableName: 'spacecat-services-roles-dev4',
  //   };
  //   const command = new QueryCommand(input);
  //   const resp = await docClient.send(command);
  //   console.log('§§§ docclient response:', JSON.stringify(resp));
  // }

  /**
   * Authenticate the request with all the handlers.
   * @param {Object} request - The request object
   * @param {UniversalContext} context - The context object
   * @return {Promise<AuthInfo>} The authentication info
   * @throws {NotAuthenticatedError} If no handler was able to authenticate the request
   */
  async authenticate(request, context) {
    for (const handler of this.handlers) {
      this.log.debug(`Trying to authenticate with ${handler.name}`);

      let authInfo;
      try {
        // eslint-disable-next-line no-await-in-loop
        authInfo = await handler.checkAuth(request, context);
      } catch (error) {
        this.log.error(`Failed to authenticate with ${handler.name}:`, error);
      }

      if (isObject(authInfo)) {
        this.log.info(`Authenticated with ${handler.name}`);

        // // get ims stufg
        // try {
        //   console.log('§§§ context: ', JSON.stringify(context));

        //   // TODO pass in aa_id
        //   const orgIdEmail = authInfo.profile.aa_id;
        //   const orgId = orgIdEmail.split('@')[0];

        //   console.log('§§§ orgId:', orgId);
        //   // eslint-disable-next-line no-await-in-loop
        //   const orgDetails = await context.imsClient.getImsOrganizationDetails(orgId);
        //   console.log('§§§ orgDetails:', orgDetails);
        //   // // eslint-disable-next-line no-await-in-loop
        //   // // const token = await context.imsClient.getImsUserToken(context.pathInfo.headers);
        //   // // 7 is the length of 'Bearer '
        //   // const token = context.pathInfo.headers?.authorization?.substring(7);

        //   // console.log('§§§ ims token:', token);
        //   // // eslint-disable-next-line no-await-in-loop
        //   // const imsinfo = await context.imsClient.getImsUserProfile(token);

        //   // // eslint-disable-next-line no-await-in-loop
        //   // // const imsinfo = await context.imsClient.getServiceAccessTokenV3();
        //   // console.log('§§§ ims token/info:', imsinfo);
        // } catch (e) {
        //   console.error('§§§ ims error:', e);
        // }

        try {
          // eslint-disable-next-line no-await-in-loop
          const acls = await this.getAclsUsingBareClient(authInfo);
          console.log('§§§ acls:', acls);
        } catch (e) {
          console.error('§§§ getAclsUsingBareClient error:', e);
        }

        context.attributes = context.attributes || {};

        // The acls are looked up per role
        authInfo.aclEntities = {
          model: ['organization'],
        };
        authInfo.acls = [
          {
            role: 'org-viewer',
            acl: [
              { path: '/organization/49968537-8983-45bb-b694-42d2013fec55', actions: [] },
              { path: '/organization/*', actions: ['R'] },
            ],
          },
          {
            role: 'cust1-editor',
            acl: [
              { path: '/organization/0f8ff270-968e-4007-aea1-2fa1c5e3332c', actions: ['C', 'R', 'U', 'D'] }, // july11
            ],
          },
        ];
        context.attributes.authInfo = authInfo;
        console.log('§§§ Set context.attributes.authInfo to:', JSON.stringify(authInfo));

        return authInfo;
      } else {
        this.log.debug(`Failed to authenticate with ${handler.name}`);
      }
    }

    this.log.info('No authentication handler was able to authenticate the request');
    throw new NotAuthenticatedError();
  }

  /**
   * Create an instance of AuthenticationManager.
   * @param {Array<AbstractHandler>} handlers - The handlers to be used for authentication
   * @param {Object} log - The log object
   * @return {AuthenticationManager} The authentication manager
   */
  static create(handlers, log) {
    const manager = new AuthenticationManager(log);

    if (!Array.isArray(handlers)) {
      throw new Error('Invalid handlers');
    }

    if (!handlers.length) {
      throw new Error('No handlers provided');
    }

    handlers.forEach((handler) => {
      manager.#registerHandler(handler);
    });

    return manager;
  }
}
