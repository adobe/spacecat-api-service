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

import XLSX from 'xlsx';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import { AuroraClient } from '../src/support/aurora-client.js';

const SITE_ID = 'c2473d89-e997-458d-a86d-b4096649c12b';
const BATCH_SIZE = 100; // Insert rows in batches for better performance

/**
 * Convert Excel date serial number to ISO date string
 */
function excelDateToISO(excelDate) {
  if (!excelDate || typeof excelDate === 'string') {
    return excelDate; // Already a string date or null
  }

  // Excel dates are days since 1900-01-01 (with a bug for 1900 being a leap year)
  const excelEpoch = new Date(1899, 11, 30); // Dec 30, 1899
  const days = Math.floor(excelDate);
  const date = new Date(excelEpoch.getTime() + days * 24 * 60 * 60 * 1000);

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

/**
 * Parse filename to extract model and date
 * Format: brandpresence-{model}-w{week}-{date}.xlsx
 * Example: brandpresence-ai-mode-w48-2025-271125.xlsx
 * Returns: { model: 'ai-mode', date: '2025-11-27' }
 */
function parseFilename(filename) {
  // const parts = basename(filename, '.xlsx').split('-');

  // Find the date part (DDMMYY format at the end)
  const dateMatch = filename.match(/(\d{6})\.xlsx$/);
  if (!dateMatch) {
    throw new Error(`Could not parse date from filename: ${filename}`);
  }

  const dateStr = dateMatch[1]; // DDMMYY
  const day = dateStr.substring(0, 2);
  const month = dateStr.substring(2, 4);
  const year = `20${dateStr.substring(4, 6)}`;
  const date = `${year}-${month}-${day}`;

  // Extract model: everything between 'brandpresence-' and '-w{week}'
  const modelMatch = filename.match(/brandpresence-(.+?)-w\d+/);
  if (!modelMatch) {
    throw new Error(`Could not parse model from filename: ${filename}`);
  }

  const model = modelMatch[1];

  return { model, date };
}

/**
 * Find all XLSX files in a directory
 */
function findXlsxFiles(dir) {
  const files = [];
  const items = readdirSync(dir);

  for (const item of items) {
    const fullPath = join(dir, item);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      files.push(...findXlsxFiles(fullPath));
    } else if (item.endsWith('.xlsx') && item.startsWith('brandpresence-') && !item.startsWith('brandpresence-all-')) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Process a single XLSX file and return rows ready for insertion
 */
function processFile(filePath) {
  const { model, date } = parseFilename(basename(filePath));
  console.log(`  ?? Processing: ${basename(filePath)}`);
  console.log(`     Model: ${model}, Date: ${date}`);

  const fileBuffer = readFileSync(filePath);
  const workbook = XLSX.read(fileBuffer, { type: 'buffer' });

  const allRows = [];

  // Process each sheet
  for (const sheetName of workbook.SheetNames) {
    // Only process the "shared-all" sheet, skip other sheets
    if (sheetName !== 'shared-all') {
      console.log(`     Skipping sheet: ${sheetName}`);
      // eslint-disable-next-line no-continue
      continue;
    }

    const worksheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(worksheet, { defval: null });

    console.log(`     Sheet: ${sheetName} (${data.length} rows)`);

    // Convert sheet data to database rows
    for (const row of data) {
      allRows.push({
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
        citations: row.Citations !== null ? row.Citations : null,
        mentions: row.Mentions !== null ? row.Mentions : null,
        sentiment: row.Sentiment || null,
        business_competitors: row['Business Competitors'] || null,
        organic_competitors: row['Organic Competitors'] || null,
        content_ai_result: row['Content AI Result'] || null,
        is_answered: row['Is Answered'] !== null ? row['Is Answered'] : null,
        source_to_answer: row['Source To Answer'] || null,
        position: row.Position || null,
        visibility_score: row['Visibility Score'] || null,
        detected_brand_mentions: row['Detected Brand Mentions'] || null,
        execution_date: excelDateToISO(row['Execution Date']),
        error_code: row['Error Code'] || null,
      });
    }
  }

  return allRows;
}

/**
 * Insert rows in batches
 */
async function insertBatch(auroraClient, rows) {
  if (rows.length === 0) return;

  // Deduplicate rows within the batch based on unique constraint
  const seen = new Set();
  const uniqueRows = [];

  for (const row of rows) {
    const key = `${row.site_id}|${row.date}|${row.model}|${row.category}|${row.prompt}|${row.region}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueRows.push(row);
    }
  }

  if (uniqueRows.length === 0) return;

  // Build the INSERT statement with ON CONFLICT
  const columns = Object.keys(uniqueRows[0]).join(', ');
  const valuesList = [];
  const params = [];
  let currentParamIndex = 1;

  for (const row of uniqueRows) {
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
    ON CONFLICT (site_id, date, model, category, prompt, region)
    DO UPDATE SET
      topics = EXCLUDED.topics,
      origin = EXCLUDED.origin,
      volume = EXCLUDED.volume,
      url = EXCLUDED.url,
      answer = EXCLUDED.answer,
      sources = EXCLUDED.sources,
      citations = EXCLUDED.citations,
      mentions = EXCLUDED.mentions,
      sentiment = EXCLUDED.sentiment,
      business_competitors = EXCLUDED.business_competitors,
      organic_competitors = EXCLUDED.organic_competitors,
      content_ai_result = EXCLUDED.content_ai_result,
      is_answered = EXCLUDED.is_answered,
      source_to_answer = EXCLUDED.source_to_answer,
      position = EXCLUDED.position,
      visibility_score = EXCLUDED.visibility_score,
      detected_brand_mentions = EXCLUDED.detected_brand_mentions,
      execution_date = EXCLUDED.execution_date,
      error_code = EXCLUDED.error_code,
      updated_at = CURRENT_TIMESTAMP
  `;

  await auroraClient.query(sql, params);
}

/**
 * Main import function
 */
async function importBrandPresence() {
  console.log('???????????????????????????????????????????????????????????????');
  console.log('?? Brand Presence Data Import');
  console.log('???????????????????????????????????????????????????????????????\n');

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
    console.log('?? Testing database connection...');
    const connected = await auroraClient.testConnection();
    if (!connected) {
      throw new Error('Failed to connect to database');
    }
    console.log('? Connected to database\n');

    // Find all XLSX files
    console.log('?? Scanning for XLSX files...');
    const dataDir = join(process.cwd(), 'data');
    const files = findXlsxFiles(dataDir);
    console.log(`? Found ${files.length} files\n`);

    if (files.length === 0) {
      console.log('??  No files to import');
      return;
    }

    // Process each file
    let totalRows = 0;
    let processedFiles = 0;
    const errors = [];

    for (const filePath of files) {
      try {
        const rows = processFile(filePath);

        // Insert in batches
        for (let i = 0; i < rows.length; i += BATCH_SIZE) {
          const batch = rows.slice(i, i + BATCH_SIZE);
          // eslint-disable-next-line no-await-in-loop
          await insertBatch(auroraClient, batch);

          process.stdout.write(`     Inserted ${Math.min(i + BATCH_SIZE, rows.length)}/${rows.length} rows\r`);
        }

        console.log(`     ? Inserted ${rows.length} rows\n`);
        totalRows += rows.length;
        // eslint-disable-next-line no-plusplus
        processedFiles++;
      } catch (error) {
        console.error(`     ? Error processing file: ${error.message}\n`);
        errors.push({ file: basename(filePath), error: error.message });
      }
    }

    // Summary
    console.log('\n???????????????????????????????????????????????????????????????');
    console.log('?? Import Summary');
    console.log('???????????????????????????????????????????????????????????????');
    console.log(`? Files processed: ${processedFiles}/${files.length}`);
    console.log(`? Total rows imported: ${totalRows.toLocaleString()}`);

    if (errors.length > 0) {
      console.log(`\n??  Errors encountered: ${errors.length}`);
      errors.forEach(({ file, error }) => {
        console.log(`   - ${file}: ${error}`);
      });
    }

    // Verify import
    console.log('\n?? Verifying import...');
    const counts = await auroraClient.query(`
      SELECT 
        model,
        date,
        COUNT(*) as row_count
      FROM brand_presence
      GROUP BY model, date
      ORDER BY date DESC, model
    `);

    console.log('\n?? Data in database:');
    counts.forEach((row) => {
      console.log(`   ${row.date} | ${row.model}: ${row.row_count} rows`);
    });

    console.log('\n???????????????????????????????????????????????????????????????');
    console.log('? Import Complete!');
    console.log('???????????????????????????????????????????????????????????????\n');
  } catch (error) {
    console.error('\n? Fatal error during import:', error.message);
    console.error(error);
    process.exit(1);
  } finally {
    await auroraClient.close();
  }
}

// Run the import
importBrandPresence();
