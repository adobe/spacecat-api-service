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
 * Composite keys are built with `JSON.stringify` over the component array rather than by
 * joining on a separator.
 *
 * A separator — ANY separator, including a control character such as U+001F — is forgeable:
 * `(project 'p', prompt 'a<SEP>b', model 'm')` and `(project 'p', prompt 'a', model 'b<SEP>m')`
 * join to the identical string, so two distinct executions would share one key. `prompt` is
 * free text supplied by the customer, so this is a data-dependent correctness bug rather than
 * a theoretical one. JSON escaping removes the ambiguity: quotes and control characters inside
 * a component are escaped, so no component can forge a boundary.
 */
function compositeKey(parts) {
  return JSON.stringify(parts);
}

/**
 * Builds the dateless identity `(project_id, prompt, model)` used by both
 * {@link joinKey} and {@link diffDayExecutions}, so the two cannot drift apart if the key
 * tuple ever changes.
 *
 * @param {object} row - A normalised response or source row.
 * @returns {string} Dateless composite key.
 */
function identityKey(row) {
  return compositeKey([row.projectId ?? '', row.prompt ?? '', row.model ?? '']);
}

/**
 * Builds the full composite join key `(project_id, prompt, model, date)`.
 *
 * This exact tuple is the join contract, and its soundness rests on a MEASURED invariant:
 * at most ONE execution exists per `(project_id, prompt, model, date)`. Verified directly
 * against element 404fb017, which carries both `execution_id` and `date`: across 2,553
 * tuples every one mapped to exactly one `execution_id`, with zero violations (2026-09-04).
 * A model may contribute ZERO on a given day, but never two.
 *
 * ⚠️ This invariant is measured, not contractual — Semrush has not confirmed it as a
 * guarantee. If it were ever violated, the symptom would be an answer carrying a merged
 * source list from two executions rather than an error. {@link joinResponsesToSources}
 * therefore records `sourceRowCount` so a caller can spot an implausible fan-out.
 *
 * Both sides must express `date` as a bare `YYYY-MM-DD`: the source transform truncates the
 * element's full timestamp, and the answer side supplies the requested day.
 *
 * @param {object} row - A normalised response or source row.
 * @param {string} [date] - Date component; taken from `row.date` when omitted (source rows
 *   carry it, response rows do not — see the module docs).
 * @returns {string} Composite key.
 */
function joinKey(row, date) {
  // Derived from the same components as the dateless identity so the two cannot drift.
  return compositeKey([
    row.projectId ?? '',
    row.prompt ?? '',
    row.model ?? '',
    date ?? row.date ?? '',
  ]);
}

/**
 * Groups normalised source rows by their `(project_id, prompt, model, date)` key, with each
 * group ordered by the element's `position` column.
 *
 * ⚠️ `position` is an AGGREGATE ranking on element 404fb017, NOT the true inline citation
 * order within the answer text. Ordering by it produces a stable, sensible sequence, but it
 * is NOT a claim that this is the order the sources appeared in the response. Recovering
 * true inline order is a known nice-to-have gap on the Semrush side, not something this
 * function can or does establish.
 *
 * @param {Array<object>} sourceRows - Rows from `transformResponseSourcesResponse`.
 * @returns {Map<string, Array<object>>} Key → position-ordered source rows.
 */
function groupSourcesByKey(sourceRows) {
  const byKey = new Map();
  for (const row of sourceRows) {
    const key = joinKey(row);
    const existing = byKey.get(key);
    if (existing) {
      existing.push(row);
    } else {
      byKey.set(key, [row]);
    }
  }
  for (const rows of byKey.values()) {
    // Stable sort by aggregate position — see the ordering caveat above.
    rows.sort((a, b) => a.position - b.position);
  }
  return byKey;
}

/**
 * Joins answer rows (element 141adc88, which has the text but NO date) to their citation
 * rows (element 404fb017, which has the date and URLs but NO text), producing one record per
 * answer carrying its own ordered source list.
 *
 * The join key is `(project_id, prompt, model, date)`. Because the answer element carries no
 * date, the date is supplied by the caller — it is the `endDate` the response page was
 * fetched with, i.e. the day whose executions those answers belong to. Callers recovering a
 * single day should pass the same `date` they passed to
 * {@link module:response-feed.diffDayExecutions}.
 *
 * ABSENCE IS MEANINGFUL. An answer with no matching source rows is returned with an EMPTY
 * `sources` array, not dropped: a missing tuple means that model did not cite anything (or
 * did not run) that day, NOT that data was lost. Consumers must tolerate these gaps rather
 * than treat them as an error. Symmetrically, source rows with no matching answer are
 * reported via `unmatchedSourceKeys` instead of being silently discarded, so a caller can
 * tell "no citations" apart from "the two pages disagreed".
 *
 * Pure function — no I/O, no clock, no network.
 *
 * @param {Array<object>} responseRows - Rows from `transformPromptResponsesResponse`.
 * @param {Array<object>} sourceRows - Rows from `transformResponseSourcesResponse`.
 * @param {object} [opts]
 * @param {string} [opts.date] - ISO date (YYYY-MM-DD) the answer rows belong to. Required
 *   for any row to match, since answer rows carry no date of their own.
 * @returns {{records: Array<object>, unmatchedSourceKeys: Array<string>}}
 */
