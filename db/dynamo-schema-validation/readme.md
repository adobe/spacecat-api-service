# DynamoDB Sample Data Generator

## Overview
This DynamoDB Sample Data Generator is designed to create structured sample data in DynamoDB tables for testing various
data access patterns. It's tailored to generate data for three primary entities: `sites`, `audits`, and `latest_audits`,
following a predefined schema.

## Prerequisites
- Node.js (Version 12.x or later) must be installed.
- Local DynamoDB instance, which can be installed and run locally using Homebrew.

## Installation

### Install DynamoDB Locally
1. **Install Local DynamoDB**: If you don't have DynamoDB installed locally, you can install it using Homebrew:
   ```bash
   brew install dynamodb-local
   ```
2. **Run Local DynamoDB**: Start the local DynamoDB instance:
   ```bash
   /opt/homebrew/bin/dynamodb-local
   ```

### Setup Sample Data Generator
3. **Clone the Repository**: Clone this repository to your local machine.
4. **Navigate to Project Directory**: Change to the directory containing the cloned code.
5. **Install Dependencies**: Run `npm install` to install the required Node.js dependencies.

## Configuration

Create `.env` File for Local DynamoDB Access
Before generating sample data, create a .env file in the root of the project with the following content to configure access to the local DynamoDB instance:
```dotenv
DYNAMODB_ENDPOINT=http://localhost:8000
AWS_REGION=localhost
```

## Generating Sample Data

### Using NPM Script
You can generate sample data using an NPM script. The script allows you to specify the number of sites and audits per type as arguments.

To generate sample data, run:

```bash
npm run generate-data -- [number-of-sites] [number-of-audits-per-type]
```

For example, to generate 20 sites with 10 audits per type:

```bash
npm run generate-data -- 20 10
```

If no arguments are provided, the script will use default values for the number of sites and audits per type.

## Adjust Test
Set the expected number of sites and audits per type in the `accessPatterns.test.js` file. Then, run the test using:

```bash
npm run test
```

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

## Access Patterns
![Star Catalogue (SpaceCat) - Dynamo Patterns](https://github.com/adobe-rnd/spacecat-api-service/assets/1872195/de70cfd9-52e7-4579-a982-9e82be925e35)
