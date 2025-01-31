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

const audits = [
  {
    siteId: '78fec9c7-2141-4600-b7b1-ea5c78752b91',
    auditType: 'lhs-mobile',
    auditedAt: '2024-12-03T08:01:55.754Z',
    auditResult: {
      scores: {
        performance: 0.01,
        seo: 0.56,
        accessibility: 0.23,
        'best-practices': 0.09,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/49a5a731-e2f2-41ef-bc5d-bda818c0afa2.json',
    auditId: '3fe5ca60-4850-431c-97b3-f88a80f07e9b',
  },
  {
    siteId: '78fec9c7-2141-4600-b7b1-ea5c78752b91',
    auditType: 'lhs-mobile',
    auditedAt: '2024-12-03T08:02:55.754Z',
    auditResult: {
      scores: {
        performance: 0.58,
        seo: 0.89,
        accessibility: 0.83,
        'best-practices': 0.35,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/d86ff424-76a5-45aa-8bae-817415056802.json',
    auditId: '48656b02-62cb-46c0-b271-ee99c940e89e',
  },
  {
    siteId: '78fec9c7-2141-4600-b7b1-ea5c78752b91',
    auditType: 'lhs-mobile',
    auditedAt: '2024-12-03T08:03:55.754Z',
    auditResult: {
      scores: {
        performance: 0.13,
        seo: 0.91,
        accessibility: 0.38,
        'best-practices': 0.51,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/ace35131-98c8-4578-8bc9-06537f1cffb4.json',
    auditId: '5bc610a9-bc59-48d8-937e-4808ade2ecb1',
  },
  {
    siteId: '78fec9c7-2141-4600-b7b1-ea5c78752b91',
    auditType: 'lhs-mobile',
    auditedAt: '2024-12-03T08:04:55.754Z',
    auditResult: {
      scores: {
        performance: 0.1,
        seo: 0.34,
        accessibility: 0.24,
        'best-practices': 0.6,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/4f861df7-d074-472b-8df8-b96e8c132145.json',
    auditId: '62cc5af2-935f-47dd-b60e-87307f39c475',
  },
  {
    siteId: '78fec9c7-2141-4600-b7b1-ea5c78752b91',
    auditType: 'lhs-mobile',
    auditedAt: '2024-12-03T08:05:55.754Z',
    auditResult: {
      scores: {
        performance: 0.51,
        seo: 0.3,
        accessibility: 0.71,
        'best-practices': 0.63,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/80284b70-0e3c-49f8-b470-8c073f002b7d.json',
    auditId: '82250098-ca65-4bef-ada9-71c30102b334',
  },
  {
    siteId: '78fec9c7-2141-4600-b7b1-ea5c78752b91',
    auditType: 'cwv',
    auditedAt: '2024-12-03T08:06:55.754Z',
    auditResult: {
      scores: {
        LCP: 3815,
        FID: 35,
        CLS: 0.56,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/9f3ef6ed-d6e6-4fcc-a9ef-fab2e0955104.json',
    auditId: '5ab73d44-41ab-4603-8c28-76e2707b3182',
  },
  {
    siteId: '78fec9c7-2141-4600-b7b1-ea5c78752b91',
    auditType: 'cwv',
    auditedAt: '2024-12-03T08:07:55.754Z',
    auditResult: {
      scores: {
        LCP: 1723,
        FID: 49,
        CLS: 0.97,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/604e4a2b-47d5-479d-bab0-2bc03b41392a.json',
    auditId: 'd141c82e-5290-4352-9a81-a5400436c07c',
  },
  {
    siteId: '78fec9c7-2141-4600-b7b1-ea5c78752b91',
    auditType: 'cwv',
    auditedAt: '2024-12-03T08:08:55.754Z',
    auditResult: {
      scores: {
        LCP: 1485,
        FID: 2,
        CLS: 0,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/30486fe9-72f1-4ddb-91c8-8c41cf9e4a3a.json',
    auditId: '44d76d98-56cf-4c3d-ab6b-a2a8ee459bed',
  },
  {
    siteId: '78fec9c7-2141-4600-b7b1-ea5c78752b91',
    auditType: 'cwv',
    auditedAt: '2024-12-03T08:09:55.754Z',
    auditResult: {
      scores: {
        LCP: 1893,
        FID: 20,
        CLS: 0.35,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/b43b8240-6d83-4aac-9f8e-2ca7d89c1994.json',
    auditId: '523396a7-5b30-4e12-a439-ffb1336c6902',
  },
  {
    siteId: '78fec9c7-2141-4600-b7b1-ea5c78752b91',
    auditType: 'cwv',
    auditedAt: '2024-12-03T08:10:55.754Z',
    auditResult: {
      scores: {
        LCP: 714,
        FID: 73,
        CLS: 0.88,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/82ed94be-979e-4ce3-9c90-1919fefb855a.json',
    auditId: '998ec567-d32a-4645-a627-81c20794e6ea',
  },
  {
    siteId: '56a691db-d32e-4308-ac99-a21de0580557',
    auditType: 'lhs-mobile',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        performance: 0.25,
        seo: 0.53,
        accessibility: 0.82,
        'best-practices': 0.92,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/ab0420e5-97fb-48f2-9d9f-90e8d54e08c1.json',
    auditId: '00e6591d-f334-4c74-8446-f31c3e689e99',
  },
  {
    siteId: '56a691db-d32e-4308-ac99-a21de0580557',
    auditType: 'lhs-mobile',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        performance: 0.19,
        seo: 0.33,
        accessibility: 0.18,
        'best-practices': 0.71,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/9f190e2c-ed87-43b0-88a5-65480bd90115.json',
    auditId: 'b136b63a-5e67-46c0-80b9-68f1699d09c1',
  },
  {
    siteId: '56a691db-d32e-4308-ac99-a21de0580557',
    auditType: 'lhs-mobile',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        performance: 0.62,
        seo: 0.91,
        accessibility: 0.69,
        'best-practices': 0.97,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/04b6b484-ec63-4bd1-9e3b-cf10aa247837.json',
    auditId: '759caa14-8a41-4bee-ba87-ec60b8231b6a',
  },
  {
    siteId: '56a691db-d32e-4308-ac99-a21de0580557',
    auditType: 'lhs-mobile',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        performance: 0.67,
        seo: 0.61,
        accessibility: 0.45,
        'best-practices': 0.25,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/4f177b54-9b24-4b99-9fb5-222594819735.json',
    auditId: '0bd56305-8486-4b23-abc1-19789efb2807',
  },
  {
    siteId: '56a691db-d32e-4308-ac99-a21de0580557',
    auditType: 'lhs-mobile',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        performance: 0.41,
        seo: 0,
        accessibility: 0.04,
        'best-practices': 0.12,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/32699c46-07cd-4fc0-a71f-4a77356aa3e7.json',
    auditId: '73980def-db81-4b5b-b66d-2b94602c2261',
  },
  {
    siteId: '56a691db-d32e-4308-ac99-a21de0580557',
    auditType: 'cwv',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        LCP: 1830,
        FID: 66,
        CLS: 0.13,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/67cd3ab8-67d6-46be-adc2-c13dea7adcc0.json',
    auditId: '54cab615-8608-4d67-a999-b49235217adf',
  },
  {
    siteId: '56a691db-d32e-4308-ac99-a21de0580557',
    auditType: 'cwv',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        LCP: 1398,
        FID: 22,
        CLS: 0.45,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/c70adc49-046f-4ade-ab3e-e72f38f025fe.json',
    auditId: '2cc9ab3c-8d46-4ac7-83d7-a1231c91d34c',
  },
  {
    siteId: '56a691db-d32e-4308-ac99-a21de0580557',
    auditType: 'cwv',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        LCP: 2543,
        FID: 84,
        CLS: 0.34,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/02e9d522-911d-43a6-8d72-11e181c947e0.json',
    auditId: '059dcce7-a1a4-4224-904e-fc56620f929d',
  },
  {
    siteId: '56a691db-d32e-4308-ac99-a21de0580557',
    auditType: 'cwv',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        LCP: 108,
        FID: 37,
        CLS: 0.32,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/5ce74f5e-a728-4a75-b7f6-4a02b3f25bd7.json',
    auditId: '147bd40e-90b5-4e9d-abe1-df30cd16d095',
  },
  {
    siteId: '56a691db-d32e-4308-ac99-a21de0580557',
    auditType: 'cwv',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        LCP: 3979,
        FID: 13,
        CLS: 0.12,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/761d24ec-5bb7-4ef6-ab8b-0ce0bc5ac336.json',
    auditId: '31e257a7-534e-44ed-90a9-d24c849e246d',
  },
  {
    siteId: '196fb401-ede2-4607-9d25-7c011a65d143',
    auditType: 'lhs-mobile',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        performance: 0.79,
        seo: 0.16,
        accessibility: 0.7,
        'best-practices': 0.54,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/9afcfa59-8516-4d76-a960-842ed559eba6.json',
    auditId: 'c125fe6e-3768-43a5-ae8f-3448e01c8a1f',
  },
  {
    siteId: '196fb401-ede2-4607-9d25-7c011a65d143',
    auditType: 'lhs-mobile',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        performance: 0.57,
        seo: 0.46,
        accessibility: 0.46,
        'best-practices': 0.21,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/bd35024c-cce8-44cc-901c-321c7f25c56e.json',
    auditId: '857d3742-0757-4fc0-a7dc-2b73720d37f0',
  },
  {
    siteId: '196fb401-ede2-4607-9d25-7c011a65d143',
    auditType: 'lhs-mobile',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        performance: 0.45,
        seo: 0.8,
        accessibility: 0.88,
        'best-practices': 0.33,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/46c92f4e-eb76-4511-b296-cbcb65c47c04.json',
    auditId: '8aadfc9f-85e9-4ce8-9b7e-2f9243c57b29',
  },
  {
    siteId: '196fb401-ede2-4607-9d25-7c011a65d143',
    auditType: 'lhs-mobile',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        performance: 0.76,
        seo: 0.89,
        accessibility: 0.71,
        'best-practices': 0.51,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/89239d70-b2b6-4776-840d-439963f04a8e.json',
    auditId: '29d218aa-416a-4811-866e-0890485d21e0',
  },
  {
    siteId: '196fb401-ede2-4607-9d25-7c011a65d143',
    auditType: 'lhs-mobile',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        performance: 0.28,
        seo: 0.24,
        accessibility: 0.64,
        'best-practices': 0.79,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/a937a24e-7eed-4436-8455-176f0e6719c6.json',
    auditId: 'c6548198-de76-4a32-8053-e8d101afbd68',
  },
  {
    siteId: '196fb401-ede2-4607-9d25-7c011a65d143',
    auditType: 'cwv',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        LCP: 1195,
        FID: 0,
        CLS: 0.8,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/4674d92c-bf33-424b-9662-95ec1d11cbf7.json',
    auditId: '88ee2b0e-61ba-49a3-a2b4-79163418fe87',
  },
  {
    siteId: '196fb401-ede2-4607-9d25-7c011a65d143',
    auditType: 'cwv',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        LCP: 187,
        FID: 16,
        CLS: 0.55,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/84734df6-3fd6-47fd-bd13-339b8fe22298.json',
    auditId: '5b6e75e7-a0c0-414a-bc4c-16543e70b61a',
  },
  {
    siteId: '196fb401-ede2-4607-9d25-7c011a65d143',
    auditType: 'cwv',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        LCP: 3294,
        FID: 18,
        CLS: 0.27,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/f73d8165-5197-43ab-a09d-ad950a5e6ce7.json',
    auditId: '7c70acfb-f40a-4102-abc2-69f79c720bf9',
  },
  {
    siteId: '196fb401-ede2-4607-9d25-7c011a65d143',
    auditType: 'cwv',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        LCP: 3997,
        FID: 32,
        CLS: 0.16,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/f2428633-0646-41ba-81c5-7fbc81e00a98.json',
    auditId: 'cc1755f3-386c-427e-b2eb-e0b3c5515533',
  },
  {
    siteId: '196fb401-ede2-4607-9d25-7c011a65d143',
    auditType: 'cwv',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        LCP: 3730,
        FID: 73,
        CLS: 0.33,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/a716c3af-3f5a-4fa6-b408-4a5955cd4dd1.json',
    auditId: '6d43f172-3e86-45d8-83cd-6d006fb8cdad',
  },
  {
    siteId: 'c6f41da6-3a7e-4a59-8b8d-2da742ac2dbe',
    auditType: 'lhs-mobile',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        performance: 0.06,
        seo: 0.46,
        accessibility: 0.85,
        'best-practices': 0.91,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/dadcdcd7-fe40-4166-91fb-f0f8b2f237da.json',
    auditId: '761c7cc8-7ad5-4a24-aae8-90a1b0b47e9a',
  },
  {
    siteId: 'c6f41da6-3a7e-4a59-8b8d-2da742ac2dbe',
    auditType: 'lhs-mobile',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        performance: 0.26,
        seo: 0.3,
        accessibility: 0.1,
        'best-practices': 0.51,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/70df143f-f2a1-43e6-b9b8-3a56e83f67a9.json',
    auditId: 'd8e4e662-8148-471e-a1c2-e75be4fb1d1a',
  },
  {
    siteId: 'c6f41da6-3a7e-4a59-8b8d-2da742ac2dbe',
    auditType: 'lhs-mobile',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        performance: 0.54,
        seo: 0.8,
        accessibility: 0.44,
        'best-practices': 0.9,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/eb2a16ab-c44a-4486-b9f3-83447634d6e0.json',
    auditId: 'a6bfc5e8-8d9e-4f22-b549-8bf4ca7b5c66',
  },
  {
    siteId: 'c6f41da6-3a7e-4a59-8b8d-2da742ac2dbe',
    auditType: 'lhs-mobile',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        performance: 0.72,
        seo: 0.55,
        accessibility: 0.27,
        'best-practices': 0.02,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/aad60d6a-3be8-425a-8769-07942f4d6ff3.json',
    auditId: '9113159b-a93d-4d1f-aa6f-72575eefd3b3',
  },
  {
    siteId: 'c6f41da6-3a7e-4a59-8b8d-2da742ac2dbe',
    auditType: 'lhs-mobile',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        performance: 0.63,
        seo: 0.48,
        accessibility: 0.93,
        'best-practices': 0.12,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/aae172c2-c2e8-4ddb-998e-8890e8298c5f.json',
    auditId: 'aba03683-da1d-467b-b7a5-24f857f016e1',
  },
  {
    siteId: 'c6f41da6-3a7e-4a59-8b8d-2da742ac2dbe',
    auditType: 'cwv',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        LCP: 1624,
        FID: 42,
        CLS: 0.8,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/c537c3b4-1156-4397-936f-11aff4e5a22e.json',
    auditId: 'aa36a3c7-ed2b-4290-8985-86bdb7fa3881',
  },
  {
    siteId: 'c6f41da6-3a7e-4a59-8b8d-2da742ac2dbe',
    auditType: 'cwv',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        LCP: 711,
        FID: 46,
        CLS: 0.32,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/39906f6b-ed1a-4736-814a-013ec919119f.json',
    auditId: '90168755-49bc-48a2-b7f3-9852be99c8af',
  },
  {
    siteId: 'c6f41da6-3a7e-4a59-8b8d-2da742ac2dbe',
    auditType: 'cwv',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        LCP: 1213,
        FID: 84,
        CLS: 0.6,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/14f602ca-48be-4bd5-97e0-ac2eff4a6dd7.json',
    auditId: '54d580be-285c-40fb-a3b5-ec91768d4fa2',
  },
  {
    siteId: 'c6f41da6-3a7e-4a59-8b8d-2da742ac2dbe',
    auditType: 'cwv',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        LCP: 2642,
        FID: 65,
        CLS: 0.03,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/ee38a119-01f1-4ad6-81e5-209b28a76563.json',
    auditId: 'b6bc9260-5424-4fdb-9d2c-ed20084f6583',
  },
  {
    siteId: 'c6f41da6-3a7e-4a59-8b8d-2da742ac2dbe',
    auditType: 'cwv',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        LCP: 2144,
        FID: 22,
        CLS: 0.06,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/bc82ffe7-c764-4baf-b0b2-4bd815ad756c.json',
    auditId: 'dad35375-fc74-482b-bd22-946e1c013fdd',
  },
  {
    siteId: 'b1ec63c4-87de-4500-bbc9-276039e4bc10',
    auditType: 'lhs-mobile',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        performance: 0.1,
        seo: 0.04,
        accessibility: 0.99,
        'best-practices': 0.3,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/8802e432-7b64-4116-81e6-029076d6250f.json',
    auditId: '30dcaef5-49a1-41ec-8656-eee6d6480d0a',
  },
  {
    siteId: 'b1ec63c4-87de-4500-bbc9-276039e4bc10',
    auditType: 'lhs-mobile',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        performance: 0.3,
        seo: 0.54,
        accessibility: 0.25,
        'best-practices': 0.97,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/c6a8d133-b079-4229-99a6-819ed63249ae.json',
    auditId: '3fb08b5a-303d-4f2c-8e73-d929a4eff024',
  },
  {
    siteId: 'b1ec63c4-87de-4500-bbc9-276039e4bc10',
    auditType: 'lhs-mobile',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        performance: 0.56,
        seo: 0.02,
        accessibility: 0.6,
        'best-practices': 0.21,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/6a8dbfed-f957-47ec-ba48-a60b2009d7a0.json',
    auditId: '6a87be71-611f-4b05-a6cf-86a57eb349ed',
  },
  {
    siteId: 'b1ec63c4-87de-4500-bbc9-276039e4bc10',
    auditType: 'lhs-mobile',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        performance: 0.04,
        seo: 0.32,
        accessibility: 0.01,
        'best-practices': 0.97,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/474bd0b2-4faf-4f37-bed4-a670d2a09186.json',
    auditId: '43fd913f-5b14-4f18-9cc3-d49891cc4288',
  },
  {
    siteId: 'b1ec63c4-87de-4500-bbc9-276039e4bc10',
    auditType: 'lhs-mobile',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        performance: 0.68,
        seo: 0.79,
        accessibility: 0.43,
        'best-practices': 0.64,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/1dabbb60-f530-4f53-84c5-0f168b02309b.json',
    auditId: '554b8e9d-98b8-4dd5-9d58-c9ee57160530',
  },
  {
    siteId: 'b1ec63c4-87de-4500-bbc9-276039e4bc10',
    auditType: 'cwv',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        LCP: 2550,
        FID: 42,
        CLS: 0.49,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/cb9671f5-29ce-49fa-9386-e9512ef72938.json',
    auditId: '4f5f307b-a865-4362-bb25-f5e25db64230',
  },
  {
    siteId: 'b1ec63c4-87de-4500-bbc9-276039e4bc10',
    auditType: 'cwv',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        LCP: 914,
        FID: 91,
        CLS: 0.49,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/b61cfab3-12c5-4fe6-a434-5efcec1e1b2d.json',
    auditId: '295db381-d5fb-465a-a5da-2d9adbe04038',
  },
  {
    siteId: 'b1ec63c4-87de-4500-bbc9-276039e4bc10',
    auditType: 'cwv',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        LCP: 965,
        FID: 43,
        CLS: 0.63,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/929daee0-ca67-4134-91a0-28a0827655e4.json',
    auditId: '4941bddf-dd5e-45cc-9ef8-1c416fd48a5f',
  },
  {
    siteId: 'b1ec63c4-87de-4500-bbc9-276039e4bc10',
    auditType: 'cwv',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        LCP: 1957,
        FID: 69,
        CLS: 0.42,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/2f7d425f-c806-4e8f-b973-484a3c7e456a.json',
    auditId: 'b3431f8b-a338-45c7-a1fd-c4c6bb3bb56a',
  },
  {
    siteId: 'b1ec63c4-87de-4500-bbc9-276039e4bc10',
    auditType: 'cwv',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        LCP: 2579,
        FID: 38,
        CLS: 0.22,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/fc342da0-6bde-4a49-aa8f-66e7e20b8b62.json',
    auditId: '67c86f77-1ee0-4441-bdd2-adff90863f57',
  },
  {
    siteId: '3429cedf-06b0-489f-b066-81cada1634fc',
    auditType: 'lhs-mobile',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        performance: 0.87,
        seo: 0.25,
        accessibility: 0.21,
        'best-practices': 0.98,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/eb8414da-fb40-4ee5-a9d2-1f88ca8e5cca.json',
    auditId: '9b4be774-4585-4980-9f60-0881c6f34954',
  },
  {
    siteId: '3429cedf-06b0-489f-b066-81cada1634fc',
    auditType: 'lhs-mobile',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        performance: 0.03,
        seo: 0.47,
        accessibility: 0.3,
        'best-practices': 0.41,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/0cd4b808-0352-420b-b3d5-897c233edbcf.json',
    auditId: '3b84b1b1-75ed-42af-acf3-144b9966289a',
  },
  {
    siteId: '3429cedf-06b0-489f-b066-81cada1634fc',
    auditType: 'lhs-mobile',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        performance: 0.01,
        seo: 0.56,
        accessibility: 0.47,
        'best-practices': 0.64,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/52afcf01-0309-4bc6-aab6-45771115b983.json',
    auditId: '25a953af-2374-4d98-b146-00efb64a08c0',
  },
  {
    siteId: '3429cedf-06b0-489f-b066-81cada1634fc',
    auditType: 'lhs-mobile',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        performance: 0.16,
        seo: 0.25,
        accessibility: 0.42,
        'best-practices': 0.52,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/25832af5-2913-4757-8687-61e3fe5abb48.json',
    auditId: 'ff7ed730-7304-4ff8-8e49-161504fffbc9',
  },
  {
    siteId: '3429cedf-06b0-489f-b066-81cada1634fc',
    auditType: 'lhs-mobile',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        performance: 0.5,
        seo: 0.83,
        accessibility: 0.23,
        'best-practices': 0.48,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/967a1183-88a9-4a34-a207-f32de8e09c87.json',
    auditId: '152cbd10-912e-4269-97e0-29915ec41004',
  },
  {
    siteId: '3429cedf-06b0-489f-b066-81cada1634fc',
    auditType: 'cwv',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        LCP: 3892,
        FID: 15,
        CLS: 0.27,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/c37892f9-1f9c-45d8-8cd1-98a4d5d6ca78.json',
    auditId: 'f19a8348-a864-4f32-b2fc-24a9e477796e',
  },
  {
    siteId: '3429cedf-06b0-489f-b066-81cada1634fc',
    auditType: 'cwv',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        LCP: 3471,
        FID: 64,
        CLS: 0.98,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/e33cc9b6-1e6a-4f57-a676-2c1b54e6af9e.json',
    auditId: '88cf9014-19d8-4ed1-a0ab-7162ac3dc735',
  },
  {
    siteId: '3429cedf-06b0-489f-b066-81cada1634fc',
    auditType: 'cwv',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        LCP: 3889,
        FID: 14,
        CLS: 0.31,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/351b1d0b-9059-4ce5-8cea-695b694d26b1.json',
    auditId: '1653f24e-42a9-4f43-aaed-8940494eeeb2',
  },
  {
    siteId: '3429cedf-06b0-489f-b066-81cada1634fc',
    auditType: 'cwv',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        LCP: 3776,
        FID: 74,
        CLS: 0.55,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/2c3f3b3c-4ec6-4294-ad75-51ef66c3da22.json',
    auditId: '3617955b-b575-4af3-80c9-06dacc2b32d5',
  },
  {
    siteId: '3429cedf-06b0-489f-b066-81cada1634fc',
    auditType: 'cwv',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        LCP: 618,
        FID: 43,
        CLS: 0.07,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/c9f2530c-6ef9-4056-bc93-ecdbf825d50d.json',
    auditId: 'f641393c-9533-4b31-9565-6cf2d6fa7448',
  },
  {
    siteId: '73bd9bba-40bb-4249-bc69-7ea0f130481d',
    auditType: 'lhs-mobile',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        performance: 0.59,
        seo: 0.5,
        accessibility: 0.15,
        'best-practices': 0.94,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/146a1be4-cada-4953-b2e0-675e129e761f.json',
    auditId: '3743317e-d122-430d-ba07-52f3f0e098e0',
  },
  {
    siteId: '73bd9bba-40bb-4249-bc69-7ea0f130481d',
    auditType: 'lhs-mobile',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        performance: 0.51,
        seo: 0.91,
        accessibility: 0.08,
        'best-practices': 0.93,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/e7c6a9c8-8379-4b1a-804d-2db7051383ea.json',
    auditId: 'b4f8ac21-679d-4c5d-a84b-354e29500e7c',
  },
  {
    siteId: '73bd9bba-40bb-4249-bc69-7ea0f130481d',
    auditType: 'lhs-mobile',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        performance: 0.65,
        seo: 0.16,
        accessibility: 0.79,
        'best-practices': 0.84,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/5f47dfbc-64bd-4673-96e4-822f81e046d0.json',
    auditId: 'a3159352-0aa1-440a-8983-52b1d4d1728a',
  },
  {
    siteId: '73bd9bba-40bb-4249-bc69-7ea0f130481d',
    auditType: 'lhs-mobile',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        performance: 0.99,
        seo: 0.31,
        accessibility: 0.07,
        'best-practices': 0.81,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/0a45a27b-2b30-428b-9306-309771a66533.json',
    auditId: '7fae8262-8e15-4776-8f3a-759f94519873',
  },
  {
    siteId: '73bd9bba-40bb-4249-bc69-7ea0f130481d',
    auditType: 'lhs-mobile',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        performance: 0.49,
        seo: 0.43,
        accessibility: 0.41,
        'best-practices': 0.78,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/d69c7946-be1c-48e8-bd08-9b445112289d.json',
    auditId: 'c758d7a1-5c18-4f31-854e-f386527a4c24',
  },
  {
    siteId: '73bd9bba-40bb-4249-bc69-7ea0f130481d',
    auditType: 'cwv',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        LCP: 279,
        FID: 0,
        CLS: 0.18,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/475a14ef-8017-43a1-b633-dce3e9f323c9.json',
    auditId: '5e267293-a534-4b5a-90b0-424281eaa4d1',
  },
  {
    siteId: '73bd9bba-40bb-4249-bc69-7ea0f130481d',
    auditType: 'cwv',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        LCP: 699,
        FID: 96,
        CLS: 0.5,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/2baaa974-990f-4ce9-b941-43f50ca26106.json',
    auditId: 'c3cee208-4d98-4527-8ccd-7b09da29b913',
  },
  {
    siteId: '73bd9bba-40bb-4249-bc69-7ea0f130481d',
    auditType: 'cwv',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        LCP: 2319,
        FID: 57,
        CLS: 0.46,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/5d1c4e35-7165-4751-adb7-0d63b5b4539d.json',
    auditId: 'de9f3e43-3a7f-4863-9ae8-44351d917f72',
  },
  {
    siteId: '73bd9bba-40bb-4249-bc69-7ea0f130481d',
    auditType: 'cwv',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        LCP: 3871,
        FID: 82,
        CLS: 0.29,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/de5150f0-536c-4cc8-aca3-aae14b2f2e3f.json',
    auditId: '9943f084-f1d0-4b5f-a610-a06b2acd8a84',
  },
  {
    siteId: '73bd9bba-40bb-4249-bc69-7ea0f130481d',
    auditType: 'cwv',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        LCP: 1480,
        FID: 46,
        CLS: 0.31,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/56e55cc1-9052-4036-a0e3-3d17c06e76e9.json',
    auditId: '4bc151ce-86bb-4718-a3e0-4270cf14ab31',
  },
  {
    siteId: 'fbb8fcba-e7d3-4ed7-8623-19e88b1f0ed5',
    auditType: 'lhs-mobile',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        performance: 0.25,
        seo: 0.74,
        accessibility: 0.66,
        'best-practices': 0.12,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/349f82bc-03ac-4957-a267-8157e2ffbba7.json',
    auditId: 'ef3e04a5-2b1f-449e-979c-55b33b341b3d',
  },
  {
    siteId: 'fbb8fcba-e7d3-4ed7-8623-19e88b1f0ed5',
    auditType: 'lhs-mobile',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        performance: 0.64,
        seo: 0.47,
        accessibility: 0.44,
        'best-practices': 0.06,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/c62d53b2-b9ac-4636-b1af-f7c4b982d746.json',
    auditId: '3343fd4b-3185-49b4-b6c5-cd75b3a7b342',
  },
  {
    siteId: 'fbb8fcba-e7d3-4ed7-8623-19e88b1f0ed5',
    auditType: 'lhs-mobile',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        performance: 0.93,
        seo: 0.36,
        accessibility: 0.56,
        'best-practices': 0.34,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/af269848-fd03-4fe9-a702-22d38c2efd4b.json',
    auditId: '6c7c0771-2561-44c8-bd58-5a61ab2227cf',
  },
  {
    siteId: 'fbb8fcba-e7d3-4ed7-8623-19e88b1f0ed5',
    auditType: 'lhs-mobile',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        performance: 0.01,
        seo: 0.92,
        accessibility: 0.63,
        'best-practices': 0.55,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/bcd8b08f-35aa-4d5a-aff6-8f184434b8e2.json',
    auditId: 'fde1401c-f2e4-4250-ae41-ca637a2fbcfd',
  },
  {
    siteId: 'fbb8fcba-e7d3-4ed7-8623-19e88b1f0ed5',
    auditType: 'lhs-mobile',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        performance: 0.33,
        seo: 0.8,
        accessibility: 0.96,
        'best-practices': 0.22,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/fc312358-b9b9-4268-911a-c63f709baa3b.json',
    auditId: '4d38967a-85c0-4e89-a20f-4f247b2a1bb8',
  },
  {
    siteId: 'fbb8fcba-e7d3-4ed7-8623-19e88b1f0ed5',
    auditType: 'cwv',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        LCP: 380,
        FID: 67,
        CLS: 0.25,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/0440c39c-f15e-4b71-8a74-60f4ece1478c.json',
    auditId: 'ac445f94-441b-46b4-9ce9-f1cc2e9390ea',
  },
  {
    siteId: 'fbb8fcba-e7d3-4ed7-8623-19e88b1f0ed5',
    auditType: 'cwv',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        LCP: 3996,
        FID: 59,
        CLS: 0.27,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/25c8bc2f-ec0c-432e-87bd-6b608d46bcf4.json',
    auditId: 'f055cd12-0f2b-4043-8f34-bc892c4175a0',
  },
  {
    siteId: 'fbb8fcba-e7d3-4ed7-8623-19e88b1f0ed5',
    auditType: 'cwv',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        LCP: 3317,
        FID: 92,
        CLS: 0.76,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/52c305f5-f943-45a1-87d7-caf396a50c61.json',
    auditId: '6f8d6d0c-7cf5-46cb-90a0-d864362ed5f5',
  },
  {
    siteId: 'fbb8fcba-e7d3-4ed7-8623-19e88b1f0ed5',
    auditType: 'cwv',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        LCP: 729,
        FID: 97,
        CLS: 0.13,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/2045f404-51c5-4f2f-a344-468d6be86f87.json',
    auditId: 'fc688025-4fa9-4a77-b958-8f8b8ecce657',
  },
  {
    siteId: 'fbb8fcba-e7d3-4ed7-8623-19e88b1f0ed5',
    auditType: 'cwv',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        LCP: 496,
        FID: 45,
        CLS: 0.82,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/ec87b5b7-88c1-4f0d-8aff-a7ac33fc7401.json',
    auditId: '90ded6b5-f45b-4ef9-b66b-876f64ecd9cc',
  },
  {
    siteId: 'b197d10e-035e-433b-896f-8e4967c5de6a',
    auditType: 'lhs-mobile',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        performance: 0.12,
        seo: 0.99,
        accessibility: 0.3,
        'best-practices': 0.89,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/6e86047d-d210-44ed-9f62-ab75e6ff3d3a.json',
    auditId: 'f3749899-7fc5-4b05-b467-1e2410471713',
  },
  {
    siteId: 'b197d10e-035e-433b-896f-8e4967c5de6a',
    auditType: 'lhs-mobile',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        performance: 0.27,
        seo: 0.87,
        accessibility: 0.47,
        'best-practices': 0.1,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/6b54f635-5d1a-4f02-a1cb-e3e970444b9e.json',
    auditId: '2320706e-a629-42df-82d2-e032478a999a',
  },
  {
    siteId: 'b197d10e-035e-433b-896f-8e4967c5de6a',
    auditType: 'lhs-mobile',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        performance: 0.33,
        seo: 0.8,
        accessibility: 0.88,
        'best-practices': 0.94,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/5a60159a-3cec-4ef1-8e45-89d558e5f5c5.json',
    auditId: 'ff435772-20e6-47b4-96ae-e37c0016a749',
  },
  {
    siteId: 'b197d10e-035e-433b-896f-8e4967c5de6a',
    auditType: 'lhs-mobile',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        performance: 0.31,
        seo: 0.99,
        accessibility: 0.19,
        'best-practices': 0.82,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/81acc17a-3fb5-4392-870a-1da8d28e2aeb.json',
    auditId: '5e6e5a16-67b9-4e5e-bb6d-e8ae3436a69e',
  },
  {
    siteId: 'b197d10e-035e-433b-896f-8e4967c5de6a',
    auditType: 'lhs-mobile',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        performance: 0.62,
        seo: 0.3,
        accessibility: 0.25,
        'best-practices': 0.44,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/472d9af6-1a0d-45a6-a3ae-ab1f239dae4a.json',
    auditId: '65a6e8ea-7d26-4d9b-80db-b2c2b96bddfb',
  },
  {
    siteId: 'b197d10e-035e-433b-896f-8e4967c5de6a',
    auditType: 'cwv',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        LCP: 2357,
        FID: 5,
        CLS: 0.49,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/2c140c93-cd08-4ded-94e6-d3be6238adb6.json',
    auditId: '32f6355b-d187-4436-bec0-9a5e5ae3ba0c',
  },
  {
    siteId: 'b197d10e-035e-433b-896f-8e4967c5de6a',
    auditType: 'cwv',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        LCP: 1542,
        FID: 96,
        CLS: 0.56,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/911dffec-7318-4665-a8e8-0ae799ca0f9a.json',
    auditId: '0a9c4880-2e91-42ae-ad8b-4bb7df1dba9c',
  },
  {
    siteId: 'b197d10e-035e-433b-896f-8e4967c5de6a',
    auditType: 'cwv',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        LCP: 1996,
        FID: 90,
        CLS: 0.52,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/db57f2b8-4ff6-429c-ad43-4b3360288278.json',
    auditId: 'bcfbdc07-f665-415b-925d-7d30409769ca',
  },
  {
    siteId: 'b197d10e-035e-433b-896f-8e4967c5de6a',
    auditType: 'cwv',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        LCP: 3898,
        FID: 65,
        CLS: 0.54,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/8d783998-f58f-4199-89a1-f6c240318bd3.json',
    auditId: '24bf0a9d-efc3-4585-ad5e-88c4037be72d',
  },
  {
    siteId: 'b197d10e-035e-433b-896f-8e4967c5de6a',
    auditType: 'cwv',
    auditedAt: '2024-12-03T08:00:55.754Z',
    auditResult: {
      scores: {
        LCP: 2464,
        FID: 28,
        CLS: 0.85,
      },
    },
    isLive: true,
    fullAuditRef: 's3://audit-results/2e074190-3e94-4545-b099-b63dcf443565.json',
    auditId: '144d0a42-05cd-4166-a879-cca18dc0b31a',
  },
];

export default audits;
