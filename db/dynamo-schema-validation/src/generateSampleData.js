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
const { getRandomInt } = require('./util.js');
const { generateRandomAudit } = require('./auditUtils.js');
const { createTable, deleteTable } = require('./tableOperations.js');

const schema = require('../schema.json');

async function createTablesFromSchema() {
  const creationPromises = schema.DataModel.map(
    (tableDefinition) => createTable(dbClient, tableDefinition),
  );
  await Promise.all(creationPromises);
}

async function deleteExistingTables() {
  const deletionPromises = ['sites', 'audits', 'latest_audits']
    .map((tableName) => deleteTable(dbClient, tableName));
  await Promise.all(deletionPromises);
}

async function generateSiteData(i) {
  const siteId = uuidv4();
  const siteData = {
    TableName: 'sites',
    Item: {
      id: siteId,
      baseURL: `https://example${i}.com`,
      imsOrgId: `${i}-1234@AdobeOrg`,
      GSI1PK: 'ALL_SITES',
    },
  };

  await client.put(siteData);
  return siteId;
}

async function generateAuditData(siteId, maxAudits) {
  let latestAudit;
  const numberOfAudits = getRandomInt(maxAudits + 1); // 0 to maxAudits audits
  const auditPromises = [];

  for (let j = 0; j < numberOfAudits; j += 1) {
    const auditData = generateRandomAudit(siteId);
    if (!latestAudit || new Date(auditData.auditedAt) > new Date(latestAudit.auditedAt)) {
      latestAudit = { ...auditData };
    }

    auditPromises.push(client.put({ TableName: 'audits', Item: auditData }));
  }

  await Promise.all(auditPromises);
  return latestAudit;
}

async function handleLatestAudit(latestAudit) {
  if (latestAudit) {
    let GSI1SK = `${latestAudit.auditType}#`;
    if (latestAudit.auditType === 'lhs') {
      GSI1SK += Object.values(latestAudit.auditResult).map((score) => (parseFloat(score) * 100).toFixed(0)).join('#');
    } else {
      GSI1SK += Object.values(latestAudit.auditResult).join('#');
    }

    // Create a new object with the modifications
    const modifiedAudit = {
      ...latestAudit,
      GSI1PK: 'ALL_LATEST_AUDITS',
      GSI1SK,
    };

    await client.put({ TableName: 'latest_audits', Item: modifiedAudit });
  }
}

async function generateSiteAndAuditData(siteIndex, maxAudits) {
  const siteId = await generateSiteData(siteIndex);
  const latestAudit = await generateAuditData(siteId, maxAudits);
  await handleLatestAudit(latestAudit);
}

async function generateSampleData(numberOfSites = 12, maxAudits = 15) {
  await deleteExistingTables();
  await createTablesFromSchema();

  const sitePromises = [];
  for (let i = 0; i < numberOfSites; i += 1) {
    sitePromises.push(generateSiteAndAuditData(i, maxAudits));
  }

  await Promise.all(sitePromises);
}

generateSampleData(10, 20) // Example usage: Generate 10 sites with up to 20 audits each
  .then(() => console.log('Sample data generation complete.'))
  .catch((error) => console.error('Error generating sample data:', error));
