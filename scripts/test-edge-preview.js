#!/usr/bin/env node

/* eslint-disable */
/*
 * Copyright 2025 Adobe. All rights reserved.
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
 * Script to test the edge-preview API for all eligible opportunities (summarization, headings, readability)
 * of a given site. Opportunities and suggestions are read via data access (DynamoDB); only the
 * edge-preview endpoint is called via the LLMO API. Reports success when HTML changed, or flags
 * URL + suggestion IDs + X-Invocation-Id when response is non-200 or originalHtml === optimizedHtml.
 *
 * Usage: node scripts/test-edge-preview.js <siteId>
 *
 * Environment:
 *   DYNAMO_TABLE_NAME_DATA, S3_CONFIG_BUCKET, AWS_REGION - for data access (see create-generic-autofix-suggestions.js)
 *   LLMO_API_BASE_URL - Base URL for the LLMO API (default: https://llmo.experiencecloud.live/api/v1)
 *   LLMO_EDGE_PREVIEW_API_KEY - x-api-key for edge-preview requests (required)
 */

import { config } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createDataAccess } from '@adobe/spacecat-shared-data-access';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const env = "prod"
config({ path: path.join(__dirname, `../.env-${env}`) });

const ELIGIBLE_OPPORTUNITY_TYPES = ['readability', 'summarization', 'headings', 'faqs'];
const ELIGIBLE_SUGGESTION_STATUSES = ['NEW', 'PENDING_VALIDATION'];
const EDGE_PREVIEW_BATCH_SIZE = 10;

const API_BASE_URL = process.env.LLMO_API_BASE_URL || `https://llmo.experiencecloud.live/api/${env === "prod" ? "v1" : "ci"}`;
const API_KEY = process.env.LLMO_EDGE_PREVIEW_API_KEY;

/**
 * Initialize data access (same pattern as create-generic-autofix-suggestions.js).
 */
async function initializeDataAccess() {
  const region = process.env.AWS_REGION || 'us-east-1';
  const tableName = process.env.DYNAMO_TABLE_NAME_DATA;
  const s3Bucket = process.env.S3_CONFIG_BUCKET;

  if (!tableName) {
    throw new Error('DYNAMO_TABLE_NAME_DATA environment variable is required');
  }

  const dynamoClient = new DynamoDBClient({ region });
  const log = {
    debug: () => {},
    info: () => {},
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  return createDataAccess({
    tableNameData: tableName,
    s3Bucket,
    region,
  }, log, dynamoClient);
}

function getSuggestionUrlFromData(data) {
  if (!data || typeof data !== 'object') return null;
  return data.url || data.pageUrl || data.url_from || data.urlFrom || data.recommendations?.[0]?.pageUrl || null;
}

/**
 * Call edge-preview API only (no other API calls).
 */
async function fetchEdgePreview(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      'x-api-key': API_KEY,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), body };
}

/**
 * Whether a suggestion is eligible for edge-preview: status NEW or PENDING_VALIDATION,
 * data does not have edgeDeployed field, and (for headings) checkType is not "heading-order-invalid".
 */
function isEligibleForEdgePreview(suggestion, type) {
  const status = suggestion.getStatus?.();
  if (!status || !ELIGIBLE_SUGGESTION_STATUSES.includes(status))
    return false;
  const data = suggestion.getData?.();
  if (data?.edgeDeployed)
    return false;
  if (data?.checkType === 'heading-order-invalid' || data?.checkType === 'heading-multiple-h1')
    return false;
  if (type === 'readability' && !data.transformRules)
    return false;
  return true;
}

/**
 * Group suggestion entities by URL. Only suggestions eligible for edge-preview are included
 * (status NEW or PENDING_VALIDATION, no edgeDeployed in data, no checkType "heading-order-invalid"). Suggestions without a URL are skipped.
 * @param {Array<{ getId: () => string, getData: () => object, getStatus: () => string }>} suggestions - Suggestion entities from data access
 * @returns {Map<string, string[]>} url -> suggestion ids
 */
