/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import {
  ORG_1_ID,
  SITE_1_ID,
  BRAND_1_ID,
  BP_EXEC_1_ID,
  BP_EXEC_2_ID,
  BP_EXEC_DATE_1,
  BP_EXEC_DATE_2,
} from '../../shared/seed-ids.js';

export const brands = [
  {
    id: BRAND_1_ID,
    site_id: SITE_1_ID,
    name: 'Acme Corp',
    organization_id: ORG_1_ID,
  },
];

export const brandPresenceExecutions = [
  {
    id: BP_EXEC_1_ID,
    site_id: SITE_1_ID,
    execution_date: BP_EXEC_DATE_1,
    model: 'chatgpt-free',
    brand_id: BRAND_1_ID,
    brand_name: 'Acme Corp',
    category_name: 'SEO',
    region_code: 'US',
    organization_id: ORG_1_ID,
    prompt: 'test prompt 1',
    mentions: true,
  },
  {
    id: BP_EXEC_2_ID,
    site_id: SITE_1_ID,
    execution_date: BP_EXEC_DATE_2,
    model: 'chatgpt-free',
    brand_id: BRAND_1_ID,
    brand_name: 'Acme Corp',
    category_name: 'SEO',
    region_code: 'US',
    organization_id: ORG_1_ID,
    prompt: 'test prompt 2',
    mentions: true,
  },
];

export const executionsCompetitorData = [
  // Week 1: two competitors in same category/region
  {
    site_id: SITE_1_ID,
    execution_date: BP_EXEC_DATE_1,
    model: 'chatgpt-free',
    brand_id: BRAND_1_ID,
    brand_name: 'Acme Corp',
    category_name: 'SEO',
    region_code: 'US',
    competitor: 'Rival Inc',
    parent_company: 'Rival Corp',
    mentions: 10,
    citations: 1,
    organization_id: ORG_1_ID,
    execution_id: BP_EXEC_1_ID,
  },
  {
    site_id: SITE_1_ID,
    execution_date: BP_EXEC_DATE_1,
    model: 'chatgpt-free',
    brand_id: BRAND_1_ID,
    brand_name: 'Acme Corp',
    category_name: 'SEO',
    region_code: 'US',
    competitor: 'Other Co',
    mentions: 5,
    citations: 0,
    organization_id: ORG_1_ID,
    execution_id: BP_EXEC_1_ID,
  },
  // Week 1: same competitor in different category (for aggregate test)
  {
    site_id: SITE_1_ID,
    execution_date: BP_EXEC_DATE_1,
    model: 'chatgpt-free',
    brand_id: BRAND_1_ID,
    brand_name: 'Acme Corp',
    category_name: 'PPC',
    region_code: 'US',
    competitor: 'Rival Inc',
    parent_company: 'Rival Corp',
    mentions: 3,
    citations: 1,
    organization_id: ORG_1_ID,
    execution_id: BP_EXEC_1_ID,
  },
  // Week 2: competitor data
  {
    site_id: SITE_1_ID,
    execution_date: BP_EXEC_DATE_2,
    model: 'chatgpt-free',
    brand_id: BRAND_1_ID,
    brand_name: 'Acme Corp',
    category_name: 'SEO',
    region_code: 'US',
    competitor: 'Rival Inc',
    parent_company: 'Rival Corp',
    mentions: 15,
    citations: 2,
    organization_id: ORG_1_ID,
    execution_id: BP_EXEC_2_ID,
  },
];
