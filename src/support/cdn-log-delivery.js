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

import {
  CloudWatchLogsClient,
  PutDeliverySourceCommand,
  CreateDeliveryCommand,
  GetDeliverySourceCommand,
  DescribeDeliveriesCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { hasText } from '@adobe/spacecat-shared-utils';

// CDN vended-log delivery control plane and the Adobe cross-account destination both live in
// us-east-1 (see spacecat-auth-service cdn-logs provisioning).
export const CDN_LOG_DELIVERY_REGION = 'us-east-1';

const CDN_LOG_S3_SUFFIX_PATH = '/{yyyy}/{MM}/{dd}/{HH}';

// Supported CDN providers. CloudFront is the first; add a new provider here (resource-ARN shape,
// CloudWatch log type, source-name prefix, delivered record fields) without touching the
// delivery flow below.
export const CDN_PROVIDERS = {
  cloudfront: {
    logType: 'ACCESS_LOGS',
    sourceNamePrefix: 'llmo-cf',
    buildResourceArn: ({ accountId, resourceId }) => `arn:aws:cloudfront::${accountId}:distribution/${resourceId}`,
    recordFields: [
      'date', 'time', 'x-edge-location', 'cs-method', 'cs(Host)', 'cs-uri-stem', 'sc-status',
      'cs(Referer)', 'cs(User-Agent)', 'time-to-first-byte', 'sc-content-type', 'x-host-header',
    ],
  },
};

export const DEFAULT_CDN_PROVIDER = 'cloudfront';

function getProviderConfig(provider) {
  const config = CDN_PROVIDERS[provider];
  if (!config) {
    throw new Error(`Unsupported CDN provider: ${provider}`);
  }
  return config;
}

/**
 * Normalize an IMS org id into the AWS-safe token used in cdn-logs resource names. Mirrors
 * spacecat-auth-service `toSafeAwsName` — must match byte-for-byte so the destination resolves.
 */
export function toSafeAwsName(imsOrgId) {
  return String(imsOrgId).replace(/@AdobeOrg$/, '').replace(/@/g, '').toLowerCase();
}

/**
 * Build the cross-account delivery-destination ARN Adobe provisioned for this org's cdn-logs
 * bucket (`cdn-logs-<org>`). Provider-agnostic.
 */
export function buildDeliveryDestinationArn({
  imsOrgId,
  adobeAccountId,
  region = CDN_LOG_DELIVERY_REGION,
}) {
  if (!hasText(imsOrgId)) {
    throw new Error('imsOrgId is required');
  }
  if (!/^[0-9]{12}$/.test(String(adobeAccountId))) {
    throw new Error('adobeAccountId must be a 12-digit AWS account ID');
  }
  const name = `cdn-logs-${toSafeAwsName(imsOrgId)}`;
  return `arn:aws:logs:${region}:${adobeAccountId}:delivery-destination:${name}`;
}

/** Per-resource delivery-source name, scoped by provider + org + resource. */
export function buildDeliverySourceName({
  provider = DEFAULT_CDN_PROVIDER,
  imsOrgId,
  resourceId,
}) {
  const { sourceNamePrefix } = getProviderConfig(provider);
  return `${sourceNamePrefix}-${toSafeAwsName(imsOrgId)}-${resourceId}`;
}

/**
 * Enable CDN access-log forwarding to Adobe (diagram step 8): create the customer-account
 * delivery source and link it to Adobe's cross-account destination so the CDN pushes logs to
 * the cdn-logs S3 bucket.
 *
 * Idempotent — returns `{ created: false, alreadyExisted: true }` and mutates nothing when a
 * delivery from this resource's source already exists.
 *
 * @param {object} credentials - temporary credentials from the connector role assume-role.
 * @param {object} params
 * @param {string} [params.provider] - CDN provider key (see CDN_PROVIDERS); defaults to cloudfront.
 * @param {string} params.resourceId - the CDN resource id (e.g. CloudFront distribution id).
 * @param {string} params.accountId - 12-digit customer AWS account id.
 * @param {string} params.imsOrgId
 * @param {string} params.deliveryDestinationArn - Adobe's cross-account destination ARN.
 * @param {string} [params.region]
 * @returns {Promise<{created: boolean, alreadyExisted: boolean, deliverySourceName: string,
 *   deliveryId: string|undefined}>}
 */
export async function createCdnLogDelivery(credentials, {
  provider = DEFAULT_CDN_PROVIDER,
  resourceId,
  accountId,
  imsOrgId,
  deliveryDestinationArn,
  region = CDN_LOG_DELIVERY_REGION,
}) {
  const config = getProviderConfig(provider);
  if (!hasText(resourceId)) {
    throw new Error('resourceId is required');
  }
  if (!/^[0-9]{12}$/.test(String(accountId))) {
    throw new Error('accountId must be a 12-digit AWS account ID');
  }
  if (!hasText(imsOrgId)) {
    throw new Error('imsOrgId is required');
  }
  if (!hasText(deliveryDestinationArn)) {
    throw new Error('deliveryDestinationArn is required');
  }

  const client = new CloudWatchLogsClient({ region, credentials });
  const deliverySourceName = buildDeliverySourceName({ provider, imsOrgId, resourceId });
  const resourceArn = config.buildResourceArn({ accountId, resourceId });

  // Find the existing delivery for this source, if any (paginated). Returns it or undefined.
  const findExistingDelivery = async () => {
    let nextToken;
    do {
      // eslint-disable-next-line no-await-in-loop
      const page = await client.send(new DescribeDeliveriesCommand({
        deliverySourceName,
        ...(nextToken && { nextToken }),
      }));
      const match = (page.deliveries || []).find(
        (d) => d.deliverySourceName === deliverySourceName,
      );
      if (match) {
        return match;
      }
      nextToken = page.nextToken;
    } while (nextToken);
    return undefined;
  };

  // No-op if forwarding is already enabled for this resource.
  let sourceExists = false;
  try {
    await client.send(new GetDeliverySourceCommand({ name: deliverySourceName }));
    sourceExists = true;
  } catch (err) {
    if (err?.name !== 'ResourceNotFoundException') {
      throw err;
    }
  }

  if (sourceExists) {
    const existing = await findExistingDelivery();
    if (existing) {
      return {
        created: false,
        alreadyExisted: true,
        deliverySourceName,
        deliveryId: existing.id,
      };
    }
  }

  await client.send(new PutDeliverySourceCommand({
    name: deliverySourceName,
    resourceArn,
    logType: config.logType,
  }));

  let response;
  try {
    response = await client.send(new CreateDeliveryCommand({
      deliverySourceName,
      deliveryDestinationArn,
      s3DeliveryConfiguration: { suffixPath: CDN_LOG_S3_SUFFIX_PATH },
      recordFields: config.recordFields,
    }));
  } catch (err) {
    // TOCTOU: a concurrent enable/rescan for the same distribution can both pass the existence
    // check above and race here; the losing CreateDelivery conflicts. Treat as already-enabled to
    // preserve the idempotency contract instead of surfacing a 500.
    if (err?.name === 'ConflictException' || err?.name === 'ResourceAlreadyExistsException') {
      const existing = await findExistingDelivery();
      return {
        created: false,
        alreadyExisted: true,
        deliverySourceName,
        deliveryId: existing?.id,
      };
    }
    throw err;
  }

  return {
    created: true,
    alreadyExisted: false,
    deliverySourceName,
    deliveryId: response?.delivery?.id,
  };
}
