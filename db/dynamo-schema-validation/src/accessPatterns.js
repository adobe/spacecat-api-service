const { docClient: client } = require('./db.js');

async function getSiteByBaseURLWithAudits(baseUrl) {
    // Query the 'sites' table GSI using 'baseURL'
    const site = await getSiteByBaseURL(baseUrl);

    if (!site) {
        return null;
    }

    // Query the 'audits' table to get audits for the site
    const auditsData = await client.query({
        TableName: 'audits',
        KeyConditionExpression: 'siteId = :siteId',
        ExpressionAttributeValues: {
            ':siteId': site.id
        }
    });

    // Merge audits with the site data
    site.audits = auditsData.Items;

    return site;
}

async function getSiteByBaseURL(baseUrl) {
    const result = await client.query({
        TableName: 'sites',
        IndexName: 'sites_all', // Replace with your GSI name
        KeyConditionExpression: 'GSI1PK = :gsi1pk AND baseURL = :baseUrl',
        ExpressionAttributeValues: {
            ':gsi1pk': 'ALL_SITES',
            ':baseUrl': baseUrl
        }
    });

    if (result.Items.length === 0) {
        return null;
    }

    return result.Items[0];
}

async function getSitesWithLatestAudit(auditType) {
    // Fetch all sites
    const sites = await getSites();

    // Fetch all latest audits of the specified type
    const auditsResult = await client.query({
        TableName: 'latest_audits',
        IndexName: 'latest_audits_all',
        KeyConditionExpression: 'GSI1PK = :gsi1pk AND begins_with(GSI1SK, :auditType)',
        ExpressionAttributeValues: {
            ':gsi1pk': 'ALL_LATEST_AUDITS',
            ':auditType': `${auditType}#`
        }
    });

    // Create a map of siteId to latest audits for efficient lookup
    const auditMap = auditsResult.Items.reduce((map, audit) => {
        map[audit.siteId] = audit;
        return map;
    }, {});

    // Merge sites with their corresponding latest audits
    return sites.Items.map(site => {
        return {
            ...site,
            latestAudit: auditMap[site.id]
        };
    });
}


async function getSiteByBaseURLWithLatestAudit(baseUrl, auditType) {
    const site = await getSiteByBaseURL(baseUrl);

    if (!site) {
        return null;
    }

    // Query the 'latest_audits' table to get the latest audit for the site
    const latestAuditData = await client.query({
        TableName: 'latest_audits',
        IndexName: 'latest_audit_scores',
        KeyConditionExpression: 'siteId = :siteId AND begins_with(GSI1SK, :auditType)',
        ExpressionAttributeValues: {
            ':siteId': site.id,
            ':auditType': `${auditType}#`
        },
        Limit: 1
    });

    site.latestAudit = latestAuditData.Items.length > 0 ? latestAuditData.Items[0] : null;

    return site;
}

async function getSites() {
    return client.query({
        TableName: 'sites',
        IndexName: 'sites_all', // GSI name
        KeyConditionExpression: 'GSI1PK = :gsi1pk',
        ExpressionAttributeValues: {
            ':gsi1pk': 'ALL_SITES'
        }
    });
}

async function getSitesToAudit() {
    const result = await getSites();

    return result.Items.map(item => item.baseURL);
}

module.exports = {
    getSiteByBaseURLWithAudits,
    getSiteByBaseURL,
    getSitesWithLatestAudit,
    getSiteByBaseURLWithLatestAudit,
    getSitesToAudit
};
