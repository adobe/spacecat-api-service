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

import { expect } from 'chai';

import {
  ORG_1_ID,
  BRAND_1_ID,
  BP_PROMPT_1_ID,
  BP_TOPIC_1_NAME,
  BP_PROMPT_1_INTENT,
} from '../seed-ids.js';

/**
 * Shared brand-presence topic-prompts endpoint tests.
 *
 *   GET /org/:spaceCatId/brands/:brandId/brand-presence/topics/:topicId/prompts
 *
 * Covers the per-prompt `userIntent` enrichment: the executions source carries
 * only a `prompt_id`, and the handler looks up `intent` from the `prompts`
 * table (bounded to the returned page) and maps it onto each item. The seeded
 * data (seed-data/prompts.js + seed-data/brand-presence-executions.js) provides
 * one execution under BP_TOPIC_1_NAME referencing a prompt whose intent is
 * BP_PROMPT_1_INTENT, so we can assert the enriched value end-to-end.
 *
 * @param {() => object} getHttpClient - Getter returning the initialized HTTP client
 * @param {() => Promise<void>} resetData - Truncates all data and re-seeds baseline
 */
export default function brandPresenceTopicPromptsTests(getHttpClient, resetData) {
  describe('Brand Presence — topic-prompts intent enrichment', () => {
    before(() => resetData());

    const topicPromptsPath = (query) => {
      const qs = new URLSearchParams(query).toString();
      const topic = encodeURIComponent(BP_TOPIC_1_NAME);
      return `/org/${ORG_1_ID}/brands/${BRAND_1_ID}/brand-presence/topics/${topic}/prompts?${qs}`;
    };

    it('enriches each prompt with userIntent looked up from the prompts table', async () => {
      const http = getHttpClient();
      // Explicit date window around the seeded execution_date (2026-06-15) so the
      // assertion does not depend on the current date / default 28-day range.
      const res = await http.admin.get(topicPromptsPath({
        startDate: '2026-06-01',
        endDate: '2026-06-30',
      }));

      // Env-independent guard (mirrors llmo-url-inspector): pin the contract on
      // the 200 case; other branches only assert the endpoint is reachable.
      //   - 200 with the seeded prompt + enriched userIntent   (happy path)
      //   - 401/403 if the auth chain does not grant LLMO       (env-dependent)
      //   - 503 if PostgREST is not configured                 (LOCAL_DEV off)
      expect(res.status).to.be.oneOf([200, 401, 403, 503]);
      if (res.status !== 200) {
        return;
      }

      expect(res.body).to.be.an('object');
      expect(res.body).to.have.property('topic', BP_TOPIC_1_NAME);
      expect(res.body).to.have.property('totalCount', 1);
      expect(res.body).to.have.property('items').that.is.an('array').with.lengthOf(1);

      const [item] = res.body.items;
      expect(item).to.have.property('promptId', BP_PROMPT_1_ID);
      expect(item).to.have.property('prompt', 'best pdf editor for mac');
      // The behaviour under test: userIntent enriched from prompts.intent,
      // joined on prompt_id after pagination.
      expect(item).to.have.property('userIntent', BP_PROMPT_1_INTENT);
    });
  });
}
