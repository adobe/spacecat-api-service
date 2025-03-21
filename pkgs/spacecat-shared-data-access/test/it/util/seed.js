/*
 * Copyright 2024 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { idNameToEntityName } from '../../../src/util/util.js';
import fixtures from '../../fixtures/index.fixtures.js';

import { getDataAccess, getDynamoClients, TEST_DA_CONFIG } from './db.js';
import { createTablesFromSchema, deleteExistingTables } from './tableOperations.js';

const resetDatabase = async () => {
  const { dbClient } = getDynamoClients();
  await deleteExistingTables(dbClient, [
    TEST_DA_CONFIG.tableNameApiKeys,
    TEST_DA_CONFIG.tableNameAudits,
    TEST_DA_CONFIG.tableNameConfigurations,
    TEST_DA_CONFIG.tableNameData,
    TEST_DA_CONFIG.tableNameExperiments,
    TEST_DA_CONFIG.tableNameImportJobs,
    TEST_DA_CONFIG.tableNameImportUrls,
    TEST_DA_CONFIG.tableNameKeyEvents,
    TEST_DA_CONFIG.tableNameLatestAudits,
    TEST_DA_CONFIG.tableNameOrganizations,
    TEST_DA_CONFIG.tableNameRoles,
    TEST_DA_CONFIG.tableNameSiteCandidates,
    TEST_DA_CONFIG.tableNameSiteTopPages,
    TEST_DA_CONFIG.tableNameSites,
  ]);
  await createTablesFromSchema(dbClient);
};

const seedV2Fixtures = async () => {
  // ACLs needed for seeding
  const acls = [{
    acl: [{
      actions: ['C', 'R'],
      path: '/apiKey/*',
    }, {
      actions: ['C', 'R'],
      path: '/configuration/*',
    }, {
      actions: ['C'],
      path: '/importJob/**',
    }, {
      actions: ['C', 'R'],
      path: '/site/**',
    }, {
      actions: ['C', 'R', 'U'],
      path: '/opportunity/**',
    }, {
      actions: ['C', 'R'],
      path: '/organization/**',
    }, {
      actions: ['C'],
      path: '/role/**',
    }, {
      actions: ['C', 'R'],
      path: '/latestAudit/*',
    },
    ],
  }];

  const aclCtx = { acls };
  const dataAccess = getDataAccess({ aclCtx });
  const sampleData = {};

  for (const [key, data] of Object.entries(fixtures)) {
    console.log(`Seeding ${key}...`);

    if (!Array.isArray(data) || data.length === 0) {
      console.log(`No data to seed for ${key}.`);
      // eslint-disable-next-line no-continue
      continue;
    }

    const modelName = idNameToEntityName(key);
    const Model = dataAccess[modelName];

    if (!Model) {
      throw new Error(`Model not found for ${modelName}`);
    }

    // eslint-disable-next-line no-await-in-loop
    const result = await Model.createMany(data);
    sampleData[key] = result.createdItems;

    if (result.errorItems.length > 0) {
      throw new Error(`Error seeding ${key}: ${JSON.stringify(result.errorItems, null, 2)}`);
    }

    console.log(`Successfully seeded ${key}.`);
  }

  return sampleData;
};

export const seedDatabase = async () => {
  await resetDatabase();
  return seedV2Fixtures();
};
