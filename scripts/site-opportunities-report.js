#!/usr/bin/env node
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
 * Site Opportunities Report Script
 *
 * Generates a CSV report for one or more sites showing opportunities and suggestions
 * broken down by opportunity type.
 *
 * Usage:
 *   node scripts/site-opportunities-report.js <siteId> [siteId2 ...]
 *   node scripts/site-opportunities-report.js --file site-ids.txt
 *
 * site-ids.txt: one site ID per line
 *
 * Required environment variables:
 *   POSTGREST_URL      - PostgREST base URL
 *   POSTGREST_API_KEY  - PostgREST writer JWT
 *   AWS_REGION         - AWS region
 *
 * Output:
 *   CSV printed to stdout — redirect to a file:
 *   node scripts/site-opportunities-report.js <siteId> > report.csv
 */

// eslint-disable-next-line import/no-extraneous-dependencies
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'fs';
import { createDataAccess } from '@adobe/spacecat-shared-data-access';

// ── Opportunity types to track as individual boolean+count columns ────────────
// Edit this list to add/remove types you care about.
const TRACKED_TYPES = [
  'cwv',
  'broken-backlinks',
  'alt-text',
  'sitemap',
  'canonical',
  'structured-data',
  'apex',
];

const log = {
  info: (...args) => console.error('[INFO]', ...args), // eslint-disable-line no-console
  warn: (...args) => console.error('[WARN]', ...args), // eslint-disable-line no-console
  error: (...args) => console.error('[ERROR]', ...args), // eslint-disable-line no-console
};

function validateEnv() {
  const required = ['POSTGREST_URL', 'POSTGREST_API_KEY', 'AWS_REGION'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  }
}

function escapeCsv(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function buildCsvRow(values) {
  return values.map(escapeCsv).join(',');
}

async function buildSiteRow(site, dataAccess) {
  const { Opportunity, Suggestion } = dataAccess;
  const siteId = site.getId();
  const baseURL = site.getBaseURL();

  const opportunities = await Opportunity.allBySiteId(siteId);

  // For each opportunity, fetch suggestion count
  const opptyRows = await Promise.all(
    opportunities.map(async (oppty) => {
      const suggestions = await Suggestion.allByOpportunityId(oppty.getId());
      return {
        opportunityId: oppty.getId(),
        type: oppty.getType(),
        status: oppty.getStatus(),
        title: oppty.getTitle() || '',
        suggestionCount: Array.isArray(suggestions)
          ? suggestions.length
          : (suggestions?.records?.length ?? 0),
      };
    }),
  );

  // Aggregate per type
  const byType = {};
  for (const row of opptyRows) {
    if (!byType[row.type]) {
      byType[row.type] = { count: 0, suggestionCount: 0 };
    }
    byType[row.type].count += 1;
    byType[row.type].suggestionCount += row.suggestionCount;
  }

  const totalOpportunities = opptyRows.length;
  const totalSuggestions = opptyRows.reduce((sum, r) => sum + r.suggestionCount, 0);

  // Build tracked type columns: <type> (true/false), <type>_opportunities, <type>_suggestions
  const typeCols = [];
  for (const type of TRACKED_TYPES) {
    const entry = byType[type];
    typeCols.push(entry ? 'true' : 'false'); // has opportunity of this type
    typeCols.push(entry ? entry.count : 0); // opportunity count for type
    typeCols.push(entry ? entry.suggestionCount : 0); // suggestion count for type
  }

  return [siteId, baseURL, totalOpportunities, totalSuggestions, ...typeCols];
}

function buildHeader() {
  const base = ['siteId', 'baseURL', 'totalOpportunities', 'totalSuggestions'];
  const typeCols = TRACKED_TYPES.flatMap((type) => [
    type,
    `${type}_opportunities`,
    `${type}_suggestions`,
  ]);
  return [...base, ...typeCols];
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: node scripts/site-opportunities-report.js <siteId> [siteId2 ...]'); // eslint-disable-line no-console
    console.error('       node scripts/site-opportunities-report.js --file site-ids.txt'); // eslint-disable-line no-console
    process.exit(1);
  }

  validateEnv();

  let siteIds;
  if (args[0] === '--file') {
    if (!args[1]) {
      console.error('--file requires a path argument'); // eslint-disable-line no-console
      process.exit(1);
    }
    siteIds = readFileSync(args[1], 'utf-8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  } else {
    siteIds = args;
  }

  const dataAccess = await createDataAccess(
    {
      postgrestUrl: process.env.POSTGREST_URL,
      postgrestApiKey: process.env.POSTGREST_API_KEY,
      region: process.env.AWS_REGION,
    },
    log,
  );

  const { Site } = dataAccess;
  const header = buildHeader();
  const rows = [buildCsvRow(header)];

  log.info(`Generating report for ${siteIds.length} site(s)...`);

  for (const siteId of siteIds) {
    // eslint-disable-next-line no-await-in-loop
    const site = await Site.findById(siteId);
    if (!site) {
      log.warn(`Site ${siteId} not found, skipping`);
      continue; // eslint-disable-line no-continue
    }
    log.info(`Processing ${site.getBaseURL()} (${siteId})`);
    // eslint-disable-next-line no-await-in-loop
    const row = await buildSiteRow(site, dataAccess);
    rows.push(buildCsvRow(row));
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputFile = `scripts/opportunities-report-${timestamp}.csv`;
  const csv = rows.join('\n');

  writeFileSync(outputFile, csv, 'utf-8');
  log.info(`Report written to ${outputFile}`);
}

main().catch((error) => {
  console.error('Fatal error:', error); // eslint-disable-line no-console
  process.exit(1);
});
