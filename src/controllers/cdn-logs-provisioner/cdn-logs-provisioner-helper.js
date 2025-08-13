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

import {
  S3Client,
  CreateBucketCommand,
  PutBucketEncryptionCommand,
  PutPublicAccessBlockCommand,
  PutBucketTaggingCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import {
  IAMClient,
  CreatePolicyCommand,
  CreateUserCommand,
  CreateAccessKeyCommand,
  AttachUserPolicyCommand,
} from '@aws-sdk/client-iam';
import {
  SecretsManagerClient,
  CreateSecretCommand,
  UpdateSecretCommand,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { hasText } from '@adobe/spacecat-shared-utils';

/* c8 ignore start */

/**
 * Generic validation function for AWS naming rules
 * @param {string} value - The value to validate
 * @param {string} name - The name of the value for error messages
 * @throws {Error} If the value is invalid
 */
function validateAwsName(value, name) {
  if (!hasText(value)) {
    throw new Error(`${name} is required`);
  }

  // Check if value contains only valid characters
  if (!/^[a-z0-9.-]+$/.test(value)) {
    throw new Error(`${name} must contain only lowercase letters, numbers, dots, and hyphens. Got: ${value}`);
  }

  // Check if value starts and ends with alphanumeric
  if (!/^[a-z0-9].*[a-z0-9]$/.test(value)) {
    throw new Error(`${name} must start and end with a letter or number. Got: ${value}`);
  }
}

/**
 * Validates an organization name according to specified rules
 * @param {string} imsOrgName - The organization name to validate
 * @throws {Error} If the organization name is invalid
 */
function validateOrgName(imsOrgName) {
  if (!hasText(imsOrgName)) {
    throw new Error('Organization name is required');
  }

  // Check if value contains only letters, numbers, and hyphens
  if (!/^[a-zA-Z0-9-]+$/.test(imsOrgName)) {
    throw new Error(`Organization name must contain only letters, numbers, and hyphens. Got: '${imsOrgName}'`);
  }
}

/**
 * Converts a string to AWS-safe format
 * @param {string} value - The string to convert
 * @returns {string} The AWS-safe string
 */
function toAwsSafeName(value) {
  return value.toLowerCase().replace(/@adobeorg$/i, '');
}

/**
 * Validates an organization identifier according to specified rules
 * @param {string} orgId - The organization identifier to validate
 * @throws {Error} If the organization identifier is invalid
 */
function validateOrgId(orgId) {
  if (!hasText(orgId)) {
    throw new Error('Organization identifier is required');
  }

  // Check if value contains only uppercase letters, numbers, and potentially @AdobeOrg suffix
  if (!/^[A-Z0-9]+(@AdobeOrg)?$/.test(orgId)) {
    throw new Error(`Organization identifier must contain only uppercase letters, numbers, and optionally end with @AdobeOrg. Got: ${orgId}`);
  }
}

/**
 * Generates a bucket name from organization name and organization identifier
 * @param {string} imsOrgName - The organization name (will be transformed)
 * @param {string} imsOrgId - The organization identifier
 * @returns {string} The generated bucket name
 */
function generateBucketName(imsOrgName, imsOrgId) {
  const safeOrgName = toAwsSafeName(imsOrgName);
  const safeOrgId = toAwsSafeName(imsOrgId);
  const shortOrgId = safeOrgId.substring(0, 10);
  return `cdn-logs-${safeOrgName}-${shortOrgId}`;
}

/**
 * Validates a bucket name according to AWS naming rules
 * @param {string} bucketName - The bucket name to validate
 * @throws {Error} If the bucket name is invalid
 */
function validateBucketName(bucketName) {
  if (!hasText(bucketName)) {
    throw new Error('bucketName is required');
  }

  if (bucketName.length < 3 || bucketName.length > 63) {
    throw new Error(`Bucket name must be between 3 and 63 characters long. Got: ${bucketName.length}`);
  }

  validateAwsName(bucketName, 'Bucket name');
}

/**
 * Generates the secrets manager path for an organization
 * @param {string} orgName - The organization name
 * @param {string} orgId - The organization identifier
 * @returns {string} The secrets manager path
 */
function generateSecretsPath(imsOrgName, imsOrgId) {
  const safeOrgName = toAwsSafeName(imsOrgName);
  const orgNameForSecrets = safeOrgName.replace(/-/g, '_');
  const shortOrgId = imsOrgId.substring(0, 10);
  return `/helix-deploy/spacecat-services/customer-secrets/${orgNameForSecrets}-${shortOrgId}/latest`;
}

/**
 * Checks if an S3 bucket exists and returns the status
 * @param {S3Client} s3Client - The S3 client
 * @param {string} bucketName - The bucket name to check
 * @param {object} log - Logger instance
 * @returns {Promise<Object>} Object with status and optional response
 */
async function checkBucketExists(s3Client, bucketName, log) {
  try {
    await s3Client.send(new HeadBucketCommand({ Bucket: bucketName }));
    log.info(`Bucket ${bucketName} already exists`);
    return {
      exists: true,
      inDifferentRegion: false,
      response: {
        statusCode: 200,
        body: JSON.stringify({
          message: `Bucket ${bucketName} already exists`,
          bucketName,
          bucketArn: `arn:aws:s3:::${bucketName}`,
        }),
      },
    };
  } catch (error) {
    // HeadBucketCommand returns 404 if bucket doesn't exist at all
    if (error.name === 'NotFound' || error.name === 'NoSuchBucket') {
      // Bucket doesn't exist, continue with creation
      log.info(`Bucket ${bucketName} does not exist, proceeding with creation`);
      return { exists: false, inDifferentRegion: false };
    } else if (error.$metadata?.httpStatusCode === 403 && error.message === 'UnknownError') {
      // This is likely a permissions issue with HeadBucket - treat as bucket doesn't exist
      // The CreateBucket operation will fail if the bucket actually exists
      log.info(`Cannot check if bucket ${bucketName} exists due to permissions, proceeding with creation`);
      return { exists: false, inDifferentRegion: false };
    } else {
      // Any other error - throw the error
      log.error(`Error checking if bucket exists: ${error.message}`);
      throw error;
    }
  }
}

/**
 * Creates an S3 bucket with the specified configuration
 * @param {S3Client} s3Client - The S3 client
 * @param {string} bucketName - The bucket name to create
 * @param {string} region - The AWS region for the bucket
 * @param {object} log - Logger instance
 * @throws {Error} If bucket creation fails
 */
async function createBucket(s3Client, bucketName, region, log) {
  const createBucketCommand = new CreateBucketCommand({
    Bucket: bucketName,
    CreateBucketConfiguration: {
      LocationConstraint: region === 'us-east-1' ? undefined : region,
    },
  });

  log.info('Sending CreateBucketCommand with configuration:', JSON.stringify(createBucketCommand.input, null, 2));

  try {
    await s3Client.send(createBucketCommand);
    log.info(`Successfully created bucket: ${bucketName}`);
  } catch (error) {
    if (error.name === 'BucketAlreadyExists' || error.name === 'BucketAlreadyOwnedByYou') {
      // Bucket already exists, which is fine
      log.info(`Bucket ${bucketName} already exists, continuing...`);
    } else {
      log.error('Error creating bucket:', error);
      log.error('Error details:', {
        name: error.name,
        message: error.message,
        code: error.$metadata?.httpStatusCode,
        requestId: error.$metadata?.requestId,
        extendedRequestId: error.$metadata?.extendedRequestId,
      });
      throw error;
    }
  }
}

/**
 * Retrieves Adobe tags from SSM
 * @param {SSMClient} ssmClient - The SSM client
 * @param {object} log - Logger instance
 * @returns {Promise<Array>} Array of tag objects
 */
async function getBucketTags(ssmClient, log) {
  // Get Adobe tags from SSM
  let adobeTags = {};
  try {
    const ssmCommand = new GetParameterCommand({ Name: '/spacecat/adobe-tags' });
    const ssmResponse = await ssmClient.send(ssmCommand);
    adobeTags = JSON.parse(ssmResponse.Parameter.Value);
    log.info('Retrieved Adobe tags from SSM');
  } catch (error) {
    log.warn('Could not retrieve Adobe tags from SSM:', error.message);
  }

  const tagSet = [
    { Key: 'CreatedBy', Value: 'CDN-Logs-Provisioner' },
    { Key: 'CreatedDate', Value: new Date().toISOString() },
    { Key: 'Adobe.VersioningNotRequired', Value: 'true' },
  ];

  // Add Adobe tags if available
  if (adobeTags.Adobe_ArchPath) {
    tagSet.push({ Key: 'Adobe.ArchPath', Value: adobeTags.Adobe_ArchPath });
  }
  if (adobeTags.Adobe_CostCenter) {
    tagSet.push({ Key: 'Adobe.CostCenter', Value: adobeTags.Adobe_CostCenter.toString() });
  }
  if (adobeTags.Adobe_DataClassification) {
    tagSet.push({ Key: 'Adobe.DataClassification', Value: adobeTags.Adobe_DataClassification });
  }
  if (adobeTags.Adobe_Environment) {
    tagSet.push({ Key: 'Adobe.Environment', Value: adobeTags.Adobe_Environment });
  }
  if (adobeTags.Adobe_Owner) {
    tagSet.push({ Key: 'Adobe.Owner', Value: adobeTags.Adobe_Owner });
  }
  if (adobeTags.Adobe_PCIData !== undefined) {
    tagSet.push({ Key: 'Adobe.PCIData', Value: adobeTags.Adobe_PCIData.toString() });
  }

  return tagSet;
}

/**
 * Configures an S3 bucket with encryption, public access block, and tags
 * @param {S3Client} s3Client - The S3 client
 * @param {SSMClient} ssmClient - The SSM client
 * @param {string} bucketName - The bucket name to configure
 * @param {object} log - Logger instance
 * @throws {Error} If configuration fails
 */
async function configureBucket(s3Client, ssmClient, bucketName, log) {
  // Configure bucket encryption
  const encryptionCommand = new PutBucketEncryptionCommand({
    Bucket: bucketName,
    ServerSideEncryptionConfiguration: {
      Rules: [
        {
          ApplyServerSideEncryptionByDefault: {
            SSEAlgorithm: 'AES256',
          },
          BucketKeyEnabled: true,
        },
      ],
    },
  });
  await s3Client.send(encryptionCommand);
  log.info(`Enabled encryption for bucket: ${bucketName}`);

  // Configure public access block
  const publicAccessBlockCommand = new PutPublicAccessBlockCommand({
    Bucket: bucketName,
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      IgnorePublicAcls: true,
      BlockPublicPolicy: true,
      RestrictPublicBuckets: true,
    },
  });
  await s3Client.send(publicAccessBlockCommand);
  log.info(`Configured public access block for bucket: ${bucketName}`);

  // Get tags and attach them to the bucket
  const taggingCommand = new PutBucketTaggingCommand({
    Bucket: bucketName,
    Tagging: {
      TagSet: await getBucketTags(ssmClient, log),
    },
  });
  await s3Client.send(taggingCommand);
  log.info(`Added tags to bucket: ${bucketName}`);
}

/**
 * Creates IAM policy for CDN logs bucket access
 * @param {IAMClient} iamClient - The IAM client
 * @param {string} bucketName - The bucket name
 * @param {object} log - Logger instance
 * @returns {Promise<string>} The policy ARN
 */
async function createBucketAccessPolicy(iamClient, bucketName, log) {
  const policyName = `${bucketName}-s3-writer`;
  const policyDocument = {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'CDNLogsBucketAccess',
        Effect: 'Allow',
        Action: ['s3:ListBucket'],
        Resource: `arn:aws:s3:::${bucketName}`,
      },
      {
        Sid: 'CDNLogsObjectAccess',
        Effect: 'Allow',
        Action: ['s3:GetObject', 's3:PutObject', 's3:AbortMultipartUpload'],
        Resource: `arn:aws:s3:::${bucketName}/*`,
      },
    ],
  };

  const createPolicyCommand = new CreatePolicyCommand({
    PolicyName: policyName,
    PolicyDocument: JSON.stringify(policyDocument),
    Description: `Policy for writing CDN logs to S3 bucket ${bucketName}`,
  });

  try {
    const policyResponse = await iamClient.send(createPolicyCommand);
    log.info(`Created IAM policy for CDN logs: ${policyResponse.Policy.Arn}`);
    return policyResponse.Policy.Arn;
  } catch (error) {
    log.error('Error creating IAM policy for CDN logs:', error);
    throw error;
  }
}

