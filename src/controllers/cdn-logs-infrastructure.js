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
import crypto from 'crypto';
import {
  ok,
  badRequest,
  internalServerError,
  forbidden,
} from '@adobe/spacecat-shared-http-utils';
import { isNonEmptyObject } from '@adobe/spacecat-shared-utils';
import AccessControlUtil from '../support/access-control-util.js';

function CdnLogsInfrastructureController(ctx, log) {
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }

  if (!isNonEmptyObject(ctx.env)) {
    throw new Error('Environment object required');
  }

  // Extract environment and AWS clients from context
  const {
    env, s3, ssm, iam, secrets,
  } = ctx;
  const accessControlUtil = AccessControlUtil.fromContext(ctx);

  // Destructure AWS clients and commands from context
  const {
    s3Client,
    HeadBucketCommand,
    CreateBucketCommand,
    PutBucketEncryptionCommand,
    PutPublicAccessBlockCommand,
    PutBucketTaggingCommand,
  } = s3;
  const {
    ssmClient,
    GetParameterCommand,
  } = ssm;
  const {
    iamClient,
    CreatePolicyCommand,
    CreateUserCommand,
    CreateAccessKeyCommand,
    AttachUserPolicyCommand,
  } = iam;
  const {
    secretsClient,
    CreateSecretCommand,
    UpdateSecretCommand,
    GetSecretValueCommand,
    TagResourceCommand,
  } = secrets;

  // Helper functions (defined first to avoid hoisting issues)
  function validateOrgName(orgName) {
    if (!/^[a-zA-Z0-9\s]+$/.test(orgName)) {
      return badRequest(
        `Organization name must contain only alphanumeric characters and spaces. Got: ${orgName}`,
      );
    }

    return null;
  }

  function validateOrgId(orgId) {
    if (!orgId) {
      return badRequest('Organization identifier is required');
    }

    if (!/^[a-zA-Z0-9]+(@AdobeOrg)?$/.test(orgId)) {
      return badRequest(
        `Organization identifier must contain only alphanumeric characters and optionally end with @AdobeOrg. Got: ${orgId}`,
      );
    }
    return null;
  }

  function generateBucketName(orgId) {
    const hash = crypto.createHash('sha256').update(orgId).digest('hex');
    const hashSuffix = hash.substring(0, 16);
    return `cdn-logs-${hashSuffix}`;
  }

  function generateSecretsPath(orgId) {
    return `/helix-deploy/spacecat-services/customer-secrets/${orgId}/latest`;
  }

  async function checkBucketExists(bucketName) {
    try {
      await s3Client.send(new HeadBucketCommand({ Bucket: bucketName }));
      log.info(`S3 bucket '${bucketName}' already exists`);
      return {
        exists: true,
        inDifferentRegion: false,
        bucketName,
        bucketArn: `arn:aws:s3:::${bucketName}`,
        message: `Bucket ${bucketName} already exists`,
      };
    } catch (error) {
      if (error.name === 'NotFound') {
        log.info(`S3 bucket '${bucketName}' does not exist, proceeding with creation`);
        return {
          exists: false,
          inDifferentRegion: false,
          bucketName,
          bucketArn: `arn:aws:s3:::${bucketName}`,
          message: `Bucket ${bucketName} does not exist`,
        };
      } else if (error.name === 'Forbidden' || error.$metadata?.httpStatusCode === 403) {
        throw new Error(`Bucket ${bucketName} already exists in a different AWS region`);
      } else {
        log.error(`Failed to check bucket existence for bucket '${bucketName}': ${error.message}`, error);
        throw error;
      }
    }
  }

  async function createS3Bucket(bucketName, region) {
    try {
      const createBucketCommand = new CreateBucketCommand({
        Bucket: bucketName,
        CreateBucketConfiguration: {
          // us-east-1 is the default region and must be undefined in the constraint
          LocationConstraint: region === 'us-east-1' ? undefined : region,
        },
      });

      log.info(
        `Creating S3 bucket '${bucketName}' with configuration:`,
        JSON.stringify(createBucketCommand.input, null, 2),
      );

      await s3Client.send(createBucketCommand);
      log.info(`Successfully created S3 bucket '${bucketName}'`);
    } catch (error) {
      log.error(`Failed to create S3 bucket '${bucketName}': ${error.message}`, error);
      throw error;
    }
  }

  async function getAdobeTags() {
    try {
      const ssmCommand = new GetParameterCommand({
        Name: '/spacecat/adobe-tags',
      });

      const ssmResponse = await ssmClient.send(ssmCommand);
      const adobeTags = JSON.parse(ssmResponse.Parameter.Value);
      log.info('Successfully retrieved Adobe tags from SSM');
      return adobeTags;
    } catch (error) {
      log.error(`Failed to retrieve Adobe tags from SSM: ${error.message}`, error);
      throw error;
    }
  }

  function generateOrgTags(orgId, orgName) {
    const tagSet = [
      {
        Key: 'Adobe.OrgId',
        Value: orgId,
      },
    ];

    if (orgName) {
      tagSet.push({
        Key: 'Adobe.OrgName',
        Value: orgName,
      });
    }

    return tagSet;
  }

  function generateAdobeTags(adobeTags) {
    const tagSet = [];

    if (adobeTags.Adobe_ArchPath) {
      tagSet.push({ Key: 'Adobe.ArchPath', Value: adobeTags.Adobe_ArchPath });
    }
    if (adobeTags.Adobe_CostCenter) {
      tagSet.push({
        Key: 'Adobe.CostCenter',
        Value: adobeTags.Adobe_CostCenter.toString(),
      });
    }
    if (adobeTags.Adobe_DataClassification) {
      tagSet.push({
        Key: 'Adobe.DataClassification',
        Value: adobeTags.Adobe_DataClassification,
      });
    }
    if (adobeTags.Adobe_Environment) {
      tagSet.push({
        Key: 'Adobe.Environment',
        Value: adobeTags.Adobe_Environment,
      });
    }
    if (adobeTags.Adobe_Owner) {
      tagSet.push({ Key: 'Adobe.Owner', Value: adobeTags.Adobe_Owner });
    }
    if (adobeTags.Adobe_PCIData !== undefined) {
      tagSet.push({
        Key: 'Adobe.PCIData',
        Value: adobeTags.Adobe_PCIData.toString(),
      });
    }

    return tagSet;
  }

  async function getBucketTags(orgId, orgName) {
    const adobeTags = await getAdobeTags();

    const tagSet = [
      {
        Key: 'CreatedBy',
        Value: 'S3-Provisioner-API',
      },
      {
        Key: 'CreatedDate',
        Value: new Date().toISOString(),
      },
      {
        Key: 'Adobe.VersioningNotRequired',
        Value: 'true',
      },
      ...generateOrgTags(orgId, orgName),
      ...generateAdobeTags(adobeTags),
    ];

    return tagSet;
  }

  async function configureBucket(bucketName, orgId, orgName) {
    try {
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
      log.info(`Successfully enabled encryption for S3 bucket '${bucketName}'`);

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
      log.info(`Successfully configured public access block for S3 bucket '${bucketName}'`);

      const taggingCommand = new PutBucketTaggingCommand({
        Bucket: bucketName,
        Tagging: {
          TagSet: await getBucketTags(orgId, orgName),
        },
      });

      await s3Client.send(taggingCommand);
      log.info(`Successfully added tags to S3 bucket '${bucketName}'`);
    } catch (error) {
      log.error(`Failed to configure S3 bucket '${bucketName}': ${error.message}`, error);
      throw error;
    }
  }

  async function addTagsToSecret(secretPath, orgName, orgId) {
    try {
      const adobeTags = await getAdobeTags();

      const tagSet = [
        ...generateOrgTags(orgId, orgName),
        ...generateAdobeTags(adobeTags),
      ];

      const tagCommand = new TagResourceCommand({
        SecretId: secretPath,
        Tags: tagSet,
      });

      await secretsClient.send(tagCommand);
      log.info(`Successfully added tags to secret '${secretPath}'`);
    } catch (error) {
      log.error(`Failed to add tags to secret '${secretPath}': ${error.message}`, error);
      throw error;
    }
  }

  async function storeCredentialsInSecretsManager(orgName, orgId, accessKey, secretKey) {
    const secretPath = generateSecretsPath(orgId);

    const newSecretValue = {
      CDN_LOGS_S3_ACCESS_KEY: accessKey,
      CDN_LOGS_S3_SECRET_ACCESS_KEY: secretKey,
    };

    try {
      const getSecretCommand = new GetSecretValueCommand({
        SecretId: secretPath,
      });

      const getSecretResponse = await secretsClient.send(getSecretCommand);
      let existingSecretValue = {};

      try {
        existingSecretValue = JSON.parse(getSecretResponse.SecretString);
      } catch (parseError) {
        throw new Error(
          `Failed to parse existing secret value for ${secretPath}: ${parseError.message}`,
        );
      }

      const mergedSecretValue = {
        ...existingSecretValue,
        ...newSecretValue,
      };

      const updateCommand = new UpdateSecretCommand({
        SecretId: secretPath,
        SecretString: JSON.stringify(mergedSecretValue, null, 2),
      });

      const updateResponse = await secretsClient.send(updateCommand);
      log.info(`Successfully updated secret in Secrets Manager: '${secretPath}'`);

      await addTagsToSecret(secretPath, orgName, orgId);

      return {
        secretArn: updateResponse.ARN,
        secretPath,
      };
    } catch (error) {
      if (error.name === 'ResourceNotFoundException') {
        const createCommand = new CreateSecretCommand({
          Name: secretPath,
          SecretString: JSON.stringify(newSecretValue, null, 2),
        });

        const createResponse = await secretsClient.send(createCommand);
        log.info(`Successfully created secret in Secrets Manager: '${secretPath}'`);

        await addTagsToSecret(secretPath, orgName, orgId);

        return {
          secretArn: createResponse.ARN,
          secretPath,
        };
      } else {
        throw error;
      }
    }
  }

  async function getCredentialsFromSecretsManager(orgName, orgId) {
    const secretPath = generateSecretsPath(orgId);
    const notFoundError = new Error(
      `No credentials found for organization: ${orgName || orgId}`,
    );
    notFoundError.name = 'ResourceNotFoundException';

    try {
      const getSecretCommand = new GetSecretValueCommand({
        SecretId: secretPath,
      });
      const getSecretResponse = await secretsClient.send(getSecretCommand);
      const secretValue = JSON.parse(getSecretResponse.SecretString);
      log.info(`Successfully retrieved secret from Secrets Manager: '${secretPath}'`);

      if (!secretValue.CDN_LOGS_S3_ACCESS_KEY || !secretValue.CDN_LOGS_S3_SECRET_ACCESS_KEY) {
        throw notFoundError;
      }

      return {
        accessKey: secretValue.CDN_LOGS_S3_ACCESS_KEY,
        secretKey: secretValue.CDN_LOGS_S3_SECRET_ACCESS_KEY,
        secretArn: getSecretResponse.ARN,
        secretPath,
      };
    } catch (error) {
      if (error.name === 'ResourceNotFoundException') {
        throw notFoundError;
      }
      throw error;
    }
  }

  async function createBucketAccessPolicy(bucketName) {
    const suffix = 'write-access';
    const policyName = `${bucketName}-${suffix}`;

    try {
      log.info(`Creating IAM policy '${policyName}' for bucket access`);

      const policyDocument = {
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'S3RawFolderAccess',
            Effect: 'Allow',
            Action: ['s3:ListBucket'],
            Resource: `arn:aws:s3:::${bucketName}`,
            Condition: {
              StringLike: {
                's3:prefix': 'raw/',
              },
            },
          },
          {
            Sid: 'S3RawFolderObjectAccess',
            Effect: 'Allow',
            Action: ['s3:GetObject', 's3:PutObject', 's3:AbortMultipartUpload'],
            Resource: `arn:aws:s3:::${bucketName}/raw/*`,
          },
        ],
      };

      const createPolicyCommand = new CreatePolicyCommand({
        PolicyName: policyName,
        PolicyDocument: JSON.stringify(policyDocument),
        Description: `Policy for writing to S3 bucket ${bucketName}`,
      });

      const policyResponse = await iamClient.send(createPolicyCommand);
      log.info(`Successfully created IAM policy: '${policyResponse.Policy.Arn}'`);

      return {
        policyArn: policyResponse.Policy.Arn,
      };
    } catch (error) {
      log.error(`Failed to create IAM policy '${policyName}': ${error.message}`, error);
      throw error;
    }
  }

  async function createBucketUser(bucketName, policyArn) {
    const suffix = 'writer';
    const iamUserName = `${bucketName}-${suffix}`;

    try {
      log.info(`Creating IAM user '${iamUserName}' for bucket access`);

      const createUserCommand = new CreateUserCommand({
        UserName: iamUserName,
        Tags: [
          {
            Key: 'Name',
            Value: iamUserName,
          },
          {
            Key: 'Purpose',
            Value: 'S3 bucket access',
          },
          {
            Key: 'Bucket',
            Value: bucketName,
          },
        ],
      });

      const userResponse = await iamClient.send(createUserCommand);
      log.info(`Successfully created IAM user: '${userResponse.User.UserName}'`);

      const createAccessKeyCommand = new CreateAccessKeyCommand({
        UserName: iamUserName,
      });

      const accessKeyResponse = await iamClient.send(createAccessKeyCommand);
      log.info(`Successfully created access key for IAM user: '${iamUserName}'`);

      const attachPolicyCommand = new AttachUserPolicyCommand({
        UserName: iamUserName,
        PolicyArn: policyArn,
      });

      await iamClient.send(attachPolicyCommand);
      log.info(`Successfully attached policy '${policyArn}' to IAM user '${iamUserName}'`);

      return {
        iamUser: iamUserName,
        accessKey: accessKeyResponse.AccessKey.AccessKeyId,
        secretKey: accessKeyResponse.AccessKey.SecretAccessKey,
      };
    } catch (error) {
      log.error(`Failed to create IAM user '${iamUserName}': ${error.message}`, error);
      throw error;
    }
  }

  /**
   * Provisions an S3 bucket for CDN logs with associated credentials
   * @param {object} context - Context of the request
   * @returns {Promise<Response>} Response with bucket and credential information
   */
  const provisionBucket = async (context) => {
    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Only admins can create CDN log buckets');
    }

    const { data } = context;

    if (!data) {
      return badRequest('Request body is required');
    }

    const { orgId, orgName } = data;
    const region = env.AWS_REGION || 'us-east-1';

    try {
      const orgIdValidation = validateOrgId(orgId);
      if (orgIdValidation) {
        return orgIdValidation;
      }

      if (orgName) {
        const orgNameValidation = validateOrgName(orgName);
        if (orgNameValidation) {
          return orgNameValidation;
        }
      }

      const bucketName = generateBucketName(orgId);

      log.info(
        `Processing S3 bucket for organization: ${orgName || 'N/A'} (ID: ${orgId}, bucket: ${bucketName}) in region: ${region}`,
      );

      const bucketStatus = await checkBucketExists(bucketName);
      let bucketCreated = false;

      if (!bucketStatus.exists) {
        log.info(`S3 bucket '${bucketName}' does not exist, creating it...`);
        await createS3Bucket(bucketName, region);
        await configureBucket(bucketName, orgId, orgName);
        bucketCreated = true;
        log.info(`Successfully created and configured S3 bucket: '${bucketName}'`);
      } else {
        log.info(`S3 bucket '${bucketName}' already exists`);
      }

      let credentials = null;
      let credentialsCreated = false;

      try {
        credentials = await getCredentialsFromSecretsManager(orgName, orgId);
        log.info(`Successfully retrieved existing credentials for organization: '${orgName || orgId}'`);
      } catch (error) {
        if (error.name === 'ResourceNotFoundException') {
          log.info(
            `No credentials found for organization: '${orgName || orgId}', creating new ones...`,
          );

          let policyArn = null;
          let accessKey = null;
          let secretKey = null;

          try {
            const policyResult = await createBucketAccessPolicy(bucketName);
            policyArn = policyResult.policyArn;
            log.info(`Successfully created IAM policy for S3 bucket: '${bucketName}'`);

            const userResult = await createBucketUser(bucketName, policyArn);
            accessKey = userResult.accessKey;
            secretKey = userResult.secretKey;
            log.info(`Successfully created IAM user for S3 bucket: '${bucketName}'`);

            const secretsResult = await storeCredentialsInSecretsManager(
              orgName,
              orgId,
              accessKey,
              secretKey,
            );
            log.info(`Successfully stored credentials in Secrets Manager: '${secretsResult.secretPath}'`);

            credentials = {
              accessKey,
              secretKey,
            };
            credentialsCreated = true;
          } catch (iamError) {
            log.warn(`Failed to create IAM credentials for bucket '${bucketName}': ${iamError.message}`, iamError);
            throw new Error(`Failed to create credentials: ${iamError.message}`);
          }
        } else {
          throw error;
        }
      }

      // Determine the appropriate message based on what was created
      let message;
      if (bucketCreated && credentialsCreated) {
        message = `Successfully created S3 bucket and credentials for organization: ${orgName || orgId} (ID: ${orgId})`;
      } else if (credentialsCreated) {
        message = `Retrieved existing S3 bucket for organization: ${orgName || orgId} (ID: ${orgId}). Successfully created new credentials.`;
      } else {
        message = `Retrieved existing S3 bucket and credentials for organization: ${orgName || orgId} (ID: ${orgId})`;
      }

      return ok({
        message,
        bucketName,
        accessKey: credentials.accessKey,
        secretKey: credentials.secretKey,
        region,
      });
    } catch (error) {
      log.error(`Failed to provision CDN logs bucket for organization '${orgName || orgId}': ${error.message}`, error);
      return internalServerError(error.message);
    }
  };

  return {
    provisionBucket,
  };
}

export default CdnLogsInfrastructureController;
