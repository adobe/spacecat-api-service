# DynamoDB Sample Data Generator

## Overview
This DynamoDB Sample Data Generator is designed to create structured sample data in DynamoDB tables for testing various
data access patterns. It's tailored to generate data for three primary entities: `sites`, `audits`, and `latest_audits`,
following a predefined schema.

## Database Schema and Entities

### Entities

1. **Sites**:
   - **Table Name**: `sites`
   - **Attributes**:
      - `id` (String, Partition Key): A unique identifier for each site.
      - `baseURL` (String): The base URL of the site.
      - `imsOrgId` (String): An ID representing the organization to which the site belongs.
      - `GSI1PK` (String): A partition key used for global secondary index queries.
   - **Global Secondary Index**:
      - `sites_all`: Index to facilitate queries across all sites, with `GSI1PK` as the partition key and `baseURL` as the sort key.
   - **Example**:
      - `{ id: "site-1", baseURL: "https://example1.com", imsOrgId: "org-123", GSI1PK: "ALL_SITES" }`

2. **Audits**:
   - **Table Name**: `audits`
   - **Attributes**:
      - `siteId` (String, Partition Key): The ID of the site to which the audit belongs.
      - `SK` (String, Sort Key): A sort key composed of "<auditType>#<auditedAt>".
      - `auditedAt` (String): The timestamp when the audit was conducted.
      - `auditResult` (Map): A map containing the results of the audit.
         - For LHS-type audits, this could be structured as: `{ performance: 0.9, accessibility: 0.8, ... }`
      - `fullAuditRef` (String): A reference to the full audit report.
      - `auditType` (String): The type of audit (e.g., "lhs", "cwv").
   - **Example**:
      - `{ siteId: "site-1", SK: "lhs#2021-01-01T00:00:00Z", auditedAt: "2021-01-01T00:00:00Z", auditResult: { performance: 0.9, accessibility: 0.8 }, fullAuditRef: "ref123", auditType: "lhs" }`

3. **Latest Audits**:
   - **Table Name**: `latest_audits`
   - **Attributes**:
      - `siteId` (String, Partition Key): The ID of the site for which the audit is the latest.
      - `SK` (String, Sort Key): The attribute is composed of "<auditType>#<auditedAt>".
      - `auditedAt` (String): The timestamp of the audit.
      - `auditResult` (Map): Results of the audit, similar to the `audits` table.
      - `fullAuditRef` (String): Reference to the full audit report.
      - `GSI1SK` (String): A secondary sort key used in global secondary indexes, composed of "<auditType>#<scores>"
      - `auditType` (String): The type of the audit.
   - **Global Secondary Indexes**:
      - `latest_audit_scores`: Index to access the latest audits based on scores.
      - `latest_audits_all`: Index to access all latest audits.
   - **Example**:
      - `{ siteId: "site-1", SK: "latest#lhs", auditedAt: "2021-01-01T00:00:00Z", auditResult: { performance: 0.9, accessibility: 0.8 }, fullAuditRef: "ref123", GSI1SK: "lhs#90#80", auditType: "lhs" }`

## Functionality
The tool's functionality revolves around the creation of these entities in DynamoDB, providing a rich dataset for 
testing various database queries and access patterns.

## Usage
To generate sample data:

1. **Configure AWS Credentials**: Ensure correct setup for DynamoDB access.
2. **Adjust Parameters**: Modify the parameters in `generateSampleData.js` to customize the data generation.
3. **Run the Script**: Execute `node src/generateSampleData.js` to generate and populate data.
4. **RUn the Tests**: Run `npm test` to execute the test suite.

Customize data generation by modifying parameters in the `generateSampleData` function call.
