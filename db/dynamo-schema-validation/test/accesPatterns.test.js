const {
    getSiteByBaseURLWithAudits,
    getSiteByBaseURL,
    getSitesWithLatestAudit,
    getSiteByBaseURLWithLatestAudit,
    getSitesToAudit
} = require('../src/accessPatterns.js');

describe('DynamoDB Access Patterns Tests', () => {

    test('getSiteByBaseURLWithAudits', async () => {
        const baseUrl = 'https://example1.com'; // Use an existing baseURL for testing
        const siteWithAudits = await getSiteByBaseURLWithAudits(baseUrl);

        expect(siteWithAudits).not.toBeNull();
        expect(siteWithAudits).toBeDefined();
        expect(siteWithAudits.baseURL).toBe(baseUrl);
        expect(siteWithAudits.audits).toBeInstanceOf(Array);
    });

    test('getSiteByBaseURL', async () => {
        const result = await getSiteByBaseURL('https://example1.com');
        expect(result).not.toBeNull();
        expect(result).toBeDefined();
        expect(result.baseURL).toBe('https://example1.com');
    });

    test('getSitesWithLatestAudit', async () => {
        const results = await getSitesWithLatestAudit('lhs');
        expect(results).toBeInstanceOf(Array);
    });

    test('getSiteByBaseURLWithLatestAudit', async () => {
        const result = await getSiteByBaseURLWithLatestAudit('https://example1.com', 'cwv');
        expect(result).not.toBeNull();
        expect(result).toBeDefined();
        expect(result.latestAudit).not.toBeNull();
        expect(result.latestAudit).toBeDefined();
    });

    test('getSitesToAudit', async () => {
        const baseURLs = await getSitesToAudit();
        expect(baseURLs).toBeInstanceOf(Array);
    });

});
