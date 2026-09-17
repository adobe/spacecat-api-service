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
 * A REAL Sentiment-element bucket captured from production (brand "au", week
 * starting 2026-08-16), shared by the definition and service test suites so the
 * two cannot drift apart (LLMO-7457).
 *
 * `value` (mentions) and `value__prompts` (prompts) are deliberately different,
 * so a test that reads the wrong field cannot pass by coincidence.
 *
 * The Semrush Brand Presence MFE rendered this exact bucket as
 * Negative 1% / 7, Neutral 56% / 571, Positive 43% / 443 — which is what makes
 * SENTIMENT_MENTIONS_PCT below a reproduction of the vendor's own output rather
 * than a number this codebase invented.
 */
export const RAW_SENTIMENT_WEEK = Object.freeze({
  type: 'bar',
  blocks: {
    data: [
      {
        bar: '2026-08-16', legend: 'Negative', value: 7, value__prompts: 7,
      },
      {
        bar: '2026-08-16', legend: 'Neutral', value: 571, value__prompts: 208,
      },
      {
        bar: '2026-08-16', legend: 'Positive', value: 443, value__prompts: 165,
      },
    ],
    line: [{ bar: '2026-08-16', value: 275 }],
  },
});

/** Sum of the three mention counts — the denominator under `metric=mentions`. */
export const SENTIMENT_MENTIONS_TOTAL = 1021;

/** Sum of the three prompt counts — the denominator under the `prompts` default. */
export const SENTIMENT_PROMPTS_TOTAL = 380;

/** Percentages the MFE showed for this bucket; reproduced under `metric=mentions`. */
export const SENTIMENT_MENTIONS_PCT = Object.freeze({ Positive: 43, Neutral: 56, Negative: 1 });

/** Percentages this endpoint has always returned, under the `prompts` default. */
export const SENTIMENT_PROMPTS_PCT = Object.freeze({ Positive: 43, Neutral: 55, Negative: 2 });

/** Per-legend mention counts for the bucket. */
export const SENTIMENT_MENTION_COUNTS = Object.freeze({ positive: 443, neutral: 571, negative: 7 });

/** Per-legend prompt counts for the bucket. */
export const SENTIMENT_PROMPT_COUNTS = Object.freeze({ positive: 165, neutral: 208, negative: 7 });
