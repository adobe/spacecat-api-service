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

/* eslint-disable no-console */

import { readFileSync, writeFileSync } from 'fs';

const [inputFile] = process.argv.slice(2);

if (!inputFile) {
  console.error('Usage: node convert-v2-to-csv.js <input.json>');
  process.exit(1);
}

const v2Config = JSON.parse(readFileSync(inputFile, 'utf-8'));
const { customer } = v2Config;

// Build lookup maps
const categoriesMap = new Map();
(customer.categories || []).forEach((cat) => {
  categoriesMap.set(cat.id, cat);
});

const topicsMap = new Map();
(customer.topics || []).forEach((topic) => {
  topicsMap.set(topic.id, topic);
});

const rows = [];
rows.push([
  'brandId',
  'brandName',
  'brandStatus',
  'categoryId',
  'categoryName',
  'topicId',
  'topicName',
  'promptId',
  'prompt',
  'promptStatus',
  'regions',
  'origin',
  'source',
  'updatedAt',
  'updatedBy',
]);

customer.brands.forEach((brand) => {
  brand.prompts.forEach((prompt) => {
    const category = categoriesMap.get(prompt.categoryId);
    const topic = topicsMap.get(prompt.topicId);

    rows.push([
      brand.id,
      brand.name,
      brand.status,
      prompt.categoryId,
      category?.name || '',
      prompt.topicId,
      topic?.name || '',
      prompt.id,
      prompt.prompt,
      prompt.status,
      prompt.regions.join(';'),
      prompt.origin,
      prompt.source,
      prompt.updatedAt,
      prompt.updatedBy,
    ]);
  });
});

const csv = rows.map((row) => row.map((cell) => {
  const str = String(cell || '');
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}).join(',')).join('\n');

const outputFile = inputFile.replace(/\.json$/, '.csv');
writeFileSync(outputFile, csv);
console.log(`Written to ${outputFile}`);
