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
  PromptsByTopicFTSExportRequestSchema,
  PromptsByTopicFTSRequestSchema,
} from '@quazar/ai-seo-ts/v2/prompt/messages_pb.js';
import { PROMPTS_BY_TOPIC_FTS_REQUEST_ORDER_BY_ENUM } from '@quazar/ai-seo-ts/v2/prompt/enums_pb.js';
import { runFtsResearchExport } from './fts-research-export.js';

// Mirrors `PROMPTS_SORT_BY` in handlers/topics.js (the list endpoint).
const SORT_BY = {
  PROMPT: PROMPTS_BY_TOPIC_FTS_REQUEST_ORDER_BY_ENUM.PROMPT,
  MENTIONED_BRANDS_COUNT: PROMPTS_BY_TOPIC_FTS_REQUEST_ORDER_BY_ENUM.MENTIONED_BRANDS_COUNT,
  SOURCES_COUNT: PROMPTS_BY_TOPIC_FTS_REQUEST_ORDER_BY_ENUM.SOURCES_COUNT,
  RELEVANCE_SCORE: PROMPTS_BY_TOPIC_FTS_REQUEST_ORDER_BY_ENUM.RELEVANCE_SCORE,
};

/**
 * CSV export for the Prompt Research "Prompts" tab.
 * Mirrors `GET /topics/research/prompts` (`handleTopicsResearchPrompts`).
 */
export async function handlePromptsResearchExport(sp, clients) {
  return runFtsResearchExport(sp, clients, {
    requestSchema: PromptsByTopicFTSRequestSchema,
    exportSchema: PromptsByTopicFTSExportRequestSchema,
    sortMap: SORT_BY,
    defaultSortKey: 'MENTIONED_BRANDS_COUNT',
    callExport: (clients_, req) => clients_.promptClient.promptsByTopicFTSExport(req),
    label: 'prompts research',
  });
}
