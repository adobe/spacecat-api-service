// Import AWS SDK and other necessary modules
const { docClient: client, dbClient } = require('./db.js');
const { v4: uuidv4 } = require('uuid');
const { getRandomInt } = require('./util.js');
const { generateRandomAudit } = require('./auditUtils.js');
const { createTable, deleteTable } = require('./tableOperations.js');

const schema = require('../schema.json');

// Function to create tables from schema
async function createTablesFromSchema() {
    const creationPromises = schema.DataModel.map(tableDefinition => createTable(dbClient, tableDefinition));
    await Promise.all(creationPromises);
}

// Function to delete existing tables
async function deleteExistingTables() {
    const deletionPromises = ['sites', 'audits', 'latest_audits'].map(tableName => deleteTable(dbClient, tableName));
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
        }
    };

    await client.put(siteData);
    return siteId;
}

async function generateAuditData(siteId, maxAudits) {
    let latestAudit;
    const numberOfAudits = getRandomInt(maxAudits + 1); // 0 to maxAudits audits

    for (let j = 0; j < numberOfAudits; j++) {
        const auditData = generateRandomAudit(siteId);
        if (!latestAudit || new Date(auditData.auditedAt) > new Date(latestAudit.auditedAt)) {
            latestAudit = { ...auditData };
        }

        await client.put({ TableName: 'audits', Item: auditData });
    }

    return latestAudit;
}

async function handleLatestAudit(latestAudit) {
    if (latestAudit) {
        let GSI1SK = `${latestAudit.auditType}#`
        if (latestAudit.auditType === 'lhs') {
            GSI1SK += Object.values(latestAudit.auditResult).map(score => (parseFloat(score) * 100).toFixed(0)).join('#');
        } else {
            GSI1SK += Object.values(latestAudit.auditResult).join('#');
        }
        latestAudit.GSI1SK = GSI1SK;

        await client.put({ TableName: 'latest_audits', Item: latestAudit });
    }
}

async function generateSampleData(numberOfSites = 12, maxAudits = 15) {
    await deleteExistingTables();
    await createTablesFromSchema();

    for (let i = 0; i < numberOfSites; i++) {
        const siteId = await generateSiteData(i);
        const latestAudit = await generateAuditData(siteId, maxAudits);
        await handleLatestAudit(latestAudit);
    }
}

generateSampleData(10, 20) // Example usage: Generate 10 sites with up to 20 audits each
    .then(() => console.log('Sample data generation complete.'))
    .catch((error) => console.error('Error generating sample data:', error));