function groupSuggestionIdsByUrl(suggestions, type) {
  const byUrl = new Map();
  for (const s of suggestions) {
    if (!isEligibleForEdgePreview(s, type)) continue;
    const id = s.getId?.();
    if (!id) continue;
    const data = s.getData?.();
    const url = getSuggestionUrlFromData(data);
    if (!url) continue;
    if (!byUrl.has(url)) byUrl.set(url, []);
    byUrl.get(url).push(id);
  }
  return byUrl;
}

async function callEdgePreview(siteId, opportunityId, suggestionIds) {
  const url = `${API_BASE_URL}/sites/${siteId}/opportunities/${opportunityId}/suggestions/edge-preview`;
  return fetchEdgePreview(url, {
    method: 'POST',
    body: JSON.stringify({ suggestionIds }),
  });
}

function hasHtmlDiff(body) {
  const html = body?.html;
  if (!html || typeof html !== 'object') return false;
  const orig = html.originalHtml;
  const opt = html.optimizedHtml;
  if (orig == null || opt == null) return false;
  return String(orig).trim() !== String(opt).trim();
}

/**
 * Extract failure reason from edge-preview response when it returns per-suggestion failures
 * (suggestions[].message, suggestions[].statusCode) and/or metadata.success/failed.
 * Returns null if no structured failure info.
 */
function getApiFailureReason(body) {
  if (!body || typeof body !== 'object') return null;
  const suggestions = body.suggestions;
  if (!Array.isArray(suggestions)) return null;
  const failedItems = suggestions.filter((s) => s && (s.statusCode >= 400 || (s.statusCode !== 200 && s.statusCode !== 207)));
  if (failedItems.length === 0) return null;
  const messages = [...new Set(failedItems.map((s) => s.message).filter(Boolean))];
  if (messages.length === 0) return `API reported ${failedItems.length} suggestion failure(s)`;
  return `API failures: ${messages.join('; ')} (${failedItems.length} suggestion(s))`;
}

