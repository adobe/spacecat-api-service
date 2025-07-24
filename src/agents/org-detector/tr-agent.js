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
/* eslint-disable no-console */

import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { v4 as uuidv4 } from 'uuid';

function createSqsClient() {
  const region = process.env.SPACECAT_AWS_DEFAULT_REGION || 'us-east-1';
  const accessKeyId = process.env.SPACECAT_AWS_ACCESS_KEY_ID || 'localstack';
  const secretAccessKey = process.env.SPACECAT_AWS_SECRET_ACCESS_KEY || 'localstack';
  let endpoint = process.env.AWS_ENDPOINT_URL;

  if (endpoint) {
    console.log(`🔗 Using SQS endpoint: ${endpoint}`);
  } else {
    endpoint = 'http://localhost:4566';
    console.log('🔗 Using fallback SQS endpoint: http://localhost:4566');
  }

  return new SQSClient({
    region,
    credentials: { accessKeyId, secretAccessKey },
    endpoint,
  });
}

// Create the test message
function trTestMessage() {
  return {
    MessageId: uuidv4(),
    ReceiptHandle: `test-receipt-${uuidv4()}`,
    Body: JSON.stringify({
      type: 'guidance:missing-alt-text',
      siteId: 'test-site-id',
      auditId: 'test-audit-id',
      deliveryType: 'aem_edge',
      time: new Date().toISOString(),
      url: 'https://www.bamboohr.com/',
      observation: 'Missing alt text on images',
      data: {
        pageUrls: [
          'https://www.bamboohr.com/hr-quotes/',
          'https://www.bamboohr.com/blog/9-box-grid',
        ],
      },
    }),
  };
}

// Send a message to the specified queue
async function sendMessageToQueue(messageData, queueUrl) {
  const sqs = createSqsClient();
  try {
    const messageBody = messageData.Body;

    const command = new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: messageBody,
    });

    const response = await sqs.send(command);

    console.log('✅ Message sent successfully!');
    console.log(`   Message ID: ${response.MessageId}`);
    console.log(`   Queue: ${queueUrl.split('/').pop()}`);

    const bodyData = JSON.parse(messageBody);
    console.log(`   Type: ${bodyData.type || 'unknown'}`);
    console.log(`   Site ID: ${bodyData.siteId || 'unknown'}`);
    console.log(`   URL: ${bodyData.data?.url || 'unknown'}`);

    if (bodyData.type === 'guidance:accessibility-remediation') {
      const issuesList = bodyData.data?.issues_list || [];
      console.log(`   Issues Count: ${issuesList.length}`);
      issuesList.forEach((issue, i) => {
        console.log(`   Issue ${i + 1}: ${issue.issue_name || 'unknown'}`);
        console.log(`   Selector: ${issue.target_selector || 'unknown'}`);
        console.log(
          `   Faulty Line: ${(issue.faulty_line || '').slice(0, 50)}...`,
        );
      });
    }

    return response.MessageId;
  } catch (e) {
    console.log(`❌ Error sending message: ${e}`);
    return null;
  }
}

export function sendMessageToMystique(domain) {
  console.log('Sending message to Mystique...');
  console.log(`Domain: ${domain} (currently ignored)`);

  const inboundQueueUrl = 'http://localhost:4566/000000000000/spacecat-to-mystique';

  sendMessageToQueue(trTestMessage(), inboundQueueUrl);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  sendMessageToMystique('example.com');
}
