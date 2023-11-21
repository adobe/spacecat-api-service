// Utility functions for generating random audits

const { randomDate } = require('./util.js');
const { v4: uuidv4 } = require('uuid');

// Function to generate random audit data
function generateRandomAudit(siteId) {
    const auditTypes = ['lhs', 'cwv'];
    const selectedType = auditTypes[Math.floor(Math.random() * auditTypes.length)];

    let auditResult = {};
    const auditedAt = randomDate(new Date(2020, 0, 1), new Date()).toISOString();
    const fullAuditRef = `s3://audit-results/${uuidv4()}.json`;

    function getRandomDecimal(precision) {
        return parseFloat(Math.random().toFixed(precision));
    }

    function getRandomInt(max) {
        return Math.floor(Math.random() * max);
    }

    if (selectedType === 'lhs') {
        auditResult = {
            performance: getRandomDecimal(2),
            accessibility: getRandomDecimal(2),
            bestPractices: getRandomDecimal(2),
            SEO: getRandomDecimal(2),
        };

    } else if (selectedType === 'cwv') {
        auditResult = {
            LCP: getRandomInt(4000), // LCP in milliseconds
            FID: getRandomInt(100), // FID in milliseconds
            CLS: getRandomDecimal(2), // CLS score
        };
    }

    return {
        siteId,
        SK: `${selectedType}#${auditedAt}`,
        auditType: selectedType,
        auditedAt,
        auditResult,
        fullAuditRef,
    };
}

module.exports = { generateRandomAudit };