/**
 * Creates IAM user for CDN logs bucket access
 * @param {IAMClient} iamClient - The IAM client
 * @param {string} bucketName - The bucket name
 * @param {string} policyArn - The policy ARN to attach
 * @param {object} log - Logger instance
 * @returns {Promise<Object>} The user details and credentials
 */
async function createBucketUser(iamClient, bucketName, policyArn, log) {
  const iamUser = `${bucketName}-s3-writer`;

  try {
    // Create the IAM user
    const createUserCommand = new CreateUserCommand({
      UserName: iamUser,
      Tags: [
        { Key: 'Name', Value: iamUser },
        { Key: 'Purpose', Value: 'CDN logs S3 access' },
        { Key: 'Bucket', Value: bucketName },
      ],
    });

    const userResponse = await iamClient.send(createUserCommand);
    log.info(`Created IAM user for CDN logs: ${userResponse.User.UserName}`);

    // Create access key for the user
    const createAccessKeyCommand = new CreateAccessKeyCommand({
      UserName: iamUser,
    });

    const accessKeyResponse = await iamClient.send(createAccessKeyCommand);
    log.info(`Created access key for CDN logs user: ${iamUser}`);

    // Attach the policy to the user
    const attachPolicyCommand = new AttachUserPolicyCommand({
      UserName: iamUser,
      PolicyArn: policyArn,
    });

    await iamClient.send(attachPolicyCommand);
    log.info(`Attached CDN logs policy ${policyArn} to user ${iamUser}`);

    return {
      iamUser,
      accessKey: accessKeyResponse.AccessKey.AccessKeyId,
      secretKey: accessKeyResponse.AccessKey.SecretAccessKey,
    };
  } catch (error) {
    log.error('Error creating IAM user for CDN logs:', error);
    throw error;
  }
}

