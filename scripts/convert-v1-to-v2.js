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
import { join } from 'path';
import { convertV1ToV2 } from '../src/support/customer-config-mapper.js';

const [customerDir] = process.argv.slice(2);

if (!customerDir) {
  console.error('Usage: node convert-v1-to-v2.js <customer-directory>');
  process.exit(1);
}

const mappingFile = join(customerDir, 'mapping.json');
const mapping = JSON.parse(readFileSync(mappingFile, 'utf-8'));

const { customerName, imsOrgId, brands } = mapping;

// Process each brand and merge into single V2 config
const allBrands = [];
const allCategories = new Map(); // Dedupe by ID
const allTopics = new Map(); // Dedupe by ID
const cdnConfigsWithUrls = []; // Track CDN config + brand URL

for (const brandConfig of brands) {
  console.log(`Processing brand: ${brandConfig.name}`);
  const v1File = join(customerDir, brandConfig.v1File);

  // Check if file exists
  let v1Config;
  try {
    v1Config = JSON.parse(readFileSync(v1File, 'utf-8'));
  } catch (error) {
    console.error(`  ⚠️  File not found: ${brandConfig.v1File} - skipping`);
    // eslint-disable-next-line no-continue
    continue;
  }

  const v2Config = convertV1ToV2(v1Config, brandConfig.name, imsOrgId);

  const brand = v2Config.customer.brands[0];

  // Add baseUrl from mapping
  if (brandConfig.baseUrl) {
    brand.baseUrl = brandConfig.baseUrl;
  }

  // Add v1SiteId from mapping
  if (brandConfig.v1SiteId) {
    brand.v1SiteId = brandConfig.v1SiteId;
  }

  // Set the top-level url with the first URL from mapping (the main brand URL)
  if (brandConfig.urls && brandConfig.urls.length > 0) {
    brand.url = {
      value: brandConfig.urls[0],
      siteId: brandConfig.v1SiteId,
      type: 'url',
    };
  }

  // Add additional URLs from mapping if provided
  if (brandConfig.urls && brandConfig.urls.length > 0) {
    const existingUrls = new Set(brand.urls.map((u) => u.value));
    brandConfig.urls.forEach((url) => {
      if (!existingUrls.has(url)) {
        brand.urls.push({
          value: url,
          siteId: brandConfig.v1SiteId,
          type: 'url',
        });
      }
    });
  }

  // Merge categories (dedupe by ID)
  v2Config.customer.categories.forEach((cat) => {
    if (!allCategories.has(cat.id)) {
      allCategories.set(cat.id, cat);
    }
  });

  // Merge topics (dedupe by ID)
  v2Config.customer.topics.forEach((topic) => {
    if (!allTopics.has(topic.id)) {
      allTopics.set(topic.id, topic);
    }
  });

  // Collect CDN config (keep all configs, even minimal ones)
  if (v1Config.cdnBucketConfig) {
    cdnConfigsWithUrls.push({
      config: v1Config.cdnBucketConfig,
      brandUrl: brandConfig.baseUrl,
    });
  }

  console.log(`  -> Created ${v2Config.customer.brands.length} brand(s)`);
  allBrands.push(...v2Config.customer.brands);
}

// Deduplicate CDN configs and merge brand URLs
const cdnConfigMap = new Map();
cdnConfigsWithUrls.forEach(({ config, brandUrl }) => {
  const key = JSON.stringify(config);
  if (!cdnConfigMap.has(key)) {
    cdnConfigMap.set(key, {
      config,
      urls: [],
    });
  }
  if (brandUrl && !cdnConfigMap.get(key).urls.includes(brandUrl)) {
    cdnConfigMap.get(key).urls.push(brandUrl);
  }
});

const uniqueCdnConfigs = Array.from(cdnConfigMap.values()).map(({ config, urls }) => ({
  ...config,
  urls,
}));

const finalV2Config = {
  customer: {
    customerName,
    imsOrgId,
    categories: Array.from(allCategories.values()),
    topics: Array.from(allTopics.values()),
    brands: allBrands,
    cdnBucketConfigs: uniqueCdnConfigs,
    availableVerticals: [
      'News & Entertainment',
      'Software & Technology',
      'IT Services',
      'Manufacture',
      'Healthcare',
      'Pharmaceutical',
      'Foods & Nutrition',
      'Transportation',
      'Hospitality',
      'Travel & Tourism',
      'Automotive',
      'Freight & Logistics',
      'Retail',
      'FSI (Financial Services & Insurance)',
    ],
  },
};

const outputFile = join(customerDir, `${imsOrgId}.json`);
writeFileSync(outputFile, JSON.stringify(finalV2Config, null, 2));
console.log(`Written to ${outputFile}`);
