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

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync,
} from 'fs';
import { join, basename, dirname } from 'path';
import { AuroraClient } from '../src/support/aurora-client.js';

const SITE_ID = 'c2473d89-e997-458d-a86d-b4096649c12b';
const BATCH_SIZE = 100; // Insert rows in batches for better performance
const FETCH_BATCH_SIZE = 1000; // Fetch records in batches due to Lambda limits
const FETCH_TIMEOUT_MS = 120000; // 2 minute timeout per request
const MAX_PAGINATION_ITERATIONS = 100; // Safety limit to prevent infinite loops

// Base URL for the CDN
const BASE_URL = 'https://main--project-elmo-ui-data--adobe.aem.live';
const QUERY_INDEX_URL = `${BASE_URL}/adobe/query-index.json`;

// Authentication token - replace with actual token
const AUTH_TOKEN = 'hlxtst_eyJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJwcm9qZWN0LWVsbW8tdWktZGF0YS0tYWRvYmUuYWVtLnBhZ2UiLCJzdWIiOiJoamVuQGFkb2JlLmNvbSIsImV4cCI6MTc2NTI5MjA3Nn0.dgpkKCRH_xxRpjkGqKn7sY3R_jxaaPWVzFw_wg0OiPRWYMD7j3orDO_D9Vg06M_uw8oX1DtHjajtSNAVpvLRh5Snzow2ZY7SORRhEgF_PeuQP4t_plLEngcJ5dWiqfiJEtVl3Bq_Pw1ASIyydEGQhQVxegfWbJRDCEcphtmu2hwd1GCuz_nN9WbTGE0mSUaOXgfckp-8XCeP4bqZq8-wSMXE3vYJ07-4sUrbBMng3N7muFzMZ6W0_xFBLGpuDxt8XFZSIAA9wU1HohFnZIAIHHaiB0mE1-TbspPUChBSYzyYXOnL_bGjCsM9n3C0AhXUdJj6X-QVP983UcTuxBHT4w';

// Week filters - only process entries containing these paths
const WEEK_FILTERS = [
  'adobe/brand-presence/w49/',
  'adobe/brand-presence/w48/',
  'adobe/brand-presence/w47/',
  'adobe/brand-presence/w46/',
  'adobe/brand-presence/w45/',
  'adobe/brand-presence/w44/',
  'adobe/brand-presence/w43/',
  'adobe/brand-presence/w42/',
];

// Local data directory
const DATA_DIR = join(process.cwd(), 'data');
const SYNC_CONTROL_FILE = join(DATA_DIR, 'brand-presence-sync.json');

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
 * Load the sync control file that tracks lastModified times
 */
function loadSyncControl() {
  if (existsSync(SYNC_CONTROL_FILE)) {
    try {
      return JSON.parse(readFileSync(SYNC_CONTROL_FILE, 'utf-8'));
    } catch {
      log('⚠️  Could not parse sync control file, starting fresh');
    }
  }
  return { files: {} };
}

/**
 * Save the sync control file
 */
function saveSyncControl(syncControl) {
  writeFileSync(SYNC_CONTROL_FILE, JSON.stringify(syncControl, null, 2));
}

/**
 * Get local file path for a CDN path
 * e.g., /adobe/brand-presence/w49/file.json -> data/w49/file.json
 */
function getLocalFilePath(cdnPath) {
  // Extract week folder and filename from path like /adobe/brand-presence/w49/file.json
  const match = cdnPath.match(/\/adobe\/brand-presence\/(w\d+)\/(.+\.json)$/);
  if (!match) {
    throw new Error(`Could not parse CDN path: ${cdnPath}`);
  }
  const [, weekFolder, filename] = match;
  return join(DATA_DIR, weekFolder, filename);
}

/**
 * Ensure directory exists
 */
function ensureDir(filePath) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Parse and validate execution date
 * Returns the execution date if valid, otherwise falls back to the file date
 * Handles Excel serial date numbers by falling back to file date
 */
function parseExecutionDate(value, fallbackDate) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  // If it's a number or looks like just a number, it's likely an Excel serial date - use fallback
  if (typeof value === 'number' || /^\d+$/.test(String(value).trim())) {
    return fallbackDate;
  }

  // Check if it looks like a valid date string (contains letters, dashes, or slashes)
  const strValue = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(strValue) || /^\d{2}\/\d{2}\/\d{4}/.test(strValue) || /[a-zA-Z]/.test(strValue)) {
    // Try to parse it to validate
    const parsed = new Date(strValue);
    if (!Number.isNaN(parsed.getTime())) {
      // Return in ISO format for PostgreSQL
      return parsed.toISOString().split('T')[0];
    }
  }

  // If we can't parse it, use fallback
  return fallbackDate;
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
 * Fetch JSON from URL with authentication and timeout
 */
