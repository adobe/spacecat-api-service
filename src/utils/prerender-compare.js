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

import { diffWords } from 'diff';
import { stripTagsToText, extractWordCount } from '@adobe/spacecat-shared-html-analyzer';

/**
 * Pages that retain at least 90% of their original words are considered a match.
 * @type {number}
 */
const PAGE_MATCH_THRESHOLD = 0.90;

/**
 * Fetches the prerendered HTML for a given URL from S3.
 * The S3 key is derived from the URL's hostname and pathname following the same
 * convention used by the prerender audit: `{hostname}{pathname === '/' ? '/index' : pathname}.html`
 *
 * @param {object} s3Client - AWS S3Client instance.
 * @param {Function} GetObjectCommand - AWS GetObjectCommand constructor.
 * @param {string} s3Bucket - Name of the S3 bucket containing prerendered HTML.
 * @param {string} s3Key - S3 key for the object.
 * @returns {Promise<string>} The HTML string from S3.
 */
async function fetchFromS3(s3Client, GetObjectCommand, s3Bucket, s3Key) {
  const response = await s3Client.send(new GetObjectCommand({
    Bucket: s3Bucket,
    Key: s3Key,
  }));
  return response.Body.transformToString();
}

/**
 * Compares the S3-prerendered HTML of a URL with the live Lambda-rendered HTML.
 *
 * Steps:
 *  1. Fetch live HTML via HTTP GET. 403 → FAILURE_BLOCKED. Other errors → FAILURE_CONTENT.
 *  2. Fetch S3-prerendered HTML. Errors → FAILURE_CONTENT.
 *  3. Extract plain text from both using @adobe/spacecat-shared-html-analyzer.
 *  4. Run Myers word-level diff (jsdiff diffWords).
 *  5. Compute counts and match percentage.
 *  6. pageStatus = diffMatchPct >= 90% → SUCCESS, otherwise FAILURE_CONTENT.
 *
 * @param {string} url - The page URL to compare.
 * @param {object} s3Client - AWS S3Client instance.
 * @param {Function} GetObjectCommand - AWS GetObjectCommand constructor.
 * @param {string} s3Bucket - S3 bucket name containing prerendered HTML.
 * @param {object} log - Logger instance.
 * @returns {Promise<object>} Comparison result object.
 */
export async function comparePage(url, s3Client, GetObjectCommand, s3Bucket, log) {
  const result = {
    url,
    s3Error: null,
    lambdaError: null,
  };

  // Step 1 — fetch live (Lambda-rendered) HTML
  let lambdaHtml;
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'SpaceCat-PrerenderValidator/1.0' },
    });
    if (response.status === 403) {
      result.pageStatus = 'FAILURE_BLOCKED';
      result.lambdaError = '403 Forbidden';
      result.s3WordCount = 0;
      result.lambdaWordCount = 0;
      result.wordCountDiff = 0;
      result.wordCountPctDiff = 0;
      result.diffAddCount = 0;
      result.diffDelCount = 0;
      result.diffSameCount = 0;
      result.diffMatchPct = 0;
      return result;
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    lambdaHtml = await response.text();
  } catch (e) {
    log.error(`comparePage: lambda fetch failed for ${url}: ${e.message}`);
    result.lambdaError = e.message;
    result.pageStatus = 'FAILURE_CONTENT';
    result.s3WordCount = 0;
    result.lambdaWordCount = 0;
    result.wordCountDiff = 0;
    result.wordCountPctDiff = 0;
    result.diffAddCount = 0;
    result.diffDelCount = 0;
    result.diffSameCount = 0;
    result.diffMatchPct = 0;
    return result;
  }

  // Step 2 — fetch S3-prerendered HTML
  const { hostname, pathname } = new URL(url);
  const s3Key = `${hostname}${pathname === '/' ? '/index' : pathname}.html`;
  let s3Html;
  try {
    s3Html = await fetchFromS3(s3Client, GetObjectCommand, s3Bucket, s3Key);
  } catch (e) {
    log.error(`comparePage: S3 fetch failed for key ${s3Key}: ${e.message}`);
    result.s3Error = e.message;
    result.pageStatus = 'FAILURE_CONTENT';
    result.s3WordCount = 0;
    result.lambdaWordCount = 0;
    result.wordCountDiff = 0;
    result.wordCountPctDiff = 0;
    result.diffAddCount = 0;
    result.diffDelCount = 0;
    result.diffSameCount = 0;
    result.diffMatchPct = 0;
    return result;
  }

  // Step 3 — extract plain text from both HTMLs
  const [s3Text, lambdaText, s3WordCountResult, lambdaWordCountResult] = await Promise.all([
    Promise.resolve(stripTagsToText(s3Html)),
    Promise.resolve(stripTagsToText(lambdaHtml)),
    Promise.resolve(extractWordCount(s3Html)).then((r) => r.word_count),
    Promise.resolve(extractWordCount(lambdaHtml)).then((r) => r.word_count),
  ]);

  const s3WordCount = s3WordCountResult;
  const lambdaWordCount = lambdaWordCountResult;

  // Step 4 — Myers word-level diff
  const diffs = diffWords(s3Text, lambdaText);
  const diffSameCount = diffs
    .filter((d) => !d.added && !d.removed)
    .reduce((n, d) => n + d.count, 0);
  const diffDelCount = diffs
    .filter((d) => d.removed)
    .reduce((n, d) => n + d.count, 0);
  const diffAddCount = diffs
    .filter((d) => d.added)
    .reduce((n, d) => n + d.count, 0);

  // Step 5 — compute match percentage (100 when both same and del are 0)
  const diffMatchPct = (diffSameCount + diffDelCount) > 0
    ? (diffSameCount / (diffSameCount + diffDelCount)) * 100
    : 100;

  const wordCountDiff = lambdaWordCount - s3WordCount;
  const wordCountPctDiff = s3WordCount > 0 ? Math.abs(wordCountDiff) / s3WordCount : 0;

  // Step 6 — determine page status
  result.pageStatus = diffMatchPct / 100 >= PAGE_MATCH_THRESHOLD ? 'SUCCESS' : 'FAILURE_CONTENT';
  result.s3WordCount = s3WordCount;
  result.lambdaWordCount = lambdaWordCount;
  result.wordCountDiff = wordCountDiff;
  result.wordCountPctDiff = wordCountPctDiff;
  result.diffAddCount = diffAddCount;
  result.diffDelCount = diffDelCount;
  result.diffSameCount = diffSameCount;
  result.diffMatchPct = Math.round(diffMatchPct * 100) / 100;

  return result;
}