/**
 * Stores credentials in AWS Secrets Manager
 * @param {SecretsManagerClient} secretsClient - The Secrets Manager client
 * @param {string} orgName - The organization name
 * @param {string} orgId - The organization identifier
 * @param {string} accessKey - The access key
 * @param {string} secretKey - The secret key
 * @param {object} log - Logger instance
 * @returns {Promise<Object>} The secret ARN and path
 */
async function storeCredentialsInSecretsManager(
  secretsClient,
  imsOrgName,
  imsOrgId,
  accessKey,
  secretKey,
  log,
) {
  const secretPath = generateSecretsPath(imsOrgName, imsOrgId);

  const newSecretValue = {
    CDN_LOGS_S3_ACCESS_KEY: accessKey,
    CDN_LOGS_S3_SECRET_ACCESS_KEY: secretKey,
  };

  try {
    // Try to get existing secret value
    const getSecretCommand = new GetSecretValueCommand({ SecretId: secretPath });
    const getSecretResponse = await secretsClient.send(getSecretCommand);
    const existingSecretValue = JSON.parse(getSecretResponse.SecretString);

    // Merge existing values with new values
    const mergedSecretValue = { ...existingSecretValue, ...newSecretValue };

    // Update the secret with merged values
    const updateCommand = new UpdateSecretCommand({
      SecretId: secretPath,
      SecretString: JSON.stringify(mergedSecretValue, null, 2),
    });

    const updateResponse = await secretsClient.send(updateCommand);
    log.info(`Updated CDN logs credentials in Secrets Manager: ${secretPath}`);

    return { secretArn: updateResponse.ARN, secretPath };
  } catch (error) {
    if (error.name === 'ResourceNotFoundException') {
      // Secret doesn't exist, create it
      const createCommand = new CreateSecretCommand({
        Name: secretPath,
        SecretString: JSON.stringify(newSecretValue, null, 2),
      });

      const createResponse = await secretsClient.send(createCommand);
      log.info(`Created CDN logs credentials in Secrets Manager: ${secretPath}`);

      return { secretArn: createResponse.ARN, secretPath };
    } else {
      throw error;
    }
  }
}