export function joinResponsesToSources(responseRows, sourceRows, { date } = {}) {
  const responses = Array.isArray(responseRows) ? responseRows : [];
  const sources = Array.isArray(sourceRows) ? sourceRows : [];
  const sourcesByKey = groupSourcesByKey(sources);
  const matchedKeys = new Set();

  const records = responses.map((row) => {
    const key = joinKey(row, date);
    const matched = sourcesByKey.get(key) ?? [];
    if (matched.length > 0) {
      matchedKeys.add(key);
    }
    return {
      projectId: row.projectId,
      prompt: row.prompt,
      model: row.model,
      // Carried from the requested window, not from the answer row — see above.
      date: date ?? '',
      response: row.response,
      tags: row.tags,
      // Ordered by aggregate `position`, which is NOT true inline citation order.
      sources: matched.map((s) => ({
        url: s.url,
        source: s.source,
        position: s.position,
        domainType: s.domainType,
      })),
      // Lets a caller detect an implausible fan-out if the one-execution-per-tuple
      // invariant were ever violated upstream.
      sourceRowCount: matched.length,
    };
  });

  const unmatchedSourceKeys = [...sourcesByKey.keys()].filter((k) => !matchedKeys.has(k));
  return { records, unmatchedSourceKeys };
}

/**
 * Recovers the executions belonging to a SINGLE day D as an exact set difference:
 *
 *   executions(D) = responses(end = D) MINUS responses(end = D-1)
 *
 * This is necessary because the element ignores `CBF_date__start` and honours
 * `CBF_date__end` as an upper bound over a ROLLING window (~74 days measured 2026-09-04), so
 * a single day cannot be requested directly — see {@link module:prompt-responses}. Two calls
 * are therefore the documented cost of ONE isolated day. Consecutive days share a boundary,
 * so a caller recovering a RANGE should fetch each boundary once and reuse it for the two
 * days it borders: N days cost N+1 pulls, not 2N.
 *
 * Rows are identified by `(project_id, prompt, model)`, and the difference is a MULTISET
 * (count-based) difference, NOT a distinct-set difference. This is load-bearing.
 *
 * Element 141adc88 carries NO date column and returns one row PER EXECUTION, so a single page
 * holds the whole rolling window: measured live, a 400-row page contained just 10 distinct
 * `(prompt, model)` pairs, one of them repeated 54 times (~54 days of history). A prompt that
 * runs daily therefore already appears in the D-1 page, so a distinct-set difference filters
 * its day-D row out and returns NOTHING. Verified against two live adjacent-day captures:
 * a set difference yielded 0 rows both times where the multiset difference yielded 4 and 5.
 * Returning [] would be indistinguishable from "nothing ran", which is precisely the
 * data-loss outcome the absence-is-meaningful rule forbids.
 *
 * ⚠️ Because the window ROLLS rather than accumulating, rows can also DROP OUT of the older
 * end as `end` advances. Such a row is present in the D-1 page and absent from the D page;
 * it is correctly NOT reported as new (it is not an execution on day D). This is why the
 * difference is computed one-way — `rowsEndD` minus `rowsEndDminus1` — and never as a
 * symmetric difference, which would misreport those expiries as day-D activity.
 *
 * Pure function — no I/O, no clock, no network.
 *
 * @param {Array<object>} rowsEndD - Normalised rows fetched with `endDate = D`.
 * @param {Array<object>} rowsEndDminus1 - Normalised rows fetched with `endDate = D-1`.
 * @returns {Array<object>} The subset of `rowsEndD` that is new on day D.
 */
export function diffDayExecutions(rowsEndD, rowsEndDminus1) {
  const current = Array.isArray(rowsEndD) ? rowsEndD : [];
  const previous = Array.isArray(rowsEndDminus1) ? rowsEndDminus1 : [];
  // Date is constant across a single call pair, so compare on the other three components.
  const identity = identityKey;
  // Multiset difference: consume one prior occurrence per matching row. A distinct Set here
  // would return [] for any prompt that also ran earlier in the rolling window (see above).
  const remaining = new Map();
  previous.forEach((row) => {
    const key = identity(row);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  });
  return current.filter((row) => {
    const key = identity(row);
    const count = remaining.get(key) ?? 0;
    if (count > 0) {
      remaining.set(key, count - 1);
      return false;
    }
    return true;
  });
}