async function fetchWithAuth(url) {
  const headers = {
    Accept: 'application/json',
  };

  // Add auth token if provided
  if (AUTH_TOKEN && AUTH_TOKEN !== 'YOUR_AUTH_TOKEN_HERE') {
    headers.Authorization = `token ${AUTH_TOKEN}`;
  }

  // Create abort controller for timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText} for ${url}`);
    }

    return response.json();
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Request timeout after ${FETCH_TIMEOUT_MS / 1000}s for ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Fetch a brand presence file with pagination
 * Fetches in batches of FETCH_BATCH_SIZE due to Lambda limits
 * Returns combined data from all batches
 */
async function fetchFileWithPagination(baseUrl) {
  let offset = 0;
  let total = null;
  let combinedData = null;
  let iterations = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    iterations += 1;

    // Safety check to prevent infinite loops
    if (iterations > MAX_PAGINATION_ITERATIONS) {
      logError(`     ⚠️  Reached max pagination iterations (${MAX_PAGINATION_ITERATIONS}), stopping`);
      break;
    }

    const url = `${baseUrl}?offset=${offset}&limit=${FETCH_BATCH_SIZE}`;
    log(`     Fetching offset=${offset}, limit=${FETCH_BATCH_SIZE}...`);

    // eslint-disable-next-line no-await-in-loop
    const response = await fetchWithAuth(url);

    // On first fetch, initialize the combined data structure
    if (combinedData === null) {
      combinedData = response;
      // Get total from the 'all' section if it exists
      if (response.all && typeof response.all.total === 'number') {
        total = response.all.total;
        log(`     Total records to fetch: ${total}`);
      }
    } else if (response.all && Array.isArray(response.all.data)) {
      // Append data from subsequent fetches to the 'all.data' array
      combinedData.all.data.push(...response.all.data);
    }

    // Check if we've fetched all records
    const fetchedCount = response.all?.data?.length || 0;
    offset += fetchedCount;

    // Stop if we got fewer records than requested (end of data)
    // or if we've reached the total
    // or if we got zero records (prevent infinite loop)
    const reachedEnd = fetchedCount === 0 || fetchedCount < FETCH_BATCH_SIZE;
    const reachedTotal = total !== null && offset >= total;
    if (reachedEnd || reachedTotal) {
      break;
    }
  }

  // Update the metadata to reflect combined data
  if (combinedData?.all) {
    combinedData.all.offset = 0;
    combinedData.all.limit = combinedData.all.data.length;
  }

  const totalFetched = combinedData?.all?.data?.length || 0;
  log(`     Fetched ${totalFetched} total records${total ? ` (of ${total})` : ''}`);

  return combinedData;
}

/**
 * Get list of brand presence files to process from query index
 */
async function getFilesToProcess() {
  log('📋 Fetching query index...');
  const queryIndex = await fetchWithAuth(QUERY_INDEX_URL);

  if (!queryIndex.data || !Array.isArray(queryIndex.data)) {
    throw new Error('Invalid query index format: missing data array');
  }

  // Filter entries to only include brand presence files from specified weeks
  // Note: brandpresence-all-* files contain OpenAI data (not aggregated data)
  const filteredEntries = queryIndex.data.filter((entry) => {
    const { path } = entry;
    return WEEK_FILTERS.some((filter) => path.includes(filter));
  });

  log(`✅ Found ${filteredEntries.length} files in query index\n`);
  return filteredEntries;
}

/**
 * Sync files from CDN to local data folder
 * Only downloads files that have been modified since last sync
 */
