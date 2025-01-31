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

const organizations = [
  {
    organizationId: '4854e75e-894b-4a74-92bf-d674abad1423',
    imsOrgId: '0-1234@AdobeOrg',
    name: '0-1234Name',
    config:
      {
        slack:
          {
            workspace: '0-workspace',
            channel: '0-channel',
          },
        handlers:
          {
            404:
              {
                mentions:
                  {
                    slack:
                      [
                        '0-slackId',
                      ],
                  },
              },
            'organic-keywords':
              {
                country: 'RO',
              },
          },
      },
  },
  {
    organizationId: '757ceb98-05c8-4e07-bb23-bc722115b2b0',
    imsOrgId: '1-1234@AdobeOrg',
    name: '1-1234Name',
    config:
      {
        slack:
          {
            workspace: '1-workspace',
            channel: '1-channel',
          },
        handlers:
          {
            404:
              {
                mentions:
                  {
                    slack:
                      [
                        '1-slackId',
                      ],
                  },
              },
            'organic-keywords':
              {
                country: 'RO',
              },
          },
      },
  },
  {
    organizationId: '5d42bdf8-b65d-4de8-b849-a4f28ebc93cd',
    imsOrgId: '2-1234@AdobeOrg',
    name: '2-1234Name',
    config:
      {
        slack:
          {
            workspace: '2-workspace',
            channel: '2-channel',
          },
        handlers:
          {
            404:
              {
                mentions:
                  {
                    slack:
                      [
                        '2-slackId',
                      ],
                  },
              },
            'organic-keywords':
              {
                country: 'RO',
              },
          },
      },
  },
];

export default organizations;
