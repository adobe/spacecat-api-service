import { S3Client, CreateBucketCommand, PutBucketEncryptionCommand, PutPublicAccessBlockCommand, PutBucketTaggingCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { IAMClient, CreatePolicyCommand, CreateUserCommand, CreateAccessKeyCommand, AttachUserPolicyCommand } from '@aws-sdk/client-iam';
import { SecretsManagerClient, CreateSecretCommand, UpdateSecretCommand, GetSecretValueCommand, TagResourceCommand } from '@aws-sdk/client-secrets-manager';
import crypto from 'crypto';
import { ok, badRequest, internalServerError, forbidden } from '@adobe/spacecat-shared-http-utils';
import { isNonEmptyObject } from '@adobe/spacecat-shared-utils';
import AccessControlUtil from '../support/access-control-util.js';

// AWS S3 resource naming limits
const BUCKET_NAME_MAX_LEN = 63;
const IAM_POLICY_NAME_MAX_LEN = 128;
const IAM_USER_NAME_MAX_LEN = 64;

function CdnLogsController(ctx, log, env) {
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }

  const { dataAccess } = ctx;
  if (!isNonEmptyObject(dataAccess)) {
    throw new Error('Data access required');
  }

  if (!isNonEmptyObject(env)) {
    throw new Error('Environment object required');
  }

  const accessControlUtil = AccessControlUtil.fromContext(ctx);

  // Initialize AWS clients
  const s3Client = new S3Client({ region: env.AWS_REGION || 'us-east-1' });
  const ssmClient = new SSMClient({ region: env.AWS_REGION || 'us-east-1' });
  const iamClient = new IAMClient({ region: env.AWS_REGION || 'us-east-1' });
  const secretsClient = new SecretsManagerClient({ region: env.AWS_REGION || 'us-east-1' });

  /**
   * Creates or retrieves an S3 bucket for CDN logs with associated credentials
   * @param {object} context - Context of the request
   * @returns {Promise<Response>} Response with bucket and credential information
   */
  const provisionBucket = async (context) => {
    // Check admin access
    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Only admins can create CDN log buckets');
    }

    const { data } = context;
    
    if (!data) {
      return badRequest('Request body is required');
    }

    const { org_id, org_name } = data;

    try {
      // Validate inputs
      validateOrgId(org_id);
      if (org_name) {
        validateOrgName(org_name);
      }

      // Generate bucket name and validate
      const bucketName = generateBucketName(org_id);
      validateBucketName(bucketName);

      log.info(`Processing S3 bucket for organization: ${org_name || 'N/A'} (ID: ${org_id}, bucket: ${bucketName}) in region: ${env.AWS_REGION || 'us-east-1'}`);

      // Check if bucket exists
      const bucketStatus = await checkBucketExists(bucketName);
      let bucketCreated = false;

      if (!bucketStatus.exists) {
        log.info(`Bucket ${bucketName} does not exist, creating it...`);
        const region = env.AWS_REGION || 'us-east-1';
        await createBucket(bucketName, region);
        await configureBucket(bucketName, org_id, org_name);
        bucketCreated = true;
        log.info(`Successfully created and configured bucket: ${bucketName}`);
      } else {
        log.info(`Bucket ${bucketName} already exists`);
      }

      // Check if credentials exist in Secrets Manager
      let credentials = null;
      let credentialsCreated = false;

      try {
        credentials = await getCredentialsFromSecretsManager(org_name, org_id);
        log.info(`Retrieved existing credentials for organization: ${org_name || org_id}`);
      } catch (error) {
        if (error.name === 'ResourceNotFoundException') {
          log.info(`No credentials found for organization: ${org_name || org_id}, creating new ones...`);

          // Create IAM policy and user for the bucket
          let policyArn = null;
          let iamUser = null;
          let accessKey = null;
          let secretKey = null;

          try {
            const policyResult = await createBucketAccessPolicy(bucketName);
            policyArn = policyResult.policyArn;
            log.info(`Created IAM policy for bucket: ${bucketName}`);

            // Create IAM user and attach policy
            const userResult = await createBucketUser(bucketName, policyArn);
            iamUser = userResult.iamUser;
            accessKey = userResult.accessKey;
            secretKey = userResult.secretKey;
            log.info(`Created IAM user for bucket: ${bucketName}`);

            // Store credentials in Secrets Manager
            const secretsResult = await storeCredentialsInSecretsManager(org_name, org_id, accessKey, secretKey);
            log.info(`Stored credentials in Secrets Manager: ${secretsResult.secretPath}`);

            credentials = {
              accessKey: accessKey,
              secretKey: secretKey
            };
            credentialsCreated = true;

          } catch (iamError) {
            log.warn('Could not create IAM policy/user or store secrets:', iamError.message);
            throw new Error(`Failed to create credentials: ${iamError.message}`);
          }
        } else {
          throw error;
        }
      }

      // Determine the appropriate message based on what was created
      let message;
      if (bucketCreated && credentialsCreated) {
        message = `Successfully created S3 bucket and credentials for organization: ${org_name || org_id} (ID: ${org_id})`;
      } else if (bucketCreated) {
        message = `Successfully created S3 bucket for organization: ${org_name || org_id} (ID: ${org_id}). Credentials already existed.`;
      } else if (credentialsCreated) {
        message = `Retrieved existing S3 bucket for organization: ${org_name || org_id} (ID: ${org_id}). Successfully created new credentials.`;
      } else {
        message = `Retrieved existing S3 bucket and credentials for organization: ${org_name || org_id} (ID: ${org_id})`;
      }

      return ok({
        message: message,
        bucketName: bucketName,
        accessKey: credentials?.accessKey || null,
        secretKey: credentials?.secretKey || null,
        region: env.AWS_REGION || 'us-east-1'
      });

    } catch (error) {
      log.error(`Error creating CDN logs bucket: ${error.message}`, error);
      return internalServerError(error.message);
    }
  };

  // Helper functions (converted from the Lambda)
  function validateOrgName(orgName) {
    if (!orgName) {
      throw new Error('Organization name is required');
    }
    
    if (orgName.length > 256) {
      throw new Error('Organization name cannot exceed 256 characters');
    }
  }

  function validateOrgId(orgId) {
    if (!orgId) {
      throw new Error('Organization identifier is required');
    }
    
    if (!/^[a-zA-Z0-9]+(@AdobeOrg)?$/.test(orgId)) {
      throw new Error(`Organization identifier must contain only letters, numbers, and optionally end with @AdobeOrg. Got: ${orgId}`);
    }
  }

  function generateBucketName(orgId) {
    const hash = crypto.createHash('sha256').update(orgId).digest('hex');
    const hashSuffix = hash.substring(0, 16);
    return `cdn-logs-${hashSuffix}`;
  }

  function generateSecretsPath(orgId) {
    return `/helix-deploy/spacecat-services/customer-secrets/${orgId}/latest`;
  }

  function toAwsSafeName(value) {
    return value.toLowerCase()
      .replace(/@adobeorg$/i, '')
      .replace(/[\s.]+/g, '-');
  }

  function validateAwsResourceNameLength(resourceName, maxLength) {
    if (resourceName.length > maxLength) {
      throw new Error(
        `Resource name '${resourceName}' exceeds maximum length of ${maxLength} characters. ` +
        `Current length: ${resourceName.length} characters.`
      );
    }
  }

  function validateAwsName(value, name) {
    if (!value) {
      throw new Error(`${name} is required`);
    }
    
    if (!/^[a-z0-9.-]+$/.test(value)) {
      throw new Error(`${name} must contain only lowercase letters, numbers, dots, and hyphens. Got: ${value}`);
    }
    
    if (!/^[a-z0-9].*[a-z0-9]$/.test(value)) {
      throw new Error(`${name} must start and end with a letter or number. Got: ${value}`);
    }
  }

  function validateBucketName(bucketName) {
    if (!bucketName) {
      throw new Error('bucketName is required');
    }
    
    validateAwsName(bucketName, 'Bucket name');
    validateAwsResourceNameLength(bucketName, BUCKET_NAME_MAX_LEN);
  }

  async function checkBucketExists(bucketName) {
    try {
      await s3Client.send(new HeadBucketCommand({ Bucket: bucketName }));
      log.info(`Bucket ${bucketName} already exists`);
      return {
        exists: true,
        inDifferentRegion: false,
        bucketName: bucketName,
        bucketArn: `arn:aws:s3:::${bucketName}`,
        message: `Bucket ${bucketName} already exists`
      };
    } catch (error) {
      if (error.name === 'NotFound' || error.name === 'NoSuchBucket') {
        log.info(`Bucket ${bucketName} does not exist, proceeding with creation`);
        return { 
          exists: false, 
          inDifferentRegion: false,
          bucketName: bucketName,
          bucketArn: `arn:aws:s3:::${bucketName}`,
          message: `Bucket ${bucketName} does not exist`
        };
      } else if (error.name === 'Forbidden' || error.$metadata?.httpStatusCode === 403) {
        log.info(`Bucket ${bucketName} exists in a different region`);
        return {
          exists: true,
          inDifferentRegion: true,
          bucketName: bucketName,
          bucketArn: `arn:aws:s3:::${bucketName}`,
          message: `Bucket ${bucketName} already exists in a different AWS region`
        };
      } else {
        log.error(`Error checking bucket existence: ${error.message}`, error);
        throw error;
      }
    }
  }

  async function createBucket(bucketName, region) {
    const createBucketCommand = new CreateBucketCommand({
      Bucket: bucketName,
      CreateBucketConfiguration: {
        LocationConstraint: region === 'us-east-1' ? undefined : region
      }
    });
    
    log.info('Sending CreateBucketCommand with configuration:', JSON.stringify(createBucketCommand.input, null, 2));
    
    try {
      await s3Client.send(createBucketCommand);
      log.info(`Successfully created bucket: ${bucketName}`);
    } catch (error) {
      log.error(`Error creating bucket: ${error.message}`, error);
      throw error;
    }
  }

  async function configureBucket(bucketName, orgId, orgName) {
    // Configure bucket encryption
    const encryptionCommand = new PutBucketEncryptionCommand({
      Bucket: bucketName,
      ServerSideEncryptionConfiguration: {
        Rules: [
          {
            ApplyServerSideEncryptionByDefault: {
              SSEAlgorithm: 'AES256'
            },
            BucketKeyEnabled: true
          }
        ]
      }
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
        RestrictPublicBuckets: true
      }
    });
    await s3Client.send(publicAccessBlockCommand);
    log.info(`Configured public access block for bucket: ${bucketName}`);
    
    // Get tags and attach them to the bucket
    const taggingCommand = new PutBucketTaggingCommand({
      Bucket: bucketName,
      Tagging: {
        TagSet: await getBucketTags(orgId, orgName)
      }
    });
    await s3Client.send(taggingCommand);
    log.info(`Added tags to bucket: ${bucketName}`);
  }

  async function getAdobeTags() {
    let adobeTags = {};
    try {
      const ssmCommand = new GetParameterCommand({
        Name: '/spacecat/adobe-tags'
      });
      const ssmResponse = await ssmClient.send(ssmCommand);
      adobeTags = JSON.parse(ssmResponse.Parameter.Value);
      log.info('Retrieved Adobe tags from SSM');
    } catch (error) {
      log.warn('Could not retrieve Adobe tags from SSM:', error.message);
    }
    return adobeTags;
  }

  function generateOrgTags(orgId, orgName) {
    const tagSet = [
      {
        Key: 'Adobe.OrgId',
        Value: orgId
      }
    ];
    
    if (orgName) {
      tagSet.push({
        Key: 'Adobe.OrgName',
        Value: orgName
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

  async function getBucketTags(orgId, orgName) {
    const adobeTags = await getAdobeTags();
    
    const tagSet = [
      {
        Key: 'CreatedBy',
        Value: 'S3-Provisioner-API'
      },
      {
        Key: 'CreatedDate',
        Value: new Date().toISOString()
      },
      {
        Key: 'Adobe.VersioningNotRequired',
        Value: 'true'
      },
      ...generateOrgTags(orgId, orgName),
      ...generateAdobeTags(adobeTags)
    ];
    
    return tagSet;
  }

  async function addTagsToSecret(secretPath, orgName, orgId) {
    try {
      const adobeTags = await getAdobeTags();
      
      const tagSet = [
        ...generateOrgTags(orgId, orgName),
        ...generateAdobeTags(adobeTags)
      ];
      
      const tagCommand = new TagResourceCommand({
        SecretId: secretPath,
        Tags: tagSet
      });
      
      await secretsClient.send(tagCommand);
      log.info(`Added tags to secret: ${secretPath}`);
      
    } catch (error) {
      log.warn('Could not add tags to secret:', error.message);
    }
  }

  async function storeCredentialsInSecretsManager(orgName, orgId, accessKey, secretKey) {
    const secretPath = generateSecretsPath(orgId);
    
    const newSecretValue = {
      CDN_LOGS_S3_ACCESS_KEY: accessKey,
      CDN_LOGS_S3_SECRET_ACCESS_KEY: secretKey
    };

    try {
      const getSecretCommand = new GetSecretValueCommand({
        SecretId: secretPath
      });
      
      const getSecretResponse = await secretsClient.send(getSecretCommand);
      let existingSecretValue = {};
      
      try {
        existingSecretValue = JSON.parse(getSecretResponse.SecretString);
      } catch (parseError) {
        throw new Error(`Failed to parse existing secret value for ${secretPath}: ${parseError.message}`);
      }
      
      const mergedSecretValue = {
        ...existingSecretValue,
        ...newSecretValue
      };
      
      const updateCommand = new UpdateSecretCommand({
        SecretId: secretPath,
        SecretString: JSON.stringify(mergedSecretValue, null, 2)
      });
      
      const updateResponse = await secretsClient.send(updateCommand);
      log.info(`Updated secret in Secrets Manager: ${secretPath}`);
      
      await addTagsToSecret(secretPath, orgName, orgId);
      
      return {
        secretArn: updateResponse.ARN,
        secretPath: secretPath
      };
      
    } catch (error) {
      if (error.name === 'ResourceNotFoundException') {
        const createCommand = new CreateSecretCommand({
          Name: secretPath,
          SecretString: JSON.stringify(newSecretValue, null, 2)
        });
        
        const createResponse = await secretsClient.send(createCommand);
        log.info(`Created secret in Secrets Manager: ${secretPath}`);
        
        await addTagsToSecret(secretPath, orgName, orgId);
        
        return {
          secretArn: createResponse.ARN,
          secretPath: secretPath
        };
      } else {
        throw error;
      }
    }
  }

  async function getCredentialsFromSecretsManager(orgName, orgId) {
    const secretPath = generateSecretsPath(orgId);
    try {
      const getSecretCommand = new GetSecretValueCommand({
        SecretId: secretPath
      });
      const getSecretResponse = await secretsClient.send(getSecretCommand);
      const secretValue = JSON.parse(getSecretResponse.SecretString);
      log.info(`Retrieved secret from Secrets Manager: ${secretPath}`);
      return {
        accessKey: secretValue.CDN_LOGS_S3_ACCESS_KEY,
        secretKey: secretValue.CDN_LOGS_S3_SECRET_ACCESS_KEY,
        secretArn: getSecretResponse.ARN,
        secretPath: secretPath
      };
    } catch (error) {
      if (error.name === 'ResourceNotFoundException') {
        const notFoundError = new Error(`No credentials found for organization: ${orgName || orgId}`);
        notFoundError.name = 'ResourceNotFoundException';
        throw notFoundError;
      }
      throw error;
    }
  }

  async function createBucketAccessPolicy(bucketName) {
    const suffix = 'write-access';
    const policyName = `${bucketName}-${suffix}`;
    
    validateAwsResourceNameLength(policyName, IAM_POLICY_NAME_MAX_LEN);
    
    log.info(`Creating IAM policy with name: ${policyName}`);
    
    const policyDocument = {
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "S3RawFolderAccess",
          Effect: "Allow",
          Action: [
            "s3:ListBucket"
          ],
          Resource: `arn:aws:s3:::${bucketName}`,
          Condition: {
            StringLike: {
              "s3:prefix": "raw/"
            }
          }
        },
        {
          Sid: "S3RawFolderObjectAccess",
          Effect: "Allow",
          Action: [
            "s3:GetObject",
            "s3:PutObject",
            "s3:AbortMultipartUpload"
          ],
          Resource: `arn:aws:s3:::${bucketName}/raw/*`
        }
      ]
    };

    try {
      const createPolicyCommand = new CreatePolicyCommand({
        PolicyName: policyName,
        PolicyDocument: JSON.stringify(policyDocument),
        Description: `Policy for writing to S3 bucket ${bucketName}`
      });
      
      const policyResponse = await iamClient.send(createPolicyCommand);
      log.info(`Created IAM policy: ${policyResponse.Policy.Arn}`);
      
      return {
        policyArn: policyResponse.Policy.Arn
      };
      
    } catch (error) {
      log.error(`Error creating IAM policy: ${error.message}`, error);
      throw error;
    }
  }

  async function createBucketUser(bucketName, policyArn) {
    const suffix = 'writer';
    const iamUser = `${bucketName}-${suffix}`;
    
    validateAwsResourceNameLength(iamUser, IAM_USER_NAME_MAX_LEN);
    
    log.info(`Creating IAM user with name: ${iamUser}`);
    
    try {
      const createUserCommand = new CreateUserCommand({
        UserName: iamUser,
        Tags: [
          {
            Key: 'Name',
            Value: iamUser
          },
          {
            Key: 'Purpose',
            Value: 'S3 bucket access'
          },
          {
            Key: 'Bucket',
            Value: bucketName
          }
        ]
      });
      
      const userResponse = await iamClient.send(createUserCommand);
      log.info(`Created IAM user: ${userResponse.User.UserName}`);
      
      const createAccessKeyCommand = new CreateAccessKeyCommand({
        UserName: iamUser
      });
      
      const accessKeyResponse = await iamClient.send(createAccessKeyCommand);
      log.info(`Created access key for user: ${iamUser}`);
      
      const attachPolicyCommand = new AttachUserPolicyCommand({
        UserName: iamUser,
        PolicyArn: policyArn
      });
      
      await iamClient.send(attachPolicyCommand);
      log.info(`Attached policy ${policyArn} to user ${iamUser}`);
      
      return {
        iamUser: iamUser,
        accessKey: accessKeyResponse.AccessKey.AccessKeyId,
        secretKey: accessKeyResponse.AccessKey.SecretAccessKey
      };
      
    } catch (error) {
      log.error(`Error creating IAM user: ${error.message}`, error);
      throw error;
    }
  }

  return {
    provisionBucket,
  };
}

export default CdnLogsController;