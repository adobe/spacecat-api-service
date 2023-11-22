const {docClient: client, queryDb} = require('./db.js');

async function getAuditsForSite(siteId, auditType) {
    return queryDb({
        TableName: 'audits',
        KeyConditionExpression: 'siteId = :siteId AND begins_with(SK, :auditType)',
        ExpressionAttributeValues: {
            ':siteId': siteId,
            ':auditType': `${auditType}#`
        }
    });
}

async function getSiteByBaseURLWithAuditInfo(baseUrl, auditType, latestOnly = false) {
    const site = await getSiteByBaseURL(baseUrl);

    if (!site) {
        return null;
    }

    if (latestOnly) {
        site.latestAudit = await getLatestAuditForSite(site.id, auditType);
    } else {
        site.audits = await getAuditsForSite(site.id, auditType);
    }

    return site;
}

async function getSiteByBaseURLWithAudits(baseUrl, auditType) {
    return getSiteByBaseURLWithAuditInfo(baseUrl, auditType, false);
}

async function getSiteByBaseURLWithLatestAudit(baseUrl, auditType) {
    return getSiteByBaseURLWithAuditInfo(baseUrl, auditType, true);
}

async function getSiteByBaseURL(baseUrl) {
    const sites = await queryDb({
        TableName: 'sites',
        IndexName: 'sites_all', // Replace with your GSI name
        KeyConditionExpression: 'GSI1PK = :gsi1pk AND baseURL = :baseUrl',
        ExpressionAttributeValues: {
            ':gsi1pk': 'ALL_SITES',
            ':baseUrl': baseUrl
        },
        Limit: 1
    });

    return sites.length ? sites[0] : null;
}

async function getLatestAudits(auditType) {
    return queryDb({
        TableName: 'latest_audits',
        IndexName: 'latest_audits_all',
        KeyConditionExpression: 'GSI1PK = :gsi1pk AND begins_with(GSI1SK, :auditType)',
        ExpressionAttributeValues: {
            ':gsi1pk': 'ALL_LATEST_AUDITS',
            ':auditType': `${auditType}#`
        },
        ScanIndexForward: false // Audits already sorted in descending order by GSK1SK
    });
}

async function getLatestAuditForSite(siteId, auditType) {
    const latestAudit = await queryDb({
        TableName: 'latest_audits',
        IndexName: 'latest_audit_scores',
        KeyConditionExpression: 'siteId = :siteId AND begins_with(GSI1SK, :auditType)',
        ExpressionAttributeValues: {
            ':siteId': siteId,
            ':auditType': `${auditType}#`
        },
        Limit: 1
    });

    return latestAudit.length > 0 ? latestAudit[0] : null;
}

async function getSitesWithLatestAudit(auditType) {
    const [sites, latestAudits] = await Promise.all([
        getSites(),
        getLatestAudits(auditType)
    ]);

    const sitesMap = new Map(sites.map(site => [site.id, site]));

    const sitesWithLatestAudit = latestAudits.reduce((result, audit) => {
        const site = sitesMap.get(audit.siteId);
        if (site) {
            result.push({
                ...site,
                latestAudit: audit
            });
        }
        return result;
    }, []);

    return sitesWithLatestAudit;
}


async function getSites() {
    return queryDb({
        TableName: 'sites',
        IndexName: 'sites_all', // GSI name
        KeyConditionExpression: 'GSI1PK = :gsi1pk',
        ExpressionAttributeValues: {
            ':gsi1pk': 'ALL_SITES'
        }
    });
}

async function getSitesToAudit() {
    const sites = await getSites();

    return sites.map(item => item.baseURL);
}

module.exports = {
    getAuditsForSite,
    getLatestAudits,
    getSiteByBaseURL,
    getSiteByBaseURLWithAudits,
    getSiteByBaseURLWithLatestAudit,
    getSitesToAudit,
    getSitesWithLatestAudit,
};
