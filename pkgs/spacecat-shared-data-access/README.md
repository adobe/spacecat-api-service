# SpaceCat Shared Data Access

This Node.js module, `spacecat-shared-data-access`, is a data access layer for managing sites and their audits, leveraging Amazon DynamoDB.

## Installation

```bash
npm install @adobe/spacecat-shared-data-access
```

## Entities

### Sites
- **id** (String): Unique identifier for a site.
- **baseURL** (String): Base URL of the site.
- **imsOrgId** (String): Organization ID associated with the site.
- **createdAt** (String): Timestamp of creation.
- **updatedAt** (String): Timestamp of the last update.
- **GSI1PK** (String): Partition key for the Global Secondary Index.

### SiteCandidates
- **baseURL** (String): Base URL of the site candidate.
- **status** (String): Status of the site candidate (PENDING, IGNORED, APPROVED, ERROR)
- **createdAt** (String): Timestamp of creation.
- **updatedAt** (String): Timestamp of the last update.
- **updatedBy** (String): Slack id of the last person updated the site candidate.

### Audits
- **siteId** (String): Identifier of the site being audited.
- **SK** (String): Sort key, typically a composite of audit type and timestamp.
- **auditedAt** (String): Timestamp of the audit.
- **auditResult** (Map): Results of the audit.
- **auditType** (String): Type of the audit.
- **expiresAt** (Number): Expiry timestamp of the audit.
- **fullAuditRef** (String): Reference to the full audit details.

### SiteTopPages
- **siteId** (String): Identifier of the site.
- **url** (String): URL of the top page.
- **traffic** (Number): Traffic of the top page.
- **source** (String): Source of the data.
- **geo** (String): Geo of the top page.
- **importedAt** (String): Timestamp of the import.

## DynamoDB Data Model

The module is designed to work with the following DynamoDB tables:

1. **Sites Table**: Manages site records.
2. **Audits Table**: Stores audit information for each site.
3. **Latest Audits Table**: Holds only the latest audit for each site for quick access.
4. **Site Candidates Table**: Manages site candidates.
5. **Site Top Pages Table**: Stores top pages for each site.

Each table is designed with scalability and efficient querying in mind, utilizing both key and non-key attributes effectively.

For a detailed schema, refer to `docs/schema.json`. This schema is importable to Amazon NoSQL Workbench and used by the integration tests.

## Integration Testing

The module includes comprehensive integration tests embedding a local DynamoDB server with in-memory storage for testing:

```bash
npm run test:it
```

These tests create the schema, generate sample data, and test the data access patterns against the local DynamoDB instance.

## Data Access API

The module provides the following DAOs:

### Site Functions
- `getSites`
- `getSitesToAudit`
- `getSitesWithLatestAudit`
- `getSiteByBaseURL`
- `getSiteByBaseURLWithAuditInfo`
- `getSiteByBaseURLWithAudits`
- `getSiteByBaseURLWithLatestAudit`
- `addSite`
- `updateSite`
- `removeSite`

### Site Candidate Functions
- `getSiteCandidateByBaseURL`
- `upsertSiteCandidate`
- `siteCandidateExists`
- `updateSiteCandidate`

### Audit Functions
- `getAuditsForSite`
- `getAuditForSite`
- `getLatestAudits`
- `getLatestAuditForSite`
- `addAudit`

### Site Top Pages Functions
- `getTopPagesForSite`
- `addSiteTopPage`

## Integrating Data Access in AWS Lambda Functions

Our `spacecat-shared-data-access` module includes a wrapper that can be easily integrated into AWS Lambda functions using `@adobe/helix-shared-wrap`.
This integration allows your Lambda functions to access and manipulate data.

### Steps for Integration

1. **Import the Data Access Wrapper**

   Along with other wrappers and utilities, import the `dataAccessWrapper`.

   ```javascript
   import dataAccessWrapper from '@adobe/spacecat-shared-data-access';
   ```

2. **Provide Required Environment Variables**

   The `dataAccessWrapper` requires the `DYNAMO_TABLE_NAME_DATA` environment variable to be set via AWS
   secret assigned to your Lambda function.

   ```javascript
   const { DYNAMO_TABLE_NAME_DATA } = context.env;
   ```

3. **Modify Your Lambda Wrapper Script**

   Include `dataAccessWrapper` in the chain of wrappers when defining your Lambda handler.

   ```javascript
   export const main = wrap(run)
     .with(sqsEventAdapter)
     .with(dataAccessWrapper) // Add this line
     .with(sqs)
     .with(secrets)
     .with(helixStatus);
   ```

4. **Access Data in Your Lambda Function**

   Use the `dataAccess` object from the context to interact with your data layer.

   ```javascript
   async function run(message, context) {
     const { dataAccess } = context;
     
     // Example: Retrieve all sites
     const sites = await dataAccess.Site.getSites();
     // ... more logic ...
   }
   ```

### Example

Here's a complete example of a Lambda function utilizing the data access wrapper:

```javascript
import wrap from '@adobe/helix-shared-wrap';
import dataAccessWrapper from '@adobe/spacecat-shared-data-access';
import sqsEventAdapter from './sqsEventAdapter';
import sqs from './sqs';
import secrets from '@adobe/helix-shared-secrets';
import helixStatus from '@adobe/helix-status';

async function run(message, context) {
  const { dataAccess } = context;
  try {
    const sites = await dataAccess.Site.getSites();
    // Function logic here
  } catch (error) {
    // Error handling
  }
}

export const main = wrap(run)
  .with(sqsEventAdapter)
  .with(dataAccessWrapper)
  .with(sqs)
  .with(secrets)
  .with(helixStatus);
```

## Contributing

Contributions to `spacecat-shared-data-access` are welcome. Please adhere to the standard Git workflow and submit pull requests for proposed changes.

## License

Licensed under the Apache-2.0 License.
