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
 * DTO for the Brand Claims response feed.
 *
 * Shapes the joined `(answer + its cited sources)` records into the API contract. The
 * upstream Semrush element rows are never exposed: `execution_id` (an opaque composite of
 * the join tuple), `model_name_cbf_value`, and the raw `tags` blob all stay server-side.
 */

/**
 * Maps one joined source row to its API form.
 *
 * ⚠️ `position` is the element's AGGREGATE ranking for that domain, NOT the position the
 * citation occupied inline in the answer text. The array is ordered by it because that
 * yields a stable, sensible sequence — but this is explicitly NOT a claim about inline
 * citation order, which Semrush does not expose today. Consumers must not present it as
 * "the order the model cited these".
 *
 * @param {object} source - Joined source row.
 * @returns {object} API representation.
 */
const toSourceJSON = (source) => ({
  url: source.url ?? '',
  domain: source.source ?? '',
  rank: source.position ?? 0,
  domainType: source.domainType ?? '',
});

export const ResponseFeedDto = {
  /**
   * Maps one joined record to its API form.
   *
   * `model` and `date` are exposed EXPLICITLY and are not optional. The downstream Brand
   * Claims consumer keys its own identity on `(prompt, region)` — it carries no model and
   * no date dimension — so it cannot reconstruct either from anything else in the payload.
   * Dropping them here would silently collapse distinct executions into one.
   *
   * @param {object} record - Record from `joinResponsesToSources`.
   * @returns {object} camelCase API representation.
   */
  toJSON: (record) => ({
    projectId: record.projectId ?? '',
    prompt: record.prompt ?? '',
    // Load-bearing for the consumer — see above.
    model: record.model ?? '',
    date: record.date ?? '',
    response: record.response ?? '',
    // Empty when that execution cited nothing. ABSENCE IS MEANINGFUL: an empty array means
    // "this model cited no sources on this day", never "sources were lost".
    sources: (record.sources ?? []).map(toSourceJSON),
    sourceCount: record.sourceRowCount ?? 0,
  }),

  /**
   * Wraps the feed in its response envelope.
   *
   * `truncated` and `unmatchedSourceKeyCount` exist so a consumer can tell an incomplete
   * read from a genuinely quiet day — the distinction the whole feed depends on, since a
   * missing tuple is normally legitimate (a model runs on a median 61 of 74 days).
   *
   * @param {object} feed - Result from `getResponseFeed`.
   * @returns {object} API response body.
   */
  toEnvelopeJSON: (feed) => ({
    records: (feed.records ?? []).map(ResponseFeedDto.toJSON),
    totalCount: (feed.records ?? []).length,
    days: feed.days ?? [],
    projectIds: feed.projectIds ?? [],
    pageSize: feed.pageSize ?? 0,
    // True when at least one upstream page came back full, so this window may be clipped.
    // A consumer seeing this should narrow the range rather than treat the result as whole.
    truncated: feed.truncated ?? false,
    // Source rows whose answer was not in the same page. Normally 0; a persistently high
    // value means the two elements disagreed and the join is losing citations.
    unmatchedSourceKeyCount: feed.unmatchedSourceKeyCount ?? 0,
  }),
};
