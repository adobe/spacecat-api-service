import { createDataAccess } from '@adobe/spacecat-shared-data-access';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import OaeValidationController from './src/controllers/oae-validation.js';

const log = {
  info: (...args) => console.log('[info]', ...args),
  warn: (...args) => console.log('[warn]', ...args),
  error: (...args) => console.log('[error]', ...args),
  debug: (...args) => console.log('[debug]', ...args),
};

const realDataAccess = createDataAccess({
  postgrestUrl: 'http://localhost:3000',
  postgrestApiKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoicG9zdGdyZXN0X3dyaXRlciJ9.qEUB9zeY8WHpgyyRRBgs5th4WY98pJfUudtCwImM4H4',
}, log);

// createDataAccess's S3 client has no forcePathStyle option, which LocalStack needs -- unrelated
// to what we're testing here, so just stub Configuration.findLatest() with the known local
// queue URL and keep everything else (OaeValidation/Suggestion via real PostgREST) untouched.
const dataAccess = {
  ...realDataAccess,
  Configuration: {
    findLatest: async () => ({
      getQueues: () => ({ imports: 'http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/oae-validation-imports' }),
    }),
  },
};

const sqsClient = new SQSClient({
  region: 'us-east-1',
  endpoint: 'http://localhost:4566',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});
const sqs = {
  sendMessage: async (queueUrl, message) => {
    await sqsClient.send(new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(message),
    }));
  },
};

const ctx = { dataAccess, sqs };
const controller = OaeValidationController(ctx, log, { AWS_ENV: 'dev' });

const siteId = '914eaf5a-9ce1-4603-b4bf-f5a7f74080b3';
const suggestionIds = [
  '4db2a2f6-a777-4f04-a56b-898c660c5c69', // www-redirect: lovesac.com
  '5c91548b-d218-47d9-8745-6af1839566a4', // path redirect: www.lovesac.com/showroomlocator/fox-river-mall
  '3f03c8de-dfa4-43fa-963a-dbe965f74556', // 404: google.com/abc
  'c503e4fe-b471-4363-82bb-53b061e4a0c0', // 403 via www-redirect: zee5.com
  '3b37fa8e-30c0-49bf-821b-38493490d79c', // 403 direct: www.zee5.com
];

console.log('Creating OAE validation job via OaeValidationController.createJob (class-based OaeValidationJobs underneath)...');
const result = await controller.createJob({ siteId, type: 'routing', suggestionIds });
console.log('Result:', result);
console.log(`\njobId for import-worker test: ${result.jobId}`);
