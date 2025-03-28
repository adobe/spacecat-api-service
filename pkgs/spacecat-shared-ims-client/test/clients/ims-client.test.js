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
    const mockUserProfile = {
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
    };

    let client;

    beforeEach(() => {
      client = ImsClient.createFrom(mockContext);

      nock(`https://${DUMMY_HOST}`)
        .get('/ims/profile/v1')
        .matchHeader('Authorization', (val) => val === `Bearer ${testAccessToken}`)
        .reply(200, mockUserProfile);

      // Fallback
      nock(`https://${DUMMY_HOST}`)
        .get('/ims/profile/v1')
        .reply(401, {
          error: 'invalid_token',
          error_description: 'Invalid or expired token.',
        });
    });

    it('should fail for edge cases: no token', async () => {
      await expect(client.getImsUserProfile(null)).to.be.rejectedWith('imsAccessToken param is required.');
    });

    it('should fail for edge cases: invalid token', async () => {
      await expect(client.getImsUserProfile('eyJhbGciOiJIUzI1NiJ9.eyJpZCI6IjEyMzQ1IiwidHlwZSI6')).to.be.rejectedWith('IMS getImsUserProfile request failed with status: 401');
    });

    it('should succeed for a valid token', async () => {
      const result = await client.getImsUserProfile(testAccessToken);
      await expect(result).to.deep.equal({
        ...mockUserProfile,
        organizations: [
          '1234567890ABCDEF12345678@AdobeOrg',
        ],
      });
    });
  });

  describe('getImsUserOrganizations', () => {
    let client;

    beforeEach(() => {
      client = ImsClient.createFrom(mockContext);
    });

    it('throws error if no access token is provided', async () => {
      await expect(client.getImsUserOrganizations(null)).to.be.rejectedWith('imsAccessToken param is required.');
    });

    it('throws error if fetch throws error', async () => {
      nock(`https://${DUMMY_HOST}`)
        .get('/ims/organizations/v6')
        .replyWithError('test error');

      await expect(client.getImsUserOrganizations('some-token')).to.be.rejectedWith('test error');
    });

    it('throws error if request fails', async () => {
      nock(`https://${DUMMY_HOST}`)
        .get('/ims/organizations/v6')
        .reply(500, {
          error: 'server_error',
          error_description: 'Boom',
        });

      await expect(client.getImsUserOrganizations('some-token')).to.be.rejectedWith('IMS getImsUserOrganizations request failed with status: 500');
    });

    it('returns an array of organizations', async () => {
      const mockBody = [
        {
          orgRef: { ident: '1234567890ABCDEF12345678', authSrc: 'AdobeOrg' },
          orgName: 'Example Org Human Readable Name',
          orgType: 'Enterprise',
          countryCode: 'CA',
          groups: [{
            groupName: 'Test Group 1',
            role: 'some-role-1',
            ident: '12345',
            groupType: 'some-group-type-1',
            groupDisplayName: 'Test Group 1',
          }],
        },
        {
          orgRef: { ident: '5674567890ABCDEF12345678', authSrc: 'AdobeOrg' },
          orgName: 'Example Org 2 Human Readable Name',
          orgType: 'Enterprise',
          countryCode: 'US',
          groups: [{
            groupName: 'Test Group 2',
            role: 'some-role-2',
            ident: '12346',
            groupType: 'some-group-type-2',
            groupDisplayName: 'Test Group 2',
          }],
        },
      ];

      nock(`https://${DUMMY_HOST}`)
        .get('/ims/organizations/v6')
        .reply(200, mockBody);

      const orgs = await client.getImsUserOrganizations('some-token');
      expect(orgs).to.deep.equal(mockBody);
    });
  });

  describe('validateAccessToken', () => {
    let client;

    beforeEach(() => {
      client = ImsClient.createFrom(mockContext);
    });

    it('throws error if no access token is provided', async () => {
      await expect(client.validateAccessToken('')).to.be.rejectedWith('imsAccessToken param is required.');
    });

    it('throws error if request fails', async () => {
      nock(`https://${DUMMY_HOST}`)
        .post('/ims/validate_token/v1')
        .reply(500, {
          error: 'server_error',
          error_description: 'Boom',
        });

      await expect(client.validateAccessToken('some-token')).to.be.rejectedWith('IMS validateAccessToken request failed with status: 500');
    });

    it('returns false if token is invalid', async () => {
      nock(`https://${DUMMY_HOST}`)
        .post('/ims/validate_token/v1')
        .reply(200, {
          valid: false,
        });

      await expect(client.validateAccessToken('some-token')).to.eventually.eql({ valid: false });
    });

    it('returns result if token is valid', async () => {
      const expectedResult = {
        valid: true,
        token: { sub: '1234567890ABCDEF12345678@AdobeOrg' },
      };

      nock(`https://${DUMMY_HOST}`)
        .post('/ims/validate_token/v1')
        .reply(200, expectedResult);

      await expect(client.validateAccessToken('some-token')).to.eventually.eql(expectedResult);
    });
  });
});
