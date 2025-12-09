#!/usr/bin/env node

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

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { AuroraClient } from '../src/support/aurora-client.js';

const SITE_ID = 'c2473d89-e997-458d-a86d-b4096649c12b';
const BATCH_SIZE = 100; // Insert rows in batches for better performance

// Week filters - only process entries containing these paths
const WEEK_FILTERS = [
  'w49',
  'w48',
  'w47',
  'w46',
  'w45',
  'w44',
  'w43',
  'w42',
];

// Local data directory
const DATA_DIR = join(process.cwd(), 'data');

/**
 * Get current timestamp string
 */
function getTimestamp() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

/**
 * Log with timestamp
 */
function log(...args) {
  // eslint-disable-next-line no-console
  console.log(`[${getTimestamp()}]`, ...args);
}

/**
 * Log error with timestamp
 */
function logError(...args) {
  // eslint-disable-next-line no-console
  console.error(`[${getTimestamp()}]`, ...args);
}

/**
 * Parse filename to extract model and date
 * Format: brandpresence-{model}-w{week}-{date}.json
 * Example: brandpresence-ai-mode-w49-2025-011225.json
 * Returns: { model: 'ai-mode', date: '2025-12-01' }
 *
 * Special case: brandpresence-all-* files contain OpenAI data
 * Example: brandpresence-all-w49-011225.json
 * Returns: { model: 'openai', date: '2025-12-01' }
 */
function parseFilename(filename) {
  // Extract just the filename from the path
  const base = basename(filename);

  // Find the date part (DDMMYY format at the end)
  const dateMatch = base.match(/(\d{6})\.json$/);
  if (!dateMatch) {
    throw new Error(`Could not parse date from filename: ${filename}`);
  }

  const dateStr = dateMatch[1]; // DDMMYY
  const day = dateStr.substring(0, 2);
  const month = dateStr.substring(2, 4);
  const year = `20${dateStr.substring(4, 6)}`;
  const date = `${year}-${month}-${day}`;

  // Special case: brandpresence-all-* files contain OpenAI data
  if (base.includes('brandpresence-all-')) {
    return { model: 'openai', date };
  }

  // Extract model: everything between 'brandpresence-' and '-w{week}'
  const modelMatch = base.match(/brandpresence-(.+?)-w\d+/);
  if (!modelMatch) {
    throw new Error(`Could not parse model from filename: ${filename}`);
  }

  const model = modelMatch[1];

  return { model, date };
}

/**
 * Find all local JSON files in the data folder for the specified weeks
 */
function findLocalFiles() {
  const files = [];

  for (const weekFolder of WEEK_FILTERS) {
    const weekPath = join(DATA_DIR, weekFolder);
    if (!existsSync(weekPath)) {
      log(`  ⚠️  Week folder not found: ${weekPath}`);
      // eslint-disable-next-line no-continue
      continue;
    }

    const items = readdirSync(weekPath);
    for (const item of items) {
      if (item.endsWith('.json') && item.startsWith('brandpresence-')) {
        files.push(join(weekPath, item));
      }
    }
  }

  return files;
}

/**
 * Process a single JSON file and return rows ready for insertion
 */
function processFileData(data, filePath) {
  const { model, date } = parseFilename(filePath);
  log(`  📄 Processing: ${basename(filePath)}`);
  log(`     Model: ${model}, Date: ${date}`);

  // The data should have a "brand_vs_competitors" object with a "data" array
  if (!data.brand_vs_competitors || !Array.isArray(data.brand_vs_competitors.data)) {
    log('     ⚠️  No data found in "brand_vs_competitors.data" - skipping');
    return [];
  }

  const rows = data.brand_vs_competitors.data.map((row) => ({
    site_id: SITE_ID,
    date,
    model,
    category: row.Category || null,
    competitor: row.Competitor || null,
    mentions: row.Mentions !== null && row.Mentions !== '' ? parseInt(row.Mentions, 10) || null : null,
    citations: row.Citations !== null && row.Citations !== '' ? parseInt(row.Citations, 10) || null : null,
    sources: row.Sources || null,
    region: row.Region || null,
  }));

  log(`     Found ${rows.length} rows`);
  return rows;
}

/**
 * Insert rows in batches
 */
