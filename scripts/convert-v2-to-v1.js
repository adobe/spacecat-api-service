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
import { convertV2ToV1 } from '../src/support/customer-config-mapper.js';

const [customerDir] = process.argv.slice(2);

if (!customerDir) {
  console.error('Usage: node convert-v2-to-v1.js <customer-directory>');
  process.exit(1);
}

const mappingFile = join(customerDir, 'mapping.json');
const mapping = JSON.parse(readFileSync(mappingFile, 'utf-8'));

const { imsOrgId } = mapping;
const v2File = join(customerDir, `${imsOrgId}.json`);

// Check if V2 file exists
try {
  readFileSync(v2File, 'utf-8');
} catch (error) {
  console.error(`Error: V2 file not found: ${imsOrgId}.json`);
  console.error('Run convert-v1-to-v2.js first to generate the V2 config.');
  process.exit(1);
}

const v2Config = JSON.parse(readFileSync(v2File, 'utf-8'));

v2Config.customer.brands.forEach((brand) => {
  if (!brand.v1SiteId) {
    console.error(`Brand ${brand.id} has no v1SiteId, skipping`);
    return;
  }

  const brandV2 = {
    customer: {
      ...v2Config.customer,
      brands: [brand],
    },
  };

  const v1Config = convertV2ToV1(brandV2);
  const outputFile = join(customerDir, `${brand.v1SiteId}.json`);
  writeFileSync(outputFile, JSON.stringify(v1Config, null, 2));
  console.log(`${brand.id} -> ${brand.v1SiteId}.json`);
});

console.log('Done');
