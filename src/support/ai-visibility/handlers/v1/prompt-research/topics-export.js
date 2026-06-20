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
  TopicsByFTSExportRequestSchema,
  TopicsByFTSRequestSchema,
} from '@quazar/ai-seo-ts/v2/topic/messages_pb.js';
import { TOPICS_BY_FTS_REQUEST_ORDER_BY_ENUM } from '@quazar/ai-seo-ts/v2/topic/enums_pb.js';
import { runFtsResearchExport } from './fts-research-export.js';

// Mirrors `TOPICS_SORT_BY` in handlers/topics.js (the list endpoint).
const SORT_BY = {
  RELEVANCE_SCORE: TOPICS_BY_FTS_REQUEST_ORDER_BY_ENUM.RELEVANCE_SCORE,
  VOLUME: TOPICS_BY_FTS_REQUEST_ORDER_BY_ENUM.VOLUME,
};

/**
 * CSV export for the Prompt Research "Related Topics" tab.
 * Mirrors `GET /topics/research` (`handleTopicsResearch`).
 */
/* c8 ignore start */
export async function handleTopicsResearchExport(sp, clients) {
  return runFtsResearchExport(sp, clients, {
    requestSchema: TopicsByFTSRequestSchema,
    exportSchema: TopicsByFTSExportRequestSchema,
    sortMap: SORT_BY,
    defaultSortKey: 'RELEVANCE_SCORE',
    callExport: (clients_, req) => clients_.topicClient.topicsByFTSExport(req),
    label: 'topics research',
  });
}
/* c8 ignore stop */
