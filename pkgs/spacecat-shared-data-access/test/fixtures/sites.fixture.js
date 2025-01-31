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

const sites = [
  {
    siteId: '5d6d4439-6659-46c2-b646-92d110fa5a52',
    baseURL: 'https://example0.com',
    deliveryType: 'aem_edge',
    gitHubURL: 'https://github.com/org-0/test-repo',
    organizationId: '4854e75e-894b-4a74-92bf-d674abad1423',
    isLive: true,
    isLiveToggledAt: '2024-11-29T07:45:55.952Z',
    GSI1PK: 'ALL_SITES',
    config: {
      handlers: {
        404: {
          mentions: {
            slack: [],
          },
        },
        'broken-backlinks': {
          excludedURLs: [],
          manualOverwrites: [],
          fixedURLs: [],
          mentions: {
            slack: [],
          },
        },
      },
      slack: {
        channel: 'some-channel',
      },
      imports: [
        {
          type: 'rum-to-aa',
          mapper: {
            mapping: {
              pageURL: {
                rumField: 'url',
              },
              userAgent: {
                default: 'rum/1.0.0',
              },
              eVars: {
                eVar4: {
                  default: 'RUM',
                },
                eVar3: {
                  rumField: 'url',
                },
              },
              events: {
                event4: {
                  rumField: 'pageviews',
                },
              },
              reportSuiteID: {
                default: 'ageo1xxpnwdemoexpleugue',
              },
              visitorID: {
                default: '000',
              },
            },
            timezone: 'UTC-07:00',
          },
        },
      ],
    },
  },
  {
    siteId: '78fec9c7-2141-4600-b7b1-ea5c78752b91',
    baseURL: 'https://example1.com',
    deliveryType: 'aem_cs',
    gitHubURL: 'https://github.com/org-1/test-repo',
    organizationId: '757ceb98-05c8-4e07-bb23-bc722115b2b0',
    isLive: true,
    isLiveToggledAt: '2024-11-29T07:45:55.952Z',
    GSI1PK: 'ALL_SITES',
    createdAt: '2024-11-29T07:45:55.952Z',
    updatedAt: '2024-11-29T07:45:55.952Z',
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
                byOrg: true,
                mentions:
                  {
                    slack:
                      [
                        '1-slackId',
                      ],
                  },
              },
            'lhs-mobile':
              {
                excludedURLs:
                  [
                    'https://example.com/excluded',
                  ],
              },
          },
      },
  },
  {
    siteId: '56a691db-d32e-4308-ac99-a21de0580557',
    baseURL: 'https://example2.com',
    deliveryType: 'aem_edge',
    gitHubURL: 'https://github.com/org-2/test-repo',
    organizationId: '5d42bdf8-b65d-4de8-b849-a4f28ebc93cd',
    isLive: true,
    isLiveToggledAt: '2024-11-29T07:45:55.952Z',
    GSI1PK: 'ALL_SITES',
    createdAt: '2024-11-29T07:45:55.952Z',
    updatedAt: '2024-11-29T07:45:55.952Z',
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
                byOrg: true,
                mentions:
                  {
                    slack:
                      [
                        '2-slackId',
                      ],
                  },
              },
            'lhs-mobile':
              {
                excludedURLs:
                  [
                    'https://example.com/excluded',
                  ],
              },
          },
      },
  },
  {
    siteId: '196fb401-ede2-4607-9d25-7c011a65d143',
    baseURL: 'https://example3.com',
    deliveryType: 'aem_cs',
    gitHubURL: 'https://github.com/org-3/test-repo',
    organizationId: '4854e75e-894b-4a74-92bf-d674abad1423',
    isLive: true,
    isLiveToggledAt: '2024-11-29T07:45:55.952Z',
    GSI1PK: 'ALL_SITES',
    createdAt: '2024-11-29T07:45:55.952Z',
    updatedAt: '2024-11-29T07:45:55.952Z',
    config:
      {
        slack:
          {
            workspace: '3-workspace',
            channel: '3-channel',
          },
        handlers:
          {
            404:
              {
                byOrg: true,
                mentions:
                  {
                    slack:
                      [
                        '3-slackId',
                      ],
                  },
              },
            'lhs-mobile':
              {
                excludedURLs:
                  [
                    'https://example.com/excluded',
                  ],
              },
          },
      },
  },
  {
    siteId: 'c6f41da6-3a7e-4a59-8b8d-2da742ac2dbe',
    baseURL: 'https://example4.com',
    deliveryType: 'aem_edge',
    gitHubURL: 'https://github.com/org-4/test-repo',
    organizationId: '757ceb98-05c8-4e07-bb23-bc722115b2b0',
    isLive: true,
    isLiveToggledAt: '2024-11-29T07:45:55.952Z',
    GSI1PK: 'ALL_SITES',
    createdAt: '2024-11-29T07:45:55.952Z',
    updatedAt: '2024-11-29T07:45:55.952Z',
    config:
      {
        slack:
          {
            workspace: '4-workspace',
            channel: '4-channel',
          },
        handlers:
          {
            404:
              {
                byOrg: true,
                mentions:
                  {
                    slack:
                      [
                        '4-slackId',
                      ],
                  },
              },
            'lhs-mobile':
              {
                excludedURLs:
                  [
                    'https://example.com/excluded',
                  ],
              },
          },
      },
  },
  {
    siteId: 'b1ec63c4-87de-4500-bbc9-276039e4bc10',
    baseURL: 'https://example5.com',
    deliveryType: 'aem_cs',
    gitHubURL: 'https://github.com/org-5/test-repo',
    organizationId: '5d42bdf8-b65d-4de8-b849-a4f28ebc93cd',
    isLive: true,
    isLiveToggledAt: '2024-11-29T07:45:55.952Z',
    GSI1PK: 'ALL_SITES',
    createdAt: '2024-11-29T07:45:55.952Z',
    updatedAt: '2024-11-29T07:45:55.952Z',
    config:
      {
        slack:
          {
            workspace: '5-workspace',
            channel: '5-channel',
          },
        handlers:
          {
            404:
              {
                byOrg: true,
                mentions:
                  {
                    slack:
                      [
                        '5-slackId',
                      ],
                  },
              },
            'lhs-mobile':
              {
                excludedURLs:
                  [
                    'https://example.com/excluded',
                  ],
              },
          },
      },
  },
  {
    siteId: '3429cedf-06b0-489f-b066-81cada1634fc',
    baseURL: 'https://example6.com',
    deliveryType: 'aem_edge',
    gitHubURL: 'https://github.com/org-6/test-repo',
    organizationId: '4854e75e-894b-4a74-92bf-d674abad1423',
    isLive: true,
    isLiveToggledAt: '2024-11-29T07:45:55.952Z',
    GSI1PK: 'ALL_SITES',
    createdAt: '2024-11-29T07:45:55.952Z',
    updatedAt: '2024-11-29T07:45:55.952Z',
    config:
      {
        slack:
          {
            workspace: '6-workspace',
            channel: '6-channel',
          },
        handlers:
          {
            404:
              {
                byOrg: true,
                mentions:
                  {
                    slack:
                      [
                        '6-slackId',
                      ],
                  },
              },
            'lhs-mobile':
              {
                excludedURLs:
                  [
                    'https://example.com/excluded',
                  ],
              },
          },
      },
  },
  {
    siteId: '73bd9bba-40bb-4249-bc69-7ea0f130481d',
    baseURL: 'https://example7.com',
    deliveryType: 'aem_cs',
    gitHubURL: 'https://github.com/org-7/test-repo',
    organizationId: '757ceb98-05c8-4e07-bb23-bc722115b2b0',
    isLive: true,
    isLiveToggledAt: '2024-11-29T07:45:55.952Z',
    GSI1PK: 'ALL_SITES',
    createdAt: '2024-11-29T07:45:55.952Z',
    updatedAt: '2024-11-29T07:45:55.952Z',
    config:
      {
        slack:
          {
            workspace: '7-workspace',
            channel: '7-channel',
          },
        handlers:
          {
            404:
              {
                byOrg: true,
                mentions:
                  {
                    slack:
                      [
                        '7-slackId',
                      ],
                  },
              },
            'lhs-mobile':
              {
                excludedURLs:
                  [
                    'https://example.com/excluded',
                  ],
              },
          },
      },
  },
  {
    siteId: 'fbb8fcba-e7d3-4ed7-8623-19e88b1f0ed5',
    baseURL: 'https://example8.com',
    deliveryType: 'aem_edge',
    gitHubURL: 'https://github.com/org-8/test-repo',
    organizationId: '5d42bdf8-b65d-4de8-b849-a4f28ebc93cd',
    isLive: true,
    isLiveToggledAt: '2024-11-29T07:45:55.952Z',
    GSI1PK: 'ALL_SITES',
    createdAt: '2024-11-29T07:45:55.952Z',
    updatedAt: '2024-11-29T07:45:55.952Z',
    config:
      {
        slack:
          {
            workspace: '8-workspace',
            channel: '8-channel',
          },
        handlers:
          {
            404:
              {
                byOrg: true,
                mentions:
                  {
                    slack:
                      [
                        '8-slackId',
                      ],
                  },
              },
            'lhs-mobile':
              {
                excludedURLs:
                  [
                    'https://example.com/excluded',
                  ],
              },
          },
      },
  },
  {
    siteId: 'b197d10e-035e-433b-896f-8e4967c5de6a',
    baseURL: 'https://example9.com',
    deliveryType: 'aem_cs',
    gitHubURL: 'https://github.com/org-9/test-repo',
    organizationId: '4854e75e-894b-4a74-92bf-d674abad1423',
    isLive: true,
    isLiveToggledAt: '2024-11-29T07:45:55.952Z',
    GSI1PK: 'ALL_SITES',
    createdAt: '2024-11-29T07:45:55.952Z',
    updatedAt: '2024-11-29T07:45:55.952Z',
    config:
      {
        slack:
          {
            workspace: '9-workspace',
            channel: '9-channel',
          },
        handlers:
          {
            404:
              {
                byOrg: true,
                mentions:
                  {
                    slack:
                      [
                        '9-slackId',
                      ],
                  },
              },
            'lhs-mobile':
              {
                excludedURLs:
                  [
                    'https://example.com/excluded',
                  ],
              },
          },
      },
  },
];

export default sites;
