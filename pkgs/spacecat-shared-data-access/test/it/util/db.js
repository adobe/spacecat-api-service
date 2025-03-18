/*
 * Copyright 2024 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import { DynamoDB } from '@aws-sdk/client-dynamodb';

import { createDataAccess } from '../../../src/service/index.js';

export const TEST_DA_CONFIG = {
  indexNameAllImportJobsByDateRange: 'spacecat-services-all-import-jobs-by-date-range',
  indexNameAllImportJobsByStatus: 'spacecat-services-all-import-jobs-by-status',
  indexNameAllKeyEventsBySiteId: 'spacecat-services-key-events-by-site-id',
  indexNameAllLatestAuditScores: 'spacecat-services-all-latest-audit-scores',
  indexNameAllOrganizations: 'spacecat-services-all-organizations',
  indexNameAllOrganizationsByImsOrgId: 'spacecat-services-all-organizations-by-ims-org-id',
  indexNameAllSites: 'spacecat-services-all-sites',
  indexNameAllSitesByDeliveryType: 'spacecat-services-all-sites-by-delivery-type',
  indexNameAllSitesOrganizations: 'spacecat-services-all-sites-organizations',
  indexNameApiKeyByHashedApiKey: 'spacecat-services-api-key-by-hashed-api-key',
  indexNameApiKeyByImsUserIdAndImsOrgId: 'spacecat-services-api-key-by-ims-user-id-and-ims-org-id',
  indexNameImportUrlsByJobIdAndStatus: 'spacecat-services-all-import-urls-by-job-id-and-status',
  pkAllConfigurations: 'ALL_CONFIGURATIONS',
  pkAllImportJobs: 'ALL_IMPORT_JOBS',
  pkAllLatestAudits: 'ALL_LATEST_AUDITS',
  pkAllOrganizations: 'ALL_ORGANIZATIONS',
  pkAllSites: 'ALL_SITES',
  tableNameApiKeys: 'spacecat-services-api-keys',
  tableNameAudits: 'spacecat-services-audits',
  tableNameConfigurations: 'spacecat-services-configurations',
  tableNameData: 'spacecat-services-data',
  tableNameExperiments: 'spacecat-services-experiments',
  tableNameImportJobs: 'spacecat-services-import-jobs',
  tableNameImportUrls: 'spacecat-services-import-urls',
  tableNameKeyEvents: 'spacecat-services-key-events',
  tableNameLatestAudits: 'spacecat-services-latest-audits',
  tableNameOrganizations: 'spacecat-services-organizations',
  tableNameRole: 'spacecat-services-roles',
  tableNameSiteCandidates: 'spacecat-services-site-candidates',
  tableNameSiteTopPages: 'spacecat-services-site-top-pages',
  tableNameSites: 'spacecat-services-sites',
  tableNameSpacecatData: 'spacecat-data',
};

let docClient = null;

const getDynamoClients = (config = {}) => {
  let dbClient;
  if (config?.region && config?.credentials) {
    dbClient = new DynamoDB(config);
  } else {
    dbClient = new DynamoDB({
      endpoint: 'http://127.0.0.1:8000',
      region: 'local',
      credentials: {
        accessKeyId: 'dummy',
        secretAccessKey: 'dummy',
      },
    });
  }
  docClient = DynamoDBDocument.from(dbClient);

  return { dbClient, docClient };
};

export const getDataAccess = (config, logger = console) => {
  const { dbClient } = getDynamoClients(config);
  return createDataAccess({ ...config, ...TEST_DA_CONFIG }, logger, dbClient);
};

export { getDynamoClients };
