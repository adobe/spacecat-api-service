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
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Inspect XLSX file structure and display comprehensive information
 */
function inspectBrandPresenceFile(filePath) {
  console.log('???????????????????????????????????????????????????????????????');
  console.log(`?? Inspecting: ${filePath}`);
  console.log('???????????????????????????????????????????????????????????????\n');

  // Read the file
  const fileBuffer = readFileSync(filePath);
  const workbook = XLSX.read(fileBuffer, { type: 'buffer' });

  // Display sheet names
  console.log('?? Sheet Names:');
  workbook.SheetNames.forEach((name, idx) => {
    console.log(`  ${idx + 1}. ${name}`);
  });
  console.log();

  // Process each sheet
  workbook.SheetNames.forEach((sheetName) => {
    console.log(`\n${'?'.repeat(65)}`);
    console.log(`?? Sheet: "${sheetName}"`);
    console.log('?'.repeat(65));

    const worksheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(worksheet, { defval: null });

    console.log('\n?? Statistics:');
    console.log(`  Total Rows: ${data.length}`);
    console.log(`  Total Columns: ${data.length > 0 ? Object.keys(data[0]).length : 0}`);

    if (data.length === 0) {
      console.log('\n??  Sheet is empty!');
      return;
    }

    // Display column information
    console.log('\n?? Columns:');
    const columns = Object.keys(data[0]);
    columns.forEach((col, idx) => {
      // Analyze data types in this column
      const types = new Set();
      const samples = [];
      let nullCount = 0;

      data.slice(0, 100).forEach((row) => {
        const value = row[col];
        if (value === null || value === undefined) {
          // eslint-disable-next-line no-plusplus
          nullCount++;
        } else {
          types.add(typeof value);
          if (samples.length < 3 && value !== null) {
            samples.push(value);
          }
        }
      });

      const typeStr = Array.from(types).join(', ') || 'null';
      const hasNulls = nullCount > 0 ? ` (${nullCount} nulls in first 100)` : '';

      console.log(`  ${idx + 1}. "${col}"`);
      console.log(`     Type(s): ${typeStr}${hasNulls}`);
      if (samples.length > 0) {
        console.log(`     Samples: ${samples.map((s) => JSON.stringify(s)).join(', ')}`);
      }
    });

    // Display first 10 rows
    console.log('\n?? First 10 Rows:');
    console.log('?'.repeat(65));

    const previewRows = data.slice(0, 10);
    previewRows.forEach((row, idx) => {
      console.log(`\n  Row ${idx + 1}:`);
      Object.entries(row).forEach(([key, value]) => {
        const displayValue = value === null || value === undefined
          ? '<null>'
          : JSON.stringify(value);
        console.log(`    ${key}: ${displayValue}`);
      });
    });

    // Unique value analysis for small columns
    console.log('\n?? Unique Value Analysis (for columns with < 20 unique values):');
    columns.forEach((col) => {
      const uniqueValues = new Set();
      data.forEach((row) => {
        const value = row[col];
        if (value !== null && value !== undefined) {
          uniqueValues.add(value);
        }
      });

      if (uniqueValues.size < 20 && uniqueValues.size > 0) {
        const values = Array.from(uniqueValues).slice(0, 20);
        console.log(`\n  "${col}" (${uniqueValues.size} unique values):`);
        console.log(`    ${values.map((v) => JSON.stringify(v)).join(', ')}`);
      }
    });
  });

  console.log('\n???????????????????????????????????????????????????????????????');
  console.log('? Inspection Complete');
  console.log('???????????????????????????????????????????????????????????????\n');
}

// Main execution
const defaultFile = resolve(process.cwd(), 'data/w48/brandpresence-ai_mode-w48-2025-271125.xlsx');
const filePath = process.argv[2] || defaultFile;

try {
  inspectBrandPresenceFile(filePath);
} catch (error) {
  console.error('? Error inspecting file:', error.message);
  console.error('\nUsage: node scripts/inspect-brand-presence.js [path-to-xlsx-file]');
  console.error(`Default: ${defaultFile}`);
  process.exit(1);
}
