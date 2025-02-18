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
import chaiAsPromised from 'chai-as-promised';
import nock from 'nock';
import sinon from 'sinon';

import ImsClient from '../../src/clients/ims-client.js';

import {
  GROUP_1_ID,
  GROUP_2_ID,
  IMS_FETCH_GROUP_1_MEMBERS_RESPONSE,
  IMS_FETCH_GROUP_2_MEMBERS_RESPONSE,
  IMS_FETCH_ORG_DETAILS_NO_GROUPS_RESPONSE,
  IMS_FETCH_ORG_DETAILS_ONE_GROUP_RESPONSE,
  IMS_FETCH_ORG_DETAILS_RESPONSE,
  IMS_FETCH_PC_BY_ORG_RESPONSE,
} from './ims-sample-responses.js';

use(chaiAsPromised);

describe('ImsClient', () => {
  const DUMMY_HOST = 'ims.example.com';
  let mockLog;
  let sandbox;
  let mockContext;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    mockLog = sinon.mock(console);
    mockContext = {
      log: mockLog.object,
      env: {
        IMS_HOST: DUMMY_HOST,
        IMS_CLIENT_ID: 'clientIdExample',
        IMS_CLIENT_CODE: 'clientCodeExample',
        IMS_CLIENT_SECRET: 'clientSecretExample',
        IMS_SCOPE: 'scope',
      },
    };
  });

  afterEach(() => {
    nock.cleanAll();
    sandbox.restore();
  });

  function mockImsTokenResponse() {
    return nock(`https://${DUMMY_HOST}`)
      .post('/ims/token/v4')
      .reply(200, {
        access_token: 'ZHVtbXktYWNjZXNzLXRva2Vu',
      });
  }

  describe('constructor and createFrom', () => {
    it('throws errors for missing configuration using createFrom', () => {
      expect(() => ImsClient.createFrom({
        env: {},
        log: console,
      })).to.throw('Context param must include properties: imsHost, clientId, clientCode, and clientSecret.');
      expect(() => ImsClient.createFrom({
        env: {
          IMS_HOST: 'ims.example.com',
        },
        log: console,
      })).to.throw('Context param must include properties: imsHost, clientId, clientCode, and clientSecret.');
      expect(() => ImsClient.createFrom({
        env: {
          IMS_HOST: 'ims.example.com',
          IMS_CLIENT_ID: 'clientIdExample',
        },
        log: console,
      })).to.throw('Context param must include properties: imsHost, clientId, clientCode, and clientSecret.');
      expect(() => ImsClient.createFrom({
        env: {
          IMS_HOST: 'ims.example.com',
          IMS_CLIENT_ID: 'clientIdExample',
          IMS_CLIENT_CODE: 'clientCodeExample',
        },
        log: console,
      })).to.throw('Context param must include properties: imsHost, clientId, clientCode, and clientSecret.');
    });
  });

  describe('getImsOrganizationDetails', () => {
    const testOrgId = '1234567890ABCDEF12345678@AdobeOrg';
    const testOrgId2 = '5674567890ABCDEF12345678@AdobeOrg';
    let client;

    beforeEach(() => {
      client = ImsClient.createFrom(mockContext);
    });

    it('should throw an error for invalid imsOrgId', async () => {
      await expect(client.getImsOrganizationDetails('')).to.be.rejectedWith('imsOrgId param is required.');
    });

    it('should respond with a list of users for the given organization', async () => {
      // Mock all the IMS API interactions
      mockImsTokenResponse()
        // Mock the request for the organization's product context
        .post('/ims/fetch_pc_by_org/v1')
        .reply(200, IMS_FETCH_PC_BY_ORG_RESPONSE)
        // Mock the request for the organization's details
        .get(`/ims/organizations/${testOrgId}/v2`)
        .query({ client_id: mockContext.env.IMS_CLIENT_ID })
        .reply(200, IMS_FETCH_ORG_DETAILS_RESPONSE)
        // Mock the request for group members in 123456789
        .get(`/ims/organizations/${testOrgId}/groups/${GROUP_1_ID}/members`)
        .query({ client_id: mockContext.env.IMS_CLIENT_ID })
        .reply(200, IMS_FETCH_GROUP_1_MEMBERS_RESPONSE)
        // Mock the request for group members in 222223333
        .get(`/ims/organizations/${testOrgId}/groups/${GROUP_2_ID}/members`)
        .query({ client_id: mockContext.env.IMS_CLIENT_ID })
        .reply(200, IMS_FETCH_GROUP_2_MEMBERS_RESPONSE);

      const orgDetails = await client.getImsOrganizationDetails(testOrgId);

      expect(orgDetails).to.be.an('object');
      expect(orgDetails.orgName).to.equal('Example Org Human Readable Name');
      expect(orgDetails.tenantId).to.equal('example-tenant-id');
      expect(orgDetails.orgType).to.equal('Enterprise');
      expect(orgDetails.countryCode).to.equal('CA');

      expect(orgDetails.admins).to.be.an('array');
      expect(orgDetails.admins).to.have.length(2);
      expect(orgDetails.admins[0].email).to.equal('test-user-1@example.com');
      expect(orgDetails.admins[1].email).to.equal('test-user-2@example.com');
    });

    it('should handle IMS service token request failures', async () => {
      nock(`https://${DUMMY_HOST}`)
        // Mock the token request, with a 500 server error response
        .post('/ims/token/v4')
        .query(true)
        .reply(500);

      await expect(client.getImsOrganizationDetails('123456@AdobeOrg')).to.be.rejectedWith('IMS getServiceAccessToken request failed with status: 500');
    });

    it('should handle IMS service token request v3', async () => {
      nock(`https://${DUMMY_HOST}`)
        // Mock the token request, with a 500 server error response
        .post('/ims/token/v3')
        .query(true)
        .reply(200, {
          access_token: '1234',
          expires_in: 1,
          token_type: 'abc',
        });

      await expect(client.getServiceAccessTokenV3()).to.be.eventually.deep.equal({
        access_token: '1234',
        expires_in: 1,
        token_type: 'abc',
      });
    });

    it('should not call api if service token present handle IMS service token request v3', async () => {
      client.serviceAccessTokenV3 = {
        access_token: '1234',
        expires_in: 1,
        token_type: 'abc',
      };
      await expect(client.getServiceAccessTokenV3()).to.be.eventually.deep.equal({
        access_token: '1234',
        expires_in: 1,
        token_type: 'abc',
      });
      delete client.serviceAccessTokenV3;
    });

    it('should handle IMS service token v3 request failures', async () => {
      nock(`https://${DUMMY_HOST}`)
        // Mock the token request, with a 500 server error response
        .post('/ims/token/v3')
        .query(true)
        .reply(500);

      await expect(client.getServiceAccessTokenV3()).to.be.rejectedWith('IMS getServiceAccessTokenV3 request failed with status: 500');
    });

    it('should handle IMS product context request failures', async () => {
      mockImsTokenResponse()
        .post('/ims/fetch_pc_by_org/v1')
        .reply(404);

      await expect(client.getImsOrganizationDetails('123456@AdobeOrg')).to.be.rejectedWith('IMS getProductContextsByImsOrgId request failed with status: 404');
    });

    it('should handle unknown IMS org IDs', async () => {
      mockImsTokenResponse()
        .post('/ims/fetch_pc_by_org/v1')
        .reply(400);

      await expect(client.getImsOrganizationDetails('unknown@AdobeOrg')).to.be.rejectedWith('IMS getProductContextsByImsOrgId request failed with status: 400');
    });

    it('should handle IMS organization details request failures', async () => {
      mockImsTokenResponse()
        // Mock the request for the organization's product context
        .post('/ims/fetch_pc_by_org/v1')
        .reply(200, IMS_FETCH_PC_BY_ORG_RESPONSE)
        // Mock the request for the organization's details
        .get(`/ims/organizations/${testOrgId2}/v2`)
        .query(true)
        .reply(401);

      await expect(client.getImsOrganizationDetails(testOrgId2)).to.be.rejectedWith('IMS getImsOrgDetails request failed with status: 401');
    });

    it('should handle IMS group member request failures', async () => {
      mockImsTokenResponse()
        // Mock the request for the organization's product context
        .post('/ims/fetch_pc_by_org/v1')
        .reply(200, IMS_FETCH_PC_BY_ORG_RESPONSE)
        // Mock the request for the organization's details
        .get(`/ims/organizations/${testOrgId}/v2`)
        .query(true)
        .reply(200, IMS_FETCH_ORG_DETAILS_RESPONSE)
        // Mock the request for group members in 123456789
        .get(`/ims/organizations/${testOrgId}/groups/${GROUP_1_ID}/members`)
        .query(true)
        .reply(500);

      await expect(client.getImsOrganizationDetails(testOrgId)).to.be.rejectedWith('IMS getUsersByImsGroupId request failed with status: 500');
    });

    it('should handle IMS organizations with no groups', async () => {
      mockImsTokenResponse()
        // Mock the request for the organization's product context
        .post('/ims/fetch_pc_by_org/v1')
        .reply(200, IMS_FETCH_PC_BY_ORG_RESPONSE)
        // Mock the request for the organization's details
        .get(`/ims/organizations/${testOrgId2}/v2`)
        .query(true)
        .reply(200, IMS_FETCH_ORG_DETAILS_NO_GROUPS_RESPONSE);

      const orgDetails = await client.getImsOrganizationDetails(testOrgId2);
      expect(orgDetails.admins).to.be.an('array');
      expect(orgDetails.admins).to.have.length(0);
    });

    it('should handle IMS organizations with no users in a group', async () => {
      mockImsTokenResponse()
        // Mock the request for the organization's product context
        .post('/ims/fetch_pc_by_org/v1')
        .reply(200, IMS_FETCH_PC_BY_ORG_RESPONSE)
        // Mock the request for the organization's details
        .get(`/ims/organizations/${testOrgId}/v2`)
        .query(true)
        .reply(200, IMS_FETCH_ORG_DETAILS_ONE_GROUP_RESPONSE)
        // Mock the request for group members in 123456789
        .get(`/ims/organizations/${testOrgId}/groups/${GROUP_1_ID}/members`)
        .query(true)
        .reply(200, {
          orgName: 'Example Org 2 Human Readable Name',
          orgType: 'Enterprise',
          countryCode: 'CA',
          // no groups property
        });

      const orgDetails = await client.getImsOrganizationDetails(testOrgId);
      expect(orgDetails.admins).to.be.an('array');
      expect(orgDetails.admins).to.have.length(0);
    });
  });

  describe('getImsUserProfile', () => {
    const testAccessToken = 'eyJhbGciOiJIUzI1NiJ9.eyJpZCI6IjEyMzQ1IiwidHlwZSI6ImFjY2Vzc190b2tlbiIsImNsaWVudF9pZCI6ImV4YW1wbGVfYXBwIiwidXNlcl9pZCI6Ijk4NzY1NDc4OTBBQkNERUYxMjM0NTY3OEBhYmNkZWYxMjM0NTY3ODkuZSIsImFzIjoiaW1zLW5hMSIsImFhX2lkIjoiMTIzNDU2Nzg5MEFCQ0RFRjEyMzQ1Njc4QGFkb2JlLmNvbSIsImNyZWF0ZWRfYXQiOiIxNzEwMjQ3MDAwMDAwIn0.MRDpxgxSHDj4DmA182hPnjMAnKkly-VUJ_bXpQ-J8EQ';
    let client;

    beforeEach(() => {
      client = ImsClient.createFrom(mockContext);

      nock(`https://${DUMMY_HOST}`)
        .get('/ims/profile/v1')
        .matchHeader('Authorization', (val) => val === `Bearer ${testAccessToken}`)
        .reply(200, {
          preferred_languages: ['en-us'],
          displayName: 'Example User',
          roles: [
            {
              organization: '1234567890ABCDEF12345678@AdobeOrg',
              named_role: 'user_admin_grp',
            },
            {
              organization: '1234567890ABCDEF12345678@AdobeOrg',
              named_role: 'PRODUCT_ADMIN',
            },
          ],
          userId: '9876547890ABCDEF12345678@abcdef123456789.e',
          countryCode: 'CA',
          email: 'example-user@example.com',
        });

      // Fallback
      nock(`https://${DUMMY_HOST}`)
        .get('/ims/profile/v1')
        .reply(401, {
          error: 'invalid_token',
          error_description: 'Invalid or expired token.',
        });
    });

    it('should fail for edge cases: no token', async () => {
      await expect(client.getImsUserProfile(null)).to.be.rejectedWith('IMS getImsUserProfile request failed with status: 401');
    });

    it('should fail for edge cases: invalid token', async () => {
      await expect(client.getImsUserProfile('eyJhbGciOiJIUzI1NiJ9.eyJpZCI6IjEyMzQ1IiwidHlwZSI6')).to.be.rejectedWith('IMS getImsUserProfile request failed with status: 401');
    });

    it('should succeed for a valid token', async () => {
      const result = await client.getImsUserProfile(testAccessToken);
      expect(result).to.deep.equal({
        email: 'example-user@example.com',
        userId: '9876547890ABCDEF12345678@abcdef123456789.e',
        organizations: ['1234567890ABCDEF12345678@AdobeOrg'],
        orgDetails: {},
      });
    });
  });

  describe('getImsUserProfile 2', () => {
    const testAccessToken = 'eyJhbGciOiJIUzI1NiJ9.eyJpZCI6IjEyMzQ1IiwidHlwZSI6ImFjY2Vzc190b2tlbiIsImNsaWVudF9pZCI6ImV4YW1wbGVfYXBwIiwidXNlcl9pZCI6Ijk4NzY1NDc4OTBBQkNERUYxMjM0NTY3OEBhYmNkZWYxMjM0NTY3ODkuZSIsImFzIjoiaW1zLW5hMSIsImFhX2lkIjoiMTIzNDU2Nzg5MEFCQ0RFRjEyMzQ1Njc4QGFkb2JlLmNvbSIsImNyZWF0ZWRfYXQiOiIxNzEwMjQ3MDAwMDAwIn0.MRDpxgxSHDj4DmA182hPnjMAnKkly-VUJ_bXpQ-J8EQ';
    let client;

    beforeEach(() => {
      client = ImsClient.createFrom(mockContext);

      nock(`https://${DUMMY_HOST}`)
        .get('/ims/profile/v1')
        .matchHeader('Authorization', (val) => val === `Bearer ${testAccessToken}`)
        .reply(200, {
          displayName: 'Example User',
          roles: [
            {
              organization: 'F00FEEFAA123@AdobeOrg',
              named_role: 'some_role',
            },
          ],
          projectedProductContext: [{
            prodCtx: {
              owningEntity: 'F00FEEFAA123@AdobeOrg',
              groupid: '348994793',
              user_visible_name: 'MY_ROLE_PROFILE',
            },
          }, {
            prodCtx: {
              owningEntity: 'F00FEEFAA123@AdobeOrg',
              groupid: '348994794',
              user_visible_name: 'YOUR_ROLE_PROFILE',
            },
          }],
          userId: '111@aaa.e',
          email: 'foo@blah.org',
        });

      // Fallback
      nock(`https://${DUMMY_HOST}`)
        .get('/ims/profile/v1')
        .reply(401, {
          error: 'invalid_token',
          error_description: 'Invalid or expired token.',
        });
    });

    it('should report groups from product context', async () => {
      const result = await client.getImsUserProfile(testAccessToken);
      expect(result).to.deep.equal({
        email: 'foo@blah.org',
        userId: '111@aaa.e',
        organizations: ['F00FEEFAA123@AdobeOrg'],
        orgDetails: {
          'F00FEEFAA123@AdobeOrg': {
            groups: [{
              groupid: '348994793',
              user_visible_name: 'MY_ROLE_PROFILE',
            }, {
              groupid: '348994794',
              user_visible_name: 'YOUR_ROLE_PROFILE',
            }],
          },
        },
      });
    });
  });
});