async function syncFilesFromCDN() {
  log('╔═══════════════════════════════════════════════════════════╗');
  log('║ Syncing Brand Presence Files from CDN                     ║');
  log('╚═══════════════════════════════════════════════════════════╝\n');

  const syncControl = loadSyncControl();
  const filesToProcess = await getFilesToProcess();

  let downloaded = 0;
  let skipped = 0;
  const errors = [];

  for (const entry of filesToProcess) {
    const { path: cdnPath, lastModified } = entry;
    const localPath = getLocalFilePath(cdnPath);
    const savedLastModified = syncControl.files[cdnPath]?.lastModified;

    // Skip if file hasn't been modified since last sync
    if (savedLastModified && savedLastModified >= lastModified) {
      log(`  ⏭️  Skipping (not modified): ${basename(cdnPath)}`);
      skipped += 1;
      // eslint-disable-next-line no-continue
      continue;
    }

    try {
      log(`  ⬇️  Downloading: ${basename(cdnPath)}`);
      const fileUrl = `${BASE_URL}${cdnPath}`;
      // eslint-disable-next-line no-await-in-loop
      const data = await fetchFileWithPagination(fileUrl);

      // Ensure directory exists and save file
      ensureDir(localPath);
      writeFileSync(localPath, JSON.stringify(data, null, 2));

      // Update sync control and save immediately (allows resuming if interrupted)
      syncControl.files[cdnPath] = {
        lastModified,
        localPath,
        downloadedAt: new Date().toISOString(),
      };
      saveSyncControl(syncControl);

      log(`     ✅ Saved to: ${localPath}`);
      downloaded += 1;
    } catch (error) {
      logError(`     ❌ Error: ${error.message}`);
      errors.push({ file: cdnPath, error: error.message });
    }
  }

  // Save updated sync control
  saveSyncControl(syncControl);

  log('\n📊 Sync Summary:');
  log(`   Downloaded: ${downloaded}`);
  log(`   Skipped (not modified): ${skipped}`);
  if (errors.length > 0) {
    log(`   Errors: ${errors.length}`);
    errors.forEach(({ file, error }) => {
      log(`     - ${file}: ${error}`);
    });
  }
  log('');

  return { downloaded, skipped, errors };
}

/**
 * Find all local JSON files in the data folder for the specified weeks
 */
function findLocalFiles() {
  const files = [];

  for (const weekFilter of WEEK_FILTERS) {
    // Extract week folder from filter (e.g., 'adobe/brand-presence/w49/' -> 'w49')
    const weekMatch = weekFilter.match(/w\d+/);
    if (!weekMatch) {
      // eslint-disable-next-line no-continue
      continue;
    }

    const weekFolder = join(DATA_DIR, weekMatch[0]);
    if (!existsSync(weekFolder)) {
      log(`  ⚠️  Week folder not found: ${weekFolder}`);
      // eslint-disable-next-line no-continue
      continue;
    }

    const items = readdirSync(weekFolder);
    for (const item of items) {
      if (item.endsWith('.json') && item.startsWith('brandpresence-')) {
        files.push(join(weekFolder, item));
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

  // The data should have an "all" object with a "data" array
  if (!data.all || !Array.isArray(data.all.data)) {
    log('     ⚠️  No data found in "all.data" - skipping');
    return [];
  }

  const rows = data.all.data.map((row) => ({
    site_id: SITE_ID,
    date,
    model,
    category: row.Category || null,
    topics: row.Topics || null,
    prompt: row.Prompt || null,
    origin: row.Origin || null,
    volume: row.Volume || null,
    region: row.Region || null,
    url: row.URL || null,
    answer: row.Answer || null,
    sources: row.Sources || null,
    citations: row.Citations !== null && row.Citations !== '' ? row.Citations : null,
    mentions: row.Mentions !== null && row.Mentions !== '' ? row.Mentions : null,
    sentiment: row.Sentiment || null,
    business_competitors: row['Business Competitors'] || null,
    organic_competitors: row['Organic Competitors'] || null,
    content_ai_result: row['Content AI Result'] || null,
    is_answered: row['Is Answered'] !== null && row['Is Answered'] !== '' ? row['Is Answered'] : null,
    source_to_answer: row['Source To Answer'] || null,
    position: row.Position || null,
    visibility_score: row['Visibility Score'] || null,
    detected_brand_mentions: row['Detected Brand Mentions'] || null,
    execution_date: parseExecutionDate(row['Execution Date'], date),
    error_code: row['Error Code'] || null,
  }));

  log(`     Found ${rows.length} rows`);
  return rows;
}

/**
 * Insert rows in batches (allows duplicates)
 */
async function insertBatch(auroraClient, rows) {
  if (rows.length === 0) return;

  // Build a simple INSERT statement (no deduplication, allows duplicates)
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
    INSERT INTO brand_presence (${columns})
    VALUES ${valuesList.join(', ')}
  `;

  await auroraClient.query(sql, params);
}

/**
 * Import data from local files to database
 */
async function importFromLocalFiles() {
  log('╔═══════════════════════════════════════════════════════════╗');
  log('║ Importing Brand Presence Data to Database                 ║');
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
      log('⚠️  No local files to import. Run sync first.');
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

          // log(`     Inserted ${Math.min(i + BATCH_SIZE, rows.length)}/${rows.length} rows`);
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
      FROM brand_presence
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

/**
 * Main function - sync from CDN then import to database
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--sync-only')) {
    // Only sync files from CDN, don't import to database
    await syncFilesFromCDN();
  } else if (args.includes('--import-only')) {
    // Only import from local files, don't sync from CDN
    await importFromLocalFiles();
  } else {
    // Default: sync then import
    await syncFilesFromCDN();
    await importFromLocalFiles();
  }
}

// Run the main function
main();