/**
 * Retrieves credentials from AWS Secrets Manager for an organization
 * @param {SecretsManagerClient} secretsClient - The Secrets Manager client
 * @param {string} imsOrgName - The IMS organization name
 * @param {string} imsOrgId - The IMS organization identifier
 * @param {object} log - Logger instance
 * @returns {Promise<Object>} Object containing accessKey, secretKey, secretArn, and secretPath
 */
async function getCredentialsFromSecretsManager(secretsClient, imsOrgName, imsOrgId, log) {
  const secretPath = generateSecretsPath(imsOrgName, imsOrgId);
  try {
    const getSecretCommand = new GetSecretValueCommand({
      SecretId: secretPath,
    });
    const getSecretResponse = await secretsClient.send(getSecretCommand);
    const secretValue = JSON.parse(getSecretResponse.SecretString);
    log.info(`Retrieved CDN logs credentials from Secrets Manager: ${secretPath}`);
    return {
      accessKey: secretValue.CDN_LOGS_S3_ACCESS_KEY,
      secretKey: secretValue.CDN_LOGS_S3_SECRET_ACCESS_KEY,
      secretArn: getSecretResponse.ARN,
      secretPath,
    };
  } catch (error) {
    if (error.name === 'ResourceNotFoundException') {
      const notFoundError = new Error(`No CDN logs credentials found for organization: ${imsOrgName}`);
      notFoundError.name = 'ResourceNotFoundException';
      throw notFoundError;
    }
    throw error;
  }
}

