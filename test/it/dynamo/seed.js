/*
 * Copyright 2025 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { createDataAccess } from '@adobe/spacecat-shared-data-access-v2';
/* eslint-disable no-await-in-loop, import/no-extraneous-dependencies */
import { DynamoDBClient, ScanCommand, BatchWriteItemCommand } from '@aws-sdk/client-dynamodb';

import { organizations } from './seed-data/organizations.js';
import { sites } from './seed-data/sites.js';
import { audits } from './seed-data/audits.js';
import { opportunities } from './seed-data/opportunities.js';
import { suggestions } from './seed-data/suggestions.js';
import { fixes } from './seed-data/fixes.js';
import { experiments } from './seed-data/experiments.js';
import { siteTopPages } from './seed-data/site-top-pages.js';
import { entitlements } from './seed-data/entitlements.js';
import { siteEnrollments } from './seed-data/site-enrollments.js';
import { projects } from './seed-data/projects.js';
import { sentimentTopics } from './seed-data/sentiment-topics.js';
import { sentimentGuidelines } from './seed-data/sentiment-guidelines.js';
import { auditUrls } from './seed-data/audit-urls.js';
import { trialUsers } from './seed-data/trial-users.js';
import { trialUserActivities } from './seed-data/trial-user-activities.js';

const TABLE_NAME = 'spacecat-services-data';
const ENDPOINT = 'http://127.0.0.1:8000';

const client = new DynamoDBClient({
  endpoint: ENDPOINT,
  region: 'us-east-1',
  credentials: { accessKeyId: 'dummy', secretAccessKey: 'dummy' },
});

// Suppress ElectroDB debug logs (every DynamoDB operation is logged via log.debug)
const quietLog = { ...console, debug: () => {} };

const dataAccess = createDataAccess(
  { tableNameData: TABLE_NAME },
  quietLog,
  client,
);

/**
 * Deletes all items from the DynamoDB single table via scan + batch delete.
 * Generic — works regardless of entity types stored in the table.
 */
async function truncate() {
  let lastKey;
  do {
    const result = await client.send(new ScanCommand({
      TableName: TABLE_NAME,
      ExclusiveStartKey: lastKey,
      ProjectionExpression: 'pk, sk',
    }));

    const items = result.Items || [];
    for (let i = 0; i < items.length; i += 25) {
      const batch = items.slice(i, i + 25);
      await client.send(new BatchWriteItemCommand({
        RequestItems: {
          [TABLE_NAME]: batch.map((item) => ({
            DeleteRequest: { Key: { pk: item.pk, sk: item.sk } },
          })),
        },
      }));
    }

    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
}

/**
 * Seeds the table with baseline data via the v2 data access library.
 */
async function seed() {
  for (const org of organizations) {
    await dataAccess.Organization.create(org);
  }
  for (const site of sites) {
    await dataAccess.Site.create(site);
  }
  for (const audit of audits) {
    await dataAccess.Audit.create(audit);
  }
  for (const oppty of opportunities) {
    await dataAccess.Opportunity.create(oppty);
  }
  const createdSuggestions = [];
  for (const sugg of suggestions) {
    createdSuggestions.push(await dataAccess.Suggestion.create(sugg));
  }
  for (const fix of fixes) {
    const fixEntity = await dataAccess.FixEntity.create(fix);
    // Link FIX_1 to SUGG_1 via junction
    if (fix.fixEntityId === 'cc111111-1111-4111-b111-111111111111') {
      const sugg1 = createdSuggestions.find(
        (s) => s.getId() === 'bb111111-1111-4111-b111-111111111111',
      );
      if (sugg1) {
        await dataAccess.FixEntity.setSuggestionsForFixEntity(
          fix.opportunityId,
          fixEntity,
          [sugg1],
        );
      }
    }
  }
  for (const project of projects) {
    await dataAccess.Project.create(project);
  }
  for (const entitlement of entitlements) {
    await dataAccess.Entitlement.create(entitlement);
  }
  for (const enrollment of siteEnrollments) {
    await dataAccess.SiteEnrollment.create(enrollment);
  }
  for (const experiment of experiments) {
    await dataAccess.Experiment.create(experiment);
  }
  for (const topPage of siteTopPages) {
    await dataAccess.SiteTopPage.create(topPage);
  }
  for (const topic of sentimentTopics) {
    await dataAccess.SentimentTopic.create(topic);
  }
  for (const guideline of sentimentGuidelines) {
    await dataAccess.SentimentGuideline.create(guideline);
  }
  for (const auditUrl of auditUrls) {
    await dataAccess.AuditUrl.create(auditUrl);
  }
  for (const trialUser of trialUsers) {
    await dataAccess.TrialUser.create(trialUser);
  }
  for (const activity of trialUserActivities) {
    await dataAccess.TrialUserActivity.create(activity);
  }
}

/**
 * Resets the DynamoDB table: truncates all data, then re-seeds baseline.
 * Called by each test suite in before() for full isolation.
 */
export async function resetDynamo() {
  await truncate();
  await seed();
}