/** Split array into chunks of at most `size`. */
function chunk(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function processEdgePreviewResult({ url, suggestionIds, type, opportunityId }, { status, headers, body }, results) {
  const invocationId = headers['x-invocation-id'] || headers['x-request-id'] || '';
  const okStatus = status === 200 || status === 207;
  const diff = okStatus && body ? hasHtmlDiff(body) : false;
  const apiFailureReason = getApiFailureReason(body);

  if (!okStatus && body) {
    const errSnippet = typeof body === 'object' ? JSON.stringify(body).slice(0, 300) : String(body).slice(0, 300);
    console.log(`  [edge-preview debug] Error body snippet: ${errSnippet}${errSnippet.length >= 300 ? '...' : ''}`);
  }
  if (apiFailureReason) {
    console.log(`  [edge-preview debug] API reported suggestion failures: ${apiFailureReason}`);
  }
  console.log(`  [edge-preview debug] ${url} okStatus=${okStatus} hasHtmlDiff=${diff} => ${okStatus && diff ? 'SUCCESS' : 'FLAGGED'}`);

  if (okStatus && diff) {
    results.success.push({ url, opportunityId, type, suggestionIds });
    console.log(`  [${type}] OK ${url} (${suggestionIds.length} suggestion(s))`);
  } else {
    const reason = !okStatus
      ? `HTTP ${status}`
      : (apiFailureReason || 'no difference between originalHtml and optimizedHtml');
    results.failed.push({
      url,
      opportunityId,
      type,
      suggestionIds,
      status,
      invocationId,
      reason,
    });
    console.log(`  [${type}] FLAGGED ${url}`);
    console.log(`    suggestionIds: ${JSON.stringify(suggestionIds)}`);
    console.log(`    X-Invocation-Id: ${invocationId || '(none)'}`);
    if (!okStatus) console.log(`    status: ${status}`);
    console.log(`    reason: ${reason}`);
    if (body?.suggestions?.length) {
      body.suggestions.forEach((s) => {
        if (s?.statusCode >= 400 || (s?.statusCode !== 200 && s?.statusCode !== 207)) {
          console.log(`      [suggestion ${s.uuid}] ${s.statusCode}: ${s.message || '(no message)'}`);
        }
      });
    }
  }
}

async function main() {
  const siteId = process.argv[2];
  if (!siteId) {
    console.error('Usage: node scripts/test-edge-preview.js <siteId>');
    console.error('Set LLMO_EDGE_PREVIEW_API_KEY (and optionally LLMO_API_BASE_URL). Use .env-dev for data access.');
    process.exit(1);
  }
  if (!API_KEY) {
    console.error('LLMO_EDGE_PREVIEW_API_KEY is required.');
    process.exit(1);
  }

  console.log(`Site: ${siteId}`);
  console.log(`Edge-preview API: ${API_BASE_URL}`);
  console.log('Eligible opportunity types:', ELIGIBLE_OPPORTUNITY_TYPES.join(', '));
  console.log('');

  const dataAccessInstance = await initializeDataAccess();
  const { Site, Opportunity } = dataAccessInstance;

  const site = await Site.findById(siteId);
  if (!site) {
    throw new Error(`Site with ID ${siteId} not found`);
  }
  console.log(`Site found: ${site.getBaseURL()}`);

  const allOpportunities = await Opportunity.allBySiteId(siteId);
  const opportunities = allOpportunities.filter((opp) => {
    const type = opp.getType?.();
    return type && ELIGIBLE_OPPORTUNITY_TYPES.includes(type);
  });
  console.log(`Found ${opportunities.length} eligible opportunities.`);

  const results = { success: [], failed: [] };

  for (const opportunity of opportunities) {
    const opportunityId = opportunity.getId();
    const type = opportunity.getType();
    const suggestions = await opportunity.getSuggestions();
    if (suggestions.length === 0) {
      console.log(`  [${type}] ${opportunityId}: no suggestions, skipping.`);
      continue;
    }

    const byUrl = groupSuggestionIdsByUrl(suggestions, type);
    if (byUrl.size === 0) {
      console.log(`  [${type}] ${opportunityId}: no suggestions with URL, skipping.`);
      continue;
    }

    const entries = Array.from(byUrl.entries());
    const batches = chunk(entries, EDGE_PREVIEW_BATCH_SIZE);
    for (const batch of batches) {
      const batchResults = await Promise.all(
        batch.map(([url, suggestionIds]) =>
          callEdgePreview(siteId, opportunityId, suggestionIds).then((res) => ({
            url,
            suggestionIds,
            ...res,
          }))
        )
      );
      for (const { url, suggestionIds, status, headers, body } of batchResults) {
        processEdgePreviewResult(
          { url, suggestionIds, type, opportunityId },
          { status, headers, body },
          results
        );
      }
    }
  }

  console.log('');
  console.log('--- Summary ---');
  console.log(`Success: ${results.success.length}`);
  console.log(`Flagged: ${results.failed.length}`);
  if (results.failed.length > 0) {
    console.log('');
    console.log('Flagged URLs:');
    results.failed.forEach((f) => {
      console.log(`  ${f.url}`);
      console.log(`    opportunityId: ${f.opportunityId} (${f.type})`);
      console.log(`    suggestionIds: ${JSON.stringify(f.suggestionIds)}`);
      console.log(`    X-Invocation-Id: ${f.invocationId || '(none)'}`);
      console.log(`    reason: ${f.reason}`);
    });
    console.log('');
    console.log('--- Problematic (X-Invocation-Id, opportunity type, URL) ---');
    results.failed.forEach((f) => {
      console.log(`${f.invocationId || '(none)'}\t${f.type}\t${f.url}`);
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