/**
 * Provisions complete CDN logs infrastructure for an organization
 * Creates S3 bucket, IAM policy/user, and stores credentials in Secrets Manager
 * @param {string} imsOrgName - The IMS organization name
 * @param {string} imsOrgId - The IMS organization identifier
 * @param {string} region - AWS region
 * @param {object} log - Logger instance
 * @returns {Promise<Object>} Provisioning result with bucket details and credentials
 */
export async function provisionBucketForTenant(imsOrgName, imsOrgId, region, log) {
  validateOrgName(imsOrgName);
  validateOrgId(imsOrgId);

  // Generate bucket name and validate the sanitized result
  const bucketName = generateBucketName(imsOrgName, imsOrgId);
  validateBucketName(bucketName);

  log.info(`Processing CDN logs bucket for organization: ${imsOrgName} (ID: ${imsOrgId}, bucket: ${bucketName}) in region: ${region}`);

  // Initialize AWS clients
  const s3Client = new S3Client({ region });
  const ssmClient = new SSMClient({ region });
  const iamClient = new IAMClient({ region });
  const secretsClient = new SecretsManagerClient({ region });

  // Check if bucket exists
  const bucketStatus = await checkBucketExists(s3Client, bucketName, log);
  let bucketCreated = false;

  if (!bucketStatus.exists) {
    log.info(`CDN logs bucket ${bucketName} does not exist, creating it...`);
    await createBucket(s3Client, bucketName, region, log);
    await configureBucket(s3Client, ssmClient, bucketName, log);
    bucketCreated = true;
    log.info(`Successfully created and configured CDN logs bucket: ${bucketName}`);
  } else {
    log.info(`CDN logs bucket ${bucketName} already exists`);
  }

  // Check if credentials exist in Secrets Manager
  let credentials = null;
  let credentialsCreated = false;

  try {
    credentials = await getCredentialsFromSecretsManager(secretsClient, imsOrgName, imsOrgId, log);
    log.info(`Retrieved existing CDN logs credentials for organization: ${imsOrgName}`);
  } catch (error) {
    if (error.name === 'ResourceNotFoundException') {
      log.info(`No CDN logs credentials found for organization: ${imsOrgName}, creating new ones...`);

      try {
        // Create IAM policy and user for the bucket
        const policyArn = await createBucketAccessPolicy(iamClient, bucketName, log);
        const { accessKey, secretKey } = await createBucketUser(
          iamClient,
          bucketName,
          policyArn,
          log,
        );

        // Store credentials in Secrets Manager
        const { secretArn, secretPath } = await storeCredentialsInSecretsManager(
          secretsClient,
          imsOrgName,
          imsOrgId,
          accessKey,
          secretKey,
          log,
        );

        credentials = {
          accessKey,
          secretKey,
          secretArn,
          secretPath,
        };
        credentialsCreated = true;
      } catch (iamError) {
        log.warn('Could not create IAM policy/user or store CDN logs credentials:', iamError.message);
        throw new Error(`Failed to create CDN logs credentials: ${iamError.message}`);
      }
    } else {
      throw error;
    }
  }

  // Determine the appropriate message based on what was created
  let message;
  if (bucketCreated && credentialsCreated) {
    message = `Successfully created CDN logs bucket and credentials for organization: ${imsOrgName} (ID: ${imsOrgId})`;
  } else if (bucketCreated) {
    message = `Successfully created CDN logs bucket for organization: ${imsOrgName} (ID: ${imsOrgId}). Credentials already existed.`;
  } else if (credentialsCreated) {
    message = `Retrieved existing CDN logs bucket for organization: ${imsOrgName} (ID: ${imsOrgId}). Successfully created new credentials.`;
  } else {
    message = `Retrieved existing CDN logs bucket and credentials for organization: ${imsOrgName} (ID: ${imsOrgId})`;
  }

  return {
    message,
    imsOrgName,
    imsOrgId,
    bucketName,
    bucketArn: `arn:aws:s3:::${bucketName}`,
    bucketExists: !bucketCreated,
    credentials,
  };
}
/* c8 ignore end */
