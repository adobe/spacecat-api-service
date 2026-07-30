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

/**
 * Data Insights per-TOPIC aggregation.
 *
 * The topic table is built from the SAME rich per-prompt element as the drill-down
 * (PROMPTS_BY_TOPIC, 78864493) — fetched with no `CBF_topic` filter (all topics) — then
 * grouped by `prompt_topic` here. This mirrors what the live Brand Presence MFE does
 * (verified 2026-07-21) and deliberately does NOT fan out to the wiki's separate
 * per-topic elements (0564b061/141adc88/324c9c6a): 141adc88 currently 500s, 0564b061
 * lacks position, and 324c9c6a only exposes sentiment counts (not the mean the table
 * wants). Every metric the table needs is derivable from this one element.
 *
 * Aggregation rules (OURS — Semrush returns raw per-prompt rows):
 *  - promptCount        = number of prompts in the topic (sampled set the element returns).
 *  - brandMentions      = Σ mentions; brandCitations = Σ citations; volume = Σ volume.
 *  - averageVisibilityScore = mean visibility over ALL prompts (an unanswered prompt has a
 *    real 0 visibility, so it counts in the denominator).
 *  - averagePosition / averageSentiment = mean over prompts that HAVE a value — the
 *    per-prompt transform already normalized the element's `position: -1` sentinel and a
 *    missing sentiment to `null`, and a non-answer must not be averaged as 0. `null` when
 *    the topic has no ranked / no sentiment-bearing prompt.
 *  - prompts = the topic's own per-prompt rows (sorted by volume desc), embedded so the
 *    eager Data Insights table renders rows + drill-down from a single call. (The paginated
 *    per-topic endpoint — getTopicPrompts — serves lazy consumers of the same rows.)
 */

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Groups clean per-prompt rows (as returned by transformTopicPromptsResponse) into
 * per-topic aggregate rows, sorted by total search volume descending (most prominent
 * topics first).
 *
 * @param {Array<object>} promptRows - Clean per-prompt rows: each has topic, mentions,
 *   citations, visibility, volume, and nullable position/sentiment.
 * @returns {Array<object>} One aggregate row per topic.
 */
export function aggregateTopicsFromPrompts(promptRows) {
  const rows = Array.isArray(promptRows) ? promptRows : [];
  const byTopic = new Map();

  for (const r of rows) {
    const topic = typeof r?.topic === 'string' ? r.topic : '';
    // Skip blank/whitespace-only topics (the drill-down controller rejects an empty
    // topicId; keep the two paths consistent). The key stays the raw topic name so it
    // still matches the drill-down's CBF_topic scoping.
    if (!topic || !topic.trim()) {
      // eslint-disable-next-line no-continue
      continue;
    }
    let agg = byTopic.get(topic);
    if (!agg) {
      agg = {
        topic,
        promptCount: 0,
        brandMentions: 0,
        brandCitations: 0,
        volume: 0,
        visSum: 0,
        posSum: 0,
        posN: 0,
        sentSum: 0,
        sentN: 0,
        prompts: [],
      };
      byTopic.set(topic, agg);
    }
    agg.prompts.push(r);
    agg.promptCount += 1;
    agg.brandMentions += Number(r.mentions) || 0;
    agg.brandCitations += Number(r.citations) || 0;
    agg.volume += Number(r.volume) || 0;
    agg.visSum += Number(r.visibility) || 0;
    if (typeof r.position === 'number' && Number.isFinite(r.position)) {
      agg.posSum += r.position;
      agg.posN += 1;
    }
    if (typeof r.sentiment === 'number' && Number.isFinite(r.sentiment)) {
      agg.sentSum += r.sentiment;
      agg.sentN += 1;
    }
  }

  return [...byTopic.values()]
    .map((a) => ({
      topic: a.topic,
      promptCount: a.promptCount,
      brandMentions: a.brandMentions,
      brandCitations: a.brandCitations,
      volume: a.volume,
      // promptCount is always >= 1 for a grouped topic (an entry is only created when a
      // prompt is pushed), so the division is safe without a guard.
      averageVisibilityScore: round2(a.visSum / a.promptCount),
      averagePosition: a.posN ? round2(a.posSum / a.posN) : null,
      averageSentiment: a.sentN ? round2(a.sentSum / a.sentN) : null,
      prompts: [...a.prompts].sort((p, q) => (Number(q.volume) || 0) - (Number(p.volume) || 0)),
    }))
    .sort((x, y) => y.volume - x.volume);
}
