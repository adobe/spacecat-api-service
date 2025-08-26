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

/* eslint-env mocha */

import { expect } from 'chai';
import sinon from 'sinon';
import AuthInfo from '@adobe/spacecat-shared-http-utils/src/auth/auth-info.js';
import CdnLogsInfrastructureController from '../../src/controllers/cdn-logs-infrastructure.js';

describe('CdnLogsInfrastructureController', () => {
  let sandbox;
  let controller;
  let mockContext;
  let mockLog;

  beforeEach(() => {
    sandbox = sinon.createSandbox();

    /*
     * Default mock configuration for testing the happy path scenario.
     * Individual tests override specific behaviors using sandbox.stub() methods
     * to test error conditions and edge cases.
     */
    mockContext = {
      attributes: {
        authInfo: new AuthInfo()
          .withScopes([{ name: 'admin' }])
          .withProfile({ is_admin: true })
          .withAuthenticated(true),
      },
      env: { foo: 'bar' },
      dataAccess: {},
      s3: {
        s3Client: {
          send: sandbox.stub(),
        },
        HeadBucketCommand: sandbox.stub(),
        CreateBucketCommand: sandbox.stub(),
        PutBucketEncryptionCommand: sandbox.stub(),
        PutPublicAccessBlockCommand: sandbox.stub(),
        PutBucketTaggingCommand: sandbox.stub(),
      },
      ssm: {
        ssmClient: {
          send: sandbox.stub(),
        },
        GetParameterCommand: sandbox.stub(),
      },
      iam: {
        iamClient: {
          send: sandbox.stub(),
        },
        CreatePolicyCommand: sandbox.stub(),
        CreateUserCommand: sandbox.stub(),
        CreateAccessKeyCommand: sandbox.stub(),
        AttachUserPolicyCommand: sandbox.stub(),
      },
      secrets: {
        secretsClient: {
          send: sandbox.stub(),
        },
        CreateSecretCommand: sandbox.stub(),
        UpdateSecretCommand: sandbox.stub(),
        GetSecretValueCommand: sandbox.stub(),
        TagResourceCommand: sandbox.stub(),
      },
    };

    mockContext.s3.HeadBucketCommand.returns({ input: { Bucket: sinon.match.string }, name: 'HeadBucketCommand' });
    mockContext.s3.CreateBucketCommand.returns({ input: { Bucket: sinon.match.string }, name: 'CreateBucketCommand' });
    mockContext.s3.PutBucketEncryptionCommand.returns({ input: { Bucket: sinon.match.string }, name: 'PutBucketEncryptionCommand' });
    mockContext.s3.PutPublicAccessBlockCommand.returns({ input: { Bucket: sinon.match.string }, name: 'PutPublicAccessBlockCommand' });
    mockContext.s3.PutBucketTaggingCommand.returns({ input: { Bucket: sinon.match.string }, name: 'PutBucketTaggingCommand' });

    mockContext.s3.s3Client.send.withArgs(sinon.match.has('name', 'HeadBucketCommand')).rejects({ name: 'NotFound' });
    mockContext.s3.s3Client.send.withArgs(sinon.match.has('name', 'CreateBucketCommand')).resolves({});
    mockContext.s3.s3Client.send.withArgs(sinon.match.has('name', 'PutBucketEncryptionCommand')).resolves({});
    mockContext.s3.s3Client.send.withArgs(sinon.match.has('name', 'PutPublicAccessBlockCommand')).resolves({});
    mockContext.s3.s3Client.send.withArgs(sinon.match.has('name', 'PutBucketTaggingCommand')).resolves({});

    mockContext.ssm.GetParameterCommand.returns({ input: { Name: '/spacecat/adobe-tags' }, name: 'GetParameterCommand' });
    mockContext.ssm.ssmClient.send.withArgs(sinon.match.has('name', 'GetParameterCommand'))
      .resolves({
        Parameter: {
          Value: JSON.stringify({
            Adobe_ArchPath: 'arcpath',
            Adobe_CostCenter: 'costcenter',
            Adobe_DataClassification: 'classification',
            Adobe_Environment: 'env',
            Adobe_Owner: 'owner',
            Adobe_PCIData: 'pci',
          }),
        },
      });

    mockContext.iam.CreatePolicyCommand.returns({ input: { PolicyName: sinon.match.string }, name: 'CreatePolicyCommand' });
    mockContext.iam.CreateUserCommand.returns({ input: { UserName: sinon.match.string }, name: 'CreateUserCommand' });
    mockContext.iam.CreateAccessKeyCommand.returns({ input: { UserName: sinon.match.string }, name: 'CreateAccessKeyCommand' });
    mockContext.iam.AttachUserPolicyCommand.returns({ input: { UserName: sinon.match.string, PolicyArn: sinon.match.string }, name: 'AttachUserPolicyCommand' });

    mockContext.iam.iamClient.send.withArgs(sinon.match.has('name', 'CreatePolicyCommand'))
      .resolves({
        Policy: { Arn: 'arn:aws:iam::123456789012:policy/test-policy' },
      });
    mockContext.iam.iamClient.send.withArgs(sinon.match.has('name', 'CreateUserCommand'))
      .resolves({
        User: { UserName: 'test-user' },
      });
    mockContext.iam.iamClient.send.withArgs(sinon.match.has('name', 'CreateAccessKeyCommand'))
      .resolves({
        AccessKey: {
          AccessKeyId: 'AKIAIOSFODNN7EXAMPLE',
          SecretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        },
      });
    mockContext.iam.iamClient.send.withArgs(sinon.match.has('name', 'AttachUserPolicyCommand'))
      .resolves({});

    mockContext.secrets.GetSecretValueCommand.returns({ input: { SecretId: sinon.match.string }, name: 'GetSecretValueCommand' });
    mockContext.secrets.CreateSecretCommand.returns({ input: { SecretId: sinon.match.string }, name: 'CreateSecretCommand' });
    mockContext.secrets.UpdateSecretCommand.returns({ input: { SecretId: sinon.match.string }, name: 'UpdateSecretCommand' });
    mockContext.secrets.TagResourceCommand.returns({ input: { SecretId: sinon.match.string, Tags: sinon.match.array }, name: 'TagResourceCommand' });

    mockContext.secrets.secretsClient.send.withArgs(sinon.match.has('name', 'GetSecretValueCommand'))
      .rejects({ name: 'ResourceNotFoundException' });
    mockContext.secrets.secretsClient.send.withArgs(sinon.match.has('name', 'CreateSecretCommand'))
      .resolves({
        ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test-secret',
      });
    mockContext.secrets.secretsClient.send.withArgs(sinon.match.has('name', 'UpdateSecretCommand'))
      .resolves({
        ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test-secret',
      });
    mockContext.secrets.secretsClient.send.withArgs(sinon.match.has('name', 'TagResourceCommand'))
      .resolves({});

    mockLog = {
      info: sandbox.stub(),
      warn: sandbox.stub(),
      error: sandbox.stub(),
    };

    controller = CdnLogsInfrastructureController(mockContext, mockLog);
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('constructor', () => {
    it('should throw error when context is missing', () => {
      expect(() => CdnLogsInfrastructureController()).to.throw('Context required');
    });

    it('should throw error when env is missing', () => {
      const contextWithoutEnv = { ...mockContext };
      delete contextWithoutEnv.env;
      expect(() => CdnLogsInfrastructureController(contextWithoutEnv, mockLog)).to.throw('Environment object required');
    });

    it('should initialize successfully with valid parameters', () => {
      expect(() => CdnLogsInfrastructureController(mockContext, mockLog)).to.not.throw();
    });
  });

  describe('provisionBucket', () => {
    it('should return forbidden when user lacks admin access', async () => {
      const nonAdminContext = {
        ...mockContext,
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withScopes([])
            .withProfile({ is_admin: false })
            .withAuthenticated(true),
        },
      };

      const nonAdminController = CdnLogsInfrastructureController(nonAdminContext, mockLog);
      const context = {
        data: { orgId: 'test123' },
      };

      const result = await nonAdminController.provisionBucket(context);

      expect(result.status).to.equal(403);
      const error = await result.json();
      expect(error.message).to.include('Only admins can create CDN log buckets');
    });

    it('should return bad request when request body is missing', async () => {
      const result = await controller.provisionBucket(mockContext);

      expect(result.status).to.equal(400);
      const error = await result.json();
      expect(error.message).to.include('Request body is required');
    });

    it('should return bad request when orgId is missing', async () => {
      const context = {
        ...mockContext,
        data: { orgName: 'Test Org' },
      };

      const result = await controller.provisionBucket(context);

      expect(result.status).to.equal(400);
      const error = await result.json();
      expect(error.message).to.include('Organization identifier is required');
    });

    it('should validate organization ID format', async () => {
      const context = {
        data: { orgId: 'invalid@org@format' },
      };

      const result = await controller.provisionBucket(context);

      expect(result.status).to.equal(400);
      const error = await result.json();
      expect(error.message).to.include('Organization identifier must contain only alphanumeric characters and optionally end with @AdobeOrg');
    });

    it('should return bad request when orgName is containing characters that are not allowed', async () => {
      const context = {
        ...mockContext,
        data: { orgId: 'test123', orgName: '!!!' },
      };

      const result = await controller.provisionBucket(context);

      expect(result.status).to.equal(400);
      const error = await result.json();
      expect(error.message).to.include('Organization name must contain only alphanumeric characters and spaces');
    });

    it('should create a new bucket when it does not exist', async () => {
      const context = {
        ...mockContext,
        data: { orgId: 'test123', orgName: 'Test Org' },
      };

      const result = await controller.provisionBucket(context);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.message).to.include('Successfully created S3 bucket and credentials');
      expect(body.bucketName).to.match(/^cdn-logs-[a-f0-9]{16}$/);
      expect(body.accessKey).to.equal('AKIAIOSFODNN7EXAMPLE');
      expect(body.secretKey).to.equal('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
      expect(body.region).to.equal('us-east-1');
    });

    it('should create bucket in the specified region when provided via env', async () => {
      const contextWithRegion = {
        ...mockContext,
        env: { AWS_REGION: 'us-west-2' },
        data: { orgId: 'test123', orgName: 'Test Org' },
      };

      controller = CdnLogsInfrastructureController(contextWithRegion, mockLog);
      const result = await controller.provisionBucket(contextWithRegion);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.message).to.include('Successfully created S3 bucket and credentials');
      expect(body.bucketName).to.match(/^cdn-logs-[a-f0-9]{16}$/);
      expect(body.accessKey).to.equal('AKIAIOSFODNN7EXAMPLE');
      expect(body.secretKey).to.equal('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
      expect(body.region).to.equal('us-west-2');
    });

    it('should return existing bucket and credentials when they already exists', async () => {
      mockContext.s3.s3Client.send.withArgs(sinon.match.has('name', 'HeadBucketCommand')).resolves({});

      mockContext.secrets.secretsClient.send.withArgs(sinon.match.has('name', 'GetSecretValueCommand'))
        .resolves({
          SecretString: JSON.stringify({
            CDN_LOGS_S3_ACCESS_KEY: 'existing-key',
            CDN_LOGS_S3_SECRET_ACCESS_KEY: 'existing-secret',
          }),
          ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:existing-secret',
        });

      const context = {
        data: { orgId: 'test123' },
      };

      const result = await controller.provisionBucket(context);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.message).to.include('Retrieved existing S3 bucket and credentials');
      expect(body.bucketName).to.match(/^cdn-logs-[a-f0-9]{16}$/);
      expect(body.accessKey).to.equal('existing-key');
      expect(body.secretKey).to.equal('existing-secret');
      expect(body.region).to.equal('us-east-1');
    });

    it('should handle bucket exists in different region (forbidden)', async () => {
      mockContext.s3.s3Client.send.withArgs(sinon.match.has('name', 'HeadBucketCommand')).rejects({ name: 'Forbidden' });

      const context = {
        data: { orgId: 'test123', orgName: 'Test Org' },
      };

      const result = await controller.provisionBucket(context);

      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.match(/^Bucket cdn-logs-[a-f0-9]{16} already exists in a different AWS region.*$/);
    });

    it('should handle bucket exists in different region (403)', async () => {
      mockContext.s3.s3Client.send.withArgs(sinon.match.has('name', 'HeadBucketCommand')).rejects({ $metadata: { httpStatusCode: 403 } });

      const context = {
        data: { orgId: 'test123', orgName: 'Test Org' },
      };

      const result = await controller.provisionBucket(context);

      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.include('Bucket cdn-logs-ecd71870d1963316 already exists in a different AWS region');
    });

    it('should create new credentials when bucket exists but credentials do not by creating the secret in AWS', async () => {
      mockContext.s3.s3Client.send.withArgs(sinon.match.has('name', 'HeadBucketCommand')).resolves({});

      const context = {
        data: { orgId: 'test123' },
      };

      const result = await controller.provisionBucket(context);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.message).to.include('Retrieved existing S3 bucket for organization');
      expect(body.message).to.include('Successfully created new credentials');
      expect(body.bucketName).to.match(/^cdn-logs-[a-f0-9]{16}$/);
      expect(body.accessKey).to.equal('AKIAIOSFODNN7EXAMPLE');
      expect(body.secretKey).to.equal('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
      expect(body.region).to.equal('us-east-1');
    });

    it('should create new credentials when bucket exists but credentials do not by updating the secret in AWS', async () => {
      mockContext.s3.s3Client.send.withArgs(sinon.match.has('name', 'HeadBucketCommand')).resolves({});

      mockContext.secrets.secretsClient.send.withArgs(sinon.match.has('name', 'GetSecretValueCommand'))
        .resolves({
          SecretString: JSON.stringify({
            previous_secret: 'previous-secret',
          }),
        });

      mockContext.secrets.secretsClient.send.withArgs(sinon.match.has('name', 'UpdateSecretCommand'))
        .resolves({
          ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test-secret',
        });

      const context = {
        data: { orgId: 'test123', orgName: 'Test Org' },
      };

      const result = await controller.provisionBucket(context);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.message).to.include('Retrieved existing S3 bucket for organization');
      expect(body.message).to.include('Successfully created new credentials');
      expect(body.bucketName).to.match(/^cdn-logs-[a-f0-9]{16}$/);
      expect(body.accessKey).to.equal('AKIAIOSFODNN7EXAMPLE');
      expect(body.secretKey).to.equal('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
      expect(body.region).to.equal('us-east-1');
    });

    it('should handle s3 bucket head errors gracefully', async () => {
      mockContext.s3.s3Client.send.withArgs(sinon.match.has('name', 'HeadBucketCommand'))
        .rejects(new Error('HeadBucketCommand Error'));

      const context = {
        data: { orgId: 'test123' },
      };

      const result = await controller.provisionBucket(context);

      expect(result.status).to.equal(500);
      const error = await result.json();
      expect(error.message).to.include('HeadBucketCommand Error');
    });

    it('should handle s3 bucket creation errors gracefully', async () => {
      mockContext.s3.s3Client.send.withArgs(sinon.match.has('name', 'CreateBucketCommand'))
        .rejects(new Error('CreateBucketCommand Error'));

      const context = {
        data: { orgId: 'test123' },
      };

      const result = await controller.provisionBucket(context);

      expect(result.status).to.equal(500);
      const error = await result.json();
      expect(error.message).to.include('CreateBucketCommand Error');
    });

    it('should handle s3 bucket encryption errors gracefully', async () => {
      mockContext.s3.s3Client.send.withArgs(sinon.match.has('name', 'PutBucketEncryptionCommand'))
        .rejects(new Error('PutBucketEncryptionCommand Error'));

      const context = {
        data: { orgId: 'test123' },
      };

      const result = await controller.provisionBucket(context);

      expect(result.status).to.equal(500);
      const error = await result.json();
      expect(error.message).to.include('PutBucketEncryptionCommand Error');
    });

    it('should handle s3 public access block errors gracefully', async () => {
      mockContext.s3.s3Client.send.withArgs(sinon.match.has('name', 'PutPublicAccessBlockCommand'))
        .rejects(new Error('PutPublicAccessBlockCommand Error'));

      const context = {
        data: { orgId: 'test123' },
      };

      const result = await controller.provisionBucket(context);

      expect(result.status).to.equal(500);
      const error = await result.json();
      expect(error.message).to.include('PutPublicAccessBlockCommand Error');
    });

    it('should handle s3 bucket tagging errors gracefully', async () => {
      mockContext.s3.s3Client.send.withArgs(sinon.match.has('name', 'PutBucketTaggingCommand'))
        .rejects(new Error('PutBucketTaggingCommand Error'));

      const context = {
        data: { orgId: 'test123' },
      };

      const result = await controller.provisionBucket(context);

      expect(result.status).to.equal(500);
      const error = await result.json();
      expect(error.message).to.include('PutBucketTaggingCommand Error');
    });

    it('should handle SSM parameter retrieval errors gracefully', async () => {
      mockContext.ssm.ssmClient.send.withArgs(sinon.match.has('name', 'GetParameterCommand'))
        .rejects(new Error('AWS SSM Error'));

      const context = {
        data: { orgId: 'test123' },
      };

      const result = await controller.provisionBucket(context);

      expect(result.status).to.equal(500);
      const error = await result.json();
      expect(error.message).to.include('AWS SSM Error');
    });

    it('should handle secret parsing errors gracefully', async () => {
      mockContext.secrets.secretsClient.send.withArgs(sinon.match.has('name', 'GetSecretValueCommand'))
        .onCall(0)
        .rejects({ name: 'ResourceNotFoundException' })
        .onCall(1)
        .resolves({
          SecretString: 'invalid-json',
        });

      const context = {
        data: { orgId: 'test123' },
      };

      const result = await controller.provisionBucket(context);

      expect(result.status).to.equal(500);
      const error = await result.json();
      expect(error.message).to.include('Failed to parse existing secret value');
    });

    it('should handle policy creation errors gracefully', async () => {
      mockContext.iam.iamClient.send.withArgs(sinon.match.has('name', 'CreatePolicyCommand'))
        .rejects(new Error('CreatePolicyCommand Error'));

      const context = {
        data: { orgId: 'test123' },
      };

      const result = await controller.provisionBucket(context);

      expect(result.status).to.equal(500);
      const error = await result.json();
      expect(error.message).to.include('Failed to create credentials: CreatePolicyCommand Error');
    });

    it('should handle bucket user creation errors gracefully', async () => {
      mockContext.iam.iamClient.send.withArgs(sinon.match.has('name', 'CreateUserCommand'))
        .rejects(new Error('CreateUserCommand Error'));

      const context = {
        data: { orgId: 'test123' },
      };

      const result = await controller.provisionBucket(context);

      expect(result.status).to.equal(500);
      const error = await result.json();
      expect(error.message).to.include('Failed to create credentials: CreateUserCommand Error');
    });

    it('should handle access key creation errors gracefully', async () => {
      mockContext.iam.iamClient.send.withArgs(sinon.match.has('name', 'CreateAccessKeyCommand'))
        .rejects(new Error('CreateAccessKeyCommand Error'));

      const context = {
        data: { orgId: 'test123' },
      };

      const result = await controller.provisionBucket(context);

      expect(result.status).to.equal(500);
      const error = await result.json();
      expect(error.message).to.include('Failed to create credentials: CreateAccessKeyCommand Error');
    });

    it('should handle user policy attachment errors gracefully', async () => {
      mockContext.iam.iamClient.send.withArgs(sinon.match.has('name', 'AttachUserPolicyCommand'))
        .rejects(new Error('AttachUserPolicyCommand Error'));

      const context = {
        data: { orgId: 'test123' },
      };

      const result = await controller.provisionBucket(context);

      expect(result.status).to.equal(500);
      const error = await result.json();
      expect(error.message).to.include('Failed to create credentials: AttachUserPolicyCommand Error');
    });

    it('should handle secret retrieval errors gracefully', async () => {
      mockContext.secrets.secretsClient.send.withArgs(sinon.match.has('name', 'GetSecretValueCommand'))
        .rejects(new Error('GetSecretValueCommand Error'));

      const context = {
        data: { orgId: 'test123' },
      };

      const result = await controller.provisionBucket(context);

      expect(result.status).to.equal(500);
      const error = await result.json();
      expect(error.message).to.include('GetSecretValueCommand Error');
    });

    it('should handle secret creation errors gracefully', async () => {
      mockContext.secrets.secretsClient.send.withArgs(sinon.match.has('name', 'CreateSecretCommand'))
        .rejects(new Error('CreateSecretCommand Error'));

      const context = {
        data: { orgId: 'test123' },
      };

      const result = await controller.provisionBucket(context);

      expect(result.status).to.equal(500);
      const error = await result.json();
      expect(error.message).to.include('CreateSecretCommand Error');
    });

    it('should handle secret update errors gracefully', async () => {
      mockContext.secrets.secretsClient.send.withArgs(sinon.match.has('name', 'GetSecretValueCommand'))
        .resolves({
          SecretString: JSON.stringify({
            previous_secret: 'previous-secret',
          }),
        });

      mockContext.secrets.secretsClient.send.withArgs(sinon.match.has('name', 'UpdateSecretCommand'))
        .rejects(new Error('UpdateSecretCommand Error'));

      const context = {
        data: { orgId: 'test123' },
      };

      const result = await controller.provisionBucket(context);

      expect(result.status).to.equal(500);
      const error = await result.json();
      expect(error.message).to.include('UpdateSecretCommand Error');
    });

    it('should handle secret tagging errors gracefully', async () => {
      mockContext.secrets.secretsClient.send.withArgs(sinon.match.has('name', 'TagResourceCommand'))
        .rejects(new Error('TagResourceCommand Error'));

      const context = {
        data: { orgId: 'test123' },
      };

      const result = await controller.provisionBucket(context);

      expect(result.status).to.equal(500);
      const error = await result.json();
      expect(error.message).to.include('TagResourceCommand Error');
    });

    it('should generate consistent bucket names for the same org ID', async () => {
      const context1 = {
        ...mockContext,
        data: { orgId: 'test123' },
      };

      const context2 = {
        ...mockContext,
        data: { orgId: 'test123' },
      };

      const result1 = await controller.provisionBucket(context1);
      const result2 = await controller.provisionBucket(context2);

      const body1 = await result1.json();
      const body2 = await result2.json();
      expect(body1.bucketName).to.equal(body2.bucketName);
      expect(body1.bucketName).to.match(/^cdn-logs-[a-f0-9]{16}$/);
    });

    it('should generate different bucket names for different org IDs', async () => {
      const context1 = {
        ...mockContext,
        data: { orgId: 'test123' },
      };

      const context2 = {
        ...mockContext,
        data: { orgId: 'different456' },
      };

      const result1 = await controller.provisionBucket(context1);
      const result2 = await controller.provisionBucket(context2);

      const body1 = await result1.json();
      const body2 = await result2.json();
      expect(body1.bucketName).to.not.equal(body2.bucketName);
      expect(body1.bucketName).to.match(/^cdn-logs-[a-f0-9]{16}$/);
      expect(body2.bucketName).to.match(/^cdn-logs-[a-f0-9]{16}$/);
    });
  });
});
