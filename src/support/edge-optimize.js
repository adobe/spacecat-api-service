/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { CloudFrontClient, ListDistributionsCommand } from '@aws-sdk/client-cloudfront';
import { hasText } from '@adobe/spacecat-shared-utils';

// CloudFront is a global service; its control plane lives in us-east-1.
export const EDGE_OPTIMIZE_REGION = 'us-east-1';
export const EDGE_OPTIMIZE_DEFAULT_ROLE_NAME = 'AdobeLLMOptimizerCloudFrontConnectorRole';
const SESSION_NAME = 'llmo-edge-optimize';
const SESSION_DURATION_SECONDS = 900;

/**
 * Assume the customer's cross-account connector role and return short-lived credentials.
 *
 * The api-service Lambda execution role (the default credential chain) assumes the role the
 * customer created via the CloudFormation bootstrap, scoped by the per-session external ID.
 * Credentials are short-lived — callers should use them immediately for a single operation
 * and never persist them in the browser.
 *
 * @param {object} params
 * @param {string} params.accountId - 12-digit customer AWS account ID.
 * @param {string} params.externalId - external ID baked into the connector role trust policy.
 * @param {string} [params.roleName] - connector role name (defaults to the standard name).
 * @param {string} [params.region] - STS region.
 * @returns {Promise<{roleArn: string, accountId: string, credentials: object}>}
 */
export async function assumeConnectorRole({
  accountId,
  externalId,
  roleName = EDGE_OPTIMIZE_DEFAULT_ROLE_NAME,
  region = EDGE_OPTIMIZE_REGION,
}) {
  if (!/^[0-9]{12}$/.test(String(accountId))) {
    throw new Error('accountId must be a 12-digit AWS account ID');
  }
  if (!hasText(externalId)) {
    throw new Error('externalId is required');
  }

  const roleArn = `arn:aws:iam::${accountId}:role/${roleName}`;
  const sts = new STSClient({ region });
  const response = await sts.send(new AssumeRoleCommand({
    RoleArn: roleArn,
    RoleSessionName: SESSION_NAME,
    ExternalId: externalId,
    DurationSeconds: SESSION_DURATION_SECONDS,
  }));

  const creds = response?.Credentials;
  if (!creds?.AccessKeyId || !creds?.SecretAccessKey || !creds?.SessionToken) {
    throw new Error('Failed to assume connector role: no credentials returned');
  }

  return {
    roleArn,
    accountId: String(accountId),
    credentials: {
      accessKeyId: creds.AccessKeyId,
      secretAccessKey: creds.SecretAccessKey,
      sessionToken: creds.SessionToken,
      expiration: creds.Expiration,
    },
  };
}

/**
 * List the CloudFront distributions in the customer account using assumed-role credentials.
 *
 * @param {object} credentials - temporary credentials from {@link assumeConnectorRole}.
 * @param {string} [region] - CloudFront control-plane region.
 * @returns {Promise<Array<object>>} distributions projected to the fields the wizard needs.
 */
export async function listCloudFrontDistributions(credentials, region = EDGE_OPTIMIZE_REGION) {
  const client = new CloudFrontClient({ region, credentials });
  const response = await client.send(new ListDistributionsCommand({}));
  const items = response?.DistributionList?.Items || [];
  return items.map((dist) => ({
    id: dist.Id,
    domainName: dist.DomainName,
    aliases: dist.Aliases?.Items || [],
    status: dist.Status,
    enabled: dist.Enabled === true,
    comment: dist.Comment || '',
  }));
}
