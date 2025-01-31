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

const configurations = [
  {
    configurationId: '3c29b306-5075-4a2d-a965-730d0e565e7f',
    jobs: [
      {
        group: 'audits',
        type: 'lhs-mobile',
        interval: 'daily',
      },
      {
        group: 'audits',
        type: '404',
        interval: 'daily',
      },
      {
        group: 'imports',
        type: 'rum-ingest',
        interval: 'daily',
      },
      {
        group: 'reports',
        type: '404-external-digest',
        interval: 'weekly',
      },
      {
        group: 'audits',
        type: 'apex',
        interval: 'weekly',
      },
    ],
    handlers: {
      404: {
        enabledByDefault: true,
      },
      'organic-keywords': {
        enabledByDefault: false,
      },
      cwv: {
        enabledByDefault: true,
        disabled: {
          sites: [
            '5d6d4439-6659-46c2-b646-92d110fa5a52',
            '78fec9c7-2141-4600-b7b1-ea5c78752b91',
            '56a691db-d32e-4308-ac99-a21de0580557',
            '196fb401-ede2-4607-9d25-7c011a65d143',
            'c6f41da6-3a7e-4a59-8b8d-2da742ac2dbe',
            'b1ec63c4-87de-4500-bbc9-276039e4bc10',
            '3429cedf-06b0-489f-b066-81cada1634fc',
            '73bd9bba-40bb-4249-bc69-7ea0f130481d',
            'fbb8fcba-e7d3-4ed7-8623-19e88b1f0ed5',
            'b197d10e-035e-433b-896f-8e4967c5de6a',
          ],
          orgs: ['757ceb98-05c8-4e07-bb23-bc722115b2b0'],
        },
      },
      'lhs-mobile': {
        enabledByDefault: false,
        enabled: {
          sites: ['c6f41da6-3a7e-4a59-8b8d-2da742ac2dbe'],
          orgs: ['757ceb98-05c8-4e07-bb23-bc722115b2b0'],
        },
      },
    },
    queues: {
      audits: 'sqs://.../spacecat-services-audit-jobs',
      imports: 'sqs://.../spacecat-services-import-jobs',
      reports: 'sqs://.../spacecat-services-report-jobs',
    },
    slackRoles: {
      scrape: [
        'WSVT1K36Z',
        'S03CR0FDC2V',
      ],
    },
    version: 2,
  },
  {
    configurationId: 'a76a5b01-d065-4349-a28f-f1beaf96aee6',
    jobs: [
      {
        group: 'audits',
        type: 'lhs-mobile',
        interval: 'daily',
      },
      {
        group: 'reports',
        type: '404-external-digest',
        interval: 'weekly',
      },
    ],
    queues: {
      audits: 'sqs://.../spacecat-services-audit-jobs',
      reports: 'sqs://.../spacecat-services-report-jobs',
    },
    version: 1,
  },
];

export default configurations;
