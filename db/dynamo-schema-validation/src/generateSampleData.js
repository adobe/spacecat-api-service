/*
 * Copyright 2023 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */
const { v4: uuidv4 } = require('uuid');
const { docClient: client, dbClient } = require('./db.js');
const { generateRandomAudit } = require('./auditUtils.js');
const { createTable, deleteTable } = require('./tableOperations.js');

const schema = require('../schema.json');

/**
 * Creates all tables defined in a schema.
 *
 * Iterates over a predefined schema object and creates each table using the createTable function.
 * The schema object should define all required attributes and configurations for each table.
 */
async function createTablesFromSchema() {
  const creationPromises = schema.DataModel.map(
    (tableDefinition) => createTable(dbClient, tableDefinition),
  );
  await Promise.all(creationPromises);
}

/**
 * Deletes a predefined set of tables from the database.
 *
 * Iterates over a list of table names and deletes each one using the deleteTable function.
 * This is typically used to clean up the database before creating new tables or
 * generating test data.
 */
async function deleteExistingTables() {
  const deletionPromises = ['sites', 'audits', 'latest_audits']
    .map((tableName) => deleteTable(dbClient, tableName));
  await Promise.all(deletionPromises);
}

/**
 * Performs a batch write operation for a specified table in DynamoDB.
 *
 * @param {string} tableName - The name of the table to perform the batch write operation on.
 * @param {Array<Object>} items - An array of items to be written to the table.
 *
 * @example
 * // Example usage
 * const itemsToWrite = [{ id: '1', data: 'example' }, { id: '2', data: 'sample' }];
 * batchWrite('myTable', itemsToWrite);
 */
async function batchWrite(tableName, items) {
  const batchWriteRequests = [];
  while (items.length) {
    const batch = items.splice(0, 25).map((item) => ({
      PutRequest: { Item: item },
    }));

    batchWriteRequests.push(client.batchWrite({
      RequestItems: { [tableName]: batch },
    }));
  }

  await Promise.all(batchWriteRequests);
}

/**
 * Generates audit data for a specific site.
 *
 * @param {string} siteId - The ID of the site for which to generate audit data.
 * @param {Array<string>} auditTypes - An array of audit types to generate data for.
 * @param {number} numberOfAuditsPerType - The number of audits to generate for each type.
 * @returns {Object} An object containing arrays of audit data and latest audit data for the site.
 *
 * @example
 * // Example usage
 * const audits = generateAuditData('site123', ['lhs', 'cwv'], 5);
 */
function generateAuditData(siteId, auditTypes, numberOfAuditsPerType) {
  const latestAudits = {};
  const auditData = [];

  for (const type of auditTypes) {
    for (let j = 0; j < numberOfAuditsPerType; j += 1) {
      const audit = generateRandomAudit(siteId, type);
      auditData.push(audit);

      // Update latest audit for each type
      if (!latestAudits[type]
        || new Date(audit.auditedAt) > new Date(latestAudits[type].auditedAt)) {
        latestAudits[type] = audit;
      }
    }
  }

  const latestAuditData = Object.values(latestAudits).map((audit) => {
    // Modify the audit data for the latest_audits table
    let GSI1SK = `${audit.auditType}#`;
    if (audit.auditType === 'lhs') {
      GSI1SK += Object.values(audit.auditResult).map((score) => (parseFloat(score) * 100).toFixed(0)).join('#');
    } else {
      GSI1SK += Object.values(audit.auditResult).join('#');
    }

    return {
      ...audit,
      GSI1PK: 'ALL_LATEST_AUDITS',
      GSI1SK,
    };
  });

  return { auditData, latestAuditData };
}

/**
 * Generates sample data for testing purposes.
 *
 * @param {number} [numberOfSites=10] - The number of sites to generate.
 * @param {number} [numberOfAuditsPerType=5] - The number of audits per type to generate
 * for each site.
 *
 * @example
 * // Example usage
 * generateSampleData(20, 10); // Generates 20 sites with 10 audits per type for each site
 */
async function generateSampleData(numberOfSites = 10, numberOfAuditsPerType = 5) {
  console.time('Sample data generated in');
  await deleteExistingTables();
  await createTablesFromSchema();

  const auditTypes = ['lhs', 'cwv'];
  const sites = [];
  const auditItems = [];
  const latestAuditItems = [];

  // Generate site data
  for (let i = 0; i < numberOfSites; i += 1) {
    const siteId = uuidv4();
    sites.push({
      id: siteId,
      baseURL: `https://example${i}.com`,
      imsOrgId: `${i}-1234@AdobeOrg`,
      GSI1PK: 'ALL_SITES',
    });

    if (i % 10 !== 0) { // Every tenth site will not have any audits
      const latestAudits = generateAuditData(siteId, auditTypes, numberOfAuditsPerType);
      auditItems.push(...latestAudits.auditData);
      latestAuditItems.push(...latestAudits.latestAuditData);
    }
  }

  await batchWrite('sites', sites);
  await batchWrite('audits', auditItems);
  await batchWrite('latest_audits', latestAuditItems);

  console.timeEnd('Sample data generated in');
}

generateSampleData(100, 5)
  .then(() => console.log('Sample data generation complete.'))
  .catch((error) => console.error('Error generating sample data:', error));
