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
  SourceDomainsByTopicFTSExportRequestSchema,
  SourceDomainsByTopicFTSRequestSchema,
} from '@quazar/ai-seo-ts/v2/source/messages_pb.js';
import { SOURCE_DOMAINS_BY_TOPIC_FTS_REQUEST_ORDER_BY_ENUM } from '@quazar/ai-seo-ts/v2/source/enums_pb.js';
import { runFtsResearchExport } from './fts-research-export.js';

// Mirrors `SOURCE_DOMAINS_SORT_BY` in handlers/topics.js (the list endpoint).
const SORT_BY = {
  DOMAIN: SOURCE_DOMAINS_BY_TOPIC_FTS_REQUEST_ORDER_BY_ENUM.DOMAIN,
  SOURCES_COUNT: SOURCE_DOMAINS_BY_TOPIC_FTS_REQUEST_ORDER_BY_ENUM.SOURCES_COUNT,
  MENTIONS: SOURCE_DOMAINS_BY_TOPIC_FTS_REQUEST_ORDER_BY_ENUM.MENTIONS,
  ORGANIC_TRAFFIC: SOURCE_DOMAINS_BY_TOPIC_FTS_REQUEST_ORDER_BY_ENUM.ORGANIC_TRAFFIC,
};

/**
 * CSV export for the Prompt Research "Source Domains" tab.
 * Mirrors `GET /topics/research/source-domains` (`handleTopicsResearchSourceDomains`).
 */
/* c8 ignore start */
export async function handleSourceDomainsResearchExport(sp, clients) {
  return runFtsResearchExport(sp, clients, {
    requestSchema: SourceDomainsByTopicFTSRequestSchema,
    exportSchema: SourceDomainsByTopicFTSExportRequestSchema,
    sortMap: SORT_BY,
    defaultSortKey: 'MENTIONS',
    callExport: (clients_, req) => clients_.sourceClient.sourceDomainsByTopicFTSExport(req),
    label: 'source domains research',
  });
}
/* c8 ignore stop */
