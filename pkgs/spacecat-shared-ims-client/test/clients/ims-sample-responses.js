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

export const IMS_FETCH_PC_BY_ORG_RESPONSE = {
  productContexts: [
    {
      serviceCode: 'example_code',
      params: {
        tenant_id: 'example-tenant-id',
      },
    },
  ],
};

export const GROUP_1_ID = 123456789;
export const GROUP_2_ID = 222223333;

export const IMS_FETCH_ORG_DETAILS_RESPONSE = {
  orgName: 'Example Org Human Readable Name',
  orgType: 'Enterprise',
  countryCode: 'CA',
  groups: [
    {
      groupName: 'Administrators',
      role: 'GRP_ADMIN',
      ident: GROUP_1_ID,
    },
    {
      groupName: 'Developers',
      role: 'GRP_ADMIN',
      ident: GROUP_2_ID,
    },
  ],
};

export const IMS_FETCH_ORG_DETAILS_ONE_GROUP_RESPONSE = {
  orgName: 'Example Org Human Readable Name',
  orgType: 'Enterprise',
  countryCode: 'CA',
  groups: [
    {
      groupName: 'Administrators',
      role: 'GRP_ADMIN',
      ident: GROUP_1_ID,
    },
    {
      groupName: 'Members',
      role: 'TEAM_MEMBER',
    },
  ],
};

export const IMS_FETCH_ORG_DETAILS_NO_GROUPS_RESPONSE = {
  orgName: 'Example Org 3 Human Readable Name',
  orgType: 'Enterprise',
  countryCode: 'ES',
};

export const IMS_FETCH_GROUP_1_MEMBERS_RESPONSE = {
  startIndex: 0,
  batchSize: 1,
  totalSize: 1,
  items: [
    {
      username: 'test-user-1@example.com',
      email: 'test-user-1@example.com',
      firstName: 'Test',
      lastName: 'User 1',
    },
  ],
};

export const IMS_FETCH_GROUP_2_MEMBERS_RESPONSE = {
  startIndex: 0,
  batchSize: 5,
  totalSize: 5,
  items: [
    {
      username: 'test-user-1@example.com',
      firstName: 'Test',
      lastName: 'User 1',
    },
    {
      email: 'test-user-2@example.com',
      firstName: 'Test',
      lastName: 'User 2',
    },
    {
      firstName: 'No email or username',
    },
    {
      email: 'bad-email-example.com',
    },
    {
      email: 'should-be-ignored@techacct.adobe.com',
    },
  ],
};