async function insertBatch(auroraClient, rows) {
  if (rows.length === 0) return;

  // Build a simple INSERT statement
  const columns = Object.keys(rows[0]).join(', ');
  const valuesList = [];
  const params = [];
  let currentParamIndex = 1;

  for (const row of rows) {
    const values = Object.values(row);
    const placeholders = [];
    // eslint-disable-next-line no-restricted-syntax
    for (let i = 0; i < values.length; i += 1) {
      placeholders.push(`$${currentParamIndex}`);
      // eslint-disable-next-line no-plusplus
      currentParamIndex++;
    }
    valuesList.push(`(${placeholders.join(', ')})`);
    params.push(...values);
  }

  const sql = `
    INSERT INTO brand_vs_competitors (${columns})
    VALUES ${valuesList.join(', ')}
  `;

  await auroraClient.query(sql, params);
}

/**
 * Import data from local files to database
 */
async function importBrandVsCompetitors() {
  log('╔═══════════════════════════════════════════════════════════╗');
  log('║ Importing Brand vs Competitors Data to Database           ║');
  log('╚═══════════════════════════════════════════════════════════╝\n');

  const auroraClient = new AuroraClient({
    host: 'localhost',
    port: 5432,
    database: 'spacecatdb',
    user: 'spacecatuser',
    password: 'spacecatpassword',
    ssl: false,
  });

  try {
    // Test connection
    log('🔌 Testing database connection...');
    const connected = await auroraClient.testConnection();
    if (!connected) {
      throw new Error('Failed to connect to database');
    }
    log('✅ Connected to database\n');

    // Find local files
    log('📂 Scanning local data folder...');
    const localFiles = findLocalFiles();
    log(`✅ Found ${localFiles.length} local files\n`);

    if (localFiles.length === 0) {
      log('⚠️  No local files to import.');
      return;
    }

    // Process each file
    let totalRows = 0;
    let processedFiles = 0;
    const errors = [];

    for (const filePath of localFiles) {
      try {
        // Read local file
        const data = JSON.parse(readFileSync(filePath, 'utf-8'));

        // Process the data
        const rows = processFileData(data, filePath);

        if (rows.length === 0) {
          log('     ⏭️  Skipped (no data)\n');
          // eslint-disable-next-line no-continue
          continue;
        }

        // Insert in batches
        for (let i = 0; i < rows.length; i += BATCH_SIZE) {
          const batch = rows.slice(i, i + BATCH_SIZE);
          // eslint-disable-next-line no-await-in-loop
          await insertBatch(auroraClient, batch);
        }

        log(`     ✅ Inserted ${rows.length} rows\n`);
        totalRows += rows.length;
        // eslint-disable-next-line no-plusplus
        processedFiles++;
      } catch (error) {
        logError(`     ❌ Error processing file: ${error.message}\n`);
        errors.push({ file: basename(filePath), error: error.message });
      }
    }

    // Summary
    log('\n╔═══════════════════════════════════════════════════════════╗');
    log('║ Import Summary                                            ║');
    log('╚═══════════════════════════════════════════════════════════╝');
    log(`✅ Files processed: ${processedFiles}/${localFiles.length}`);
    log(`✅ Total rows imported: ${totalRows.toLocaleString()}`);

    if (errors.length > 0) {
      log(`\n⚠️  Errors encountered: ${errors.length}`);
      errors.forEach(({ file, error }) => {
        log(`   - ${file}: ${error}`);
      });
    }

    // Verify import
    log('\n📊 Verifying import...');
    const counts = await auroraClient.query(`
      SELECT
        model,
        date,
        COUNT(*) as row_count
      FROM brand_vs_competitors
      GROUP BY model, date
      ORDER BY date DESC, model
    `);

    log('\n📈 Data in database:');
    counts.forEach((row) => {
      log(`   ${row.date} | ${row.model}: ${row.row_count} rows`);
    });

    log('\n╔═══════════════════════════════════════════════════════════╗');
    log('║ Import Complete!                                          ║');
    log('╚═══════════════════════════════════════════════════════════╝\n');
  } catch (error) {
    logError('\n❌ Fatal error during import:', error.message);
    logError(error);
    process.exit(1);
  } finally {
    await auroraClient.close();
  }
}

// Run the import
importBrandVsCompetitors();
