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
  BrandsByTopicFTSExportRequestSchema,
  BrandsByTopicFTSRequestSchema,
} from '@quazar/ai-seo-ts/v2/brand/messages_pb.js';
import { BRANDS_BY_TOPIC_FTS_REQUEST_ORDER_BY_ENUM } from '@quazar/ai-seo-ts/v2/brand/enums_pb.js';
import { runFtsResearchExport } from './fts-research-export.js';

// Mirrors `BRANDS_SORT_BY` in handlers/topics.js (the list endpoint).
const SORT_BY = {
  NAME: BRANDS_BY_TOPIC_FTS_REQUEST_ORDER_BY_ENUM.NAME,
  MENTIONS: BRANDS_BY_TOPIC_FTS_REQUEST_ORDER_BY_ENUM.MENTIONS,
  SOURCES_COUNT: BRANDS_BY_TOPIC_FTS_REQUEST_ORDER_BY_ENUM.SOURCES_COUNT,
};

/**
 * CSV export for the Prompt Research "Brands" tab.
 * Mirrors `GET /topics/research/brands` (`handleTopicsResearchBrands`).
 */
export async function handleBrandsResearchExport(sp, clients) {
  return runFtsResearchExport(sp, clients, {
    requestSchema: BrandsByTopicFTSRequestSchema,
    exportSchema: BrandsByTopicFTSExportRequestSchema,
    sortMap: SORT_BY,
    defaultSortKey: 'MENTIONS',
    callExport: (clients_, req) => clients_.brandClient.brandsByTopicFTSExport(req),
    label: 'brands research',
  });
}
