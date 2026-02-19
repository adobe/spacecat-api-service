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

/* eslint-disable no-await-in-loop, import/no-extraneous-dependencies, max-statements-per-line */
import { createRequire } from 'module';
import {
  CreateTableCommand,
  DynamoDBClient,
  ListTablesCommand,
} from '@aws-sdk/client-dynamodb';

const require = createRequire(import.meta.url);
const { spawn } = require('dynamo-db-local');

const PORT = 8000;
const TABLE_NAME = 'spacecat-services-data';
const ENDPOINT = `http://127.0.0.1:${PORT}`;

let dynamoProcess;
let stderrChunks = [];

/**
 * Polls the DynamoDB Local endpoint until it responds.
 *
 * @param {number} maxAttempts - Maximum poll attempts
 * @param {number} intervalMs - Delay between attempts
 */
async function waitForReady(maxAttempts = 60, intervalMs = 1000) {
  const client = new DynamoDBClient({
    endpoint: ENDPOINT,
    region: 'us-east-1',
    credentials: { accessKeyId: 'dummy', secretAccessKey: 'dummy' },
  });

  for (let i = 0; i < maxAttempts; i += 1) {
    // Bail early if the process has already exited
    if (dynamoProcess.exitCode !== null) {
      const stderr = stderrChunks.join('');
      throw new Error(
        `DynamoDB Local exited with code ${dynamoProcess.exitCode} before becoming ready.\n${stderr}`,
      );
    }

    try {
      await client.send(new ListTablesCommand({}));
      return; // DynamoDB Local is ready
    } catch {
      await new Promise((resolve) => { setTimeout(resolve, intervalMs); });
    }
  }

  const stderr = stderrChunks.join('');
  throw new Error(
    `DynamoDB Local did not start within ${maxAttempts * intervalMs}ms.\nstderr: ${stderr}`,
  );
}

/**
 * Creates the single-table with pk/sk + 5 GSIs.
 *
 * @param {DynamoDBClient} client
 */
async function createTable(client) {
  const gsiAttributes = [];
  const gsis = [];

  for (let n = 1; n <= 5; n += 1) {
    const pk = `gsi${n}pk`;
    const sk = `gsi${n}sk`;
    gsiAttributes.push(
      { AttributeName: pk, AttributeType: 'S' },
      { AttributeName: sk, AttributeType: 'S' },
    );
    gsis.push({
      IndexName: `spacecat-data-${pk}-${sk}`,
      KeySchema: [
        { AttributeName: pk, KeyType: 'HASH' },
        { AttributeName: sk, KeyType: 'RANGE' },
      ],
      Projection: { ProjectionType: 'ALL' },
    });
  }

  await client.send(new CreateTableCommand({
    TableName: TABLE_NAME,
    KeySchema: [
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' },
    ],
    AttributeDefinitions: [
      { AttributeName: 'pk', AttributeType: 'S' },
      { AttributeName: 'sk', AttributeType: 'S' },
      ...gsiAttributes,
    ],
    GlobalSecondaryIndexes: gsis,
    BillingMode: 'PAY_PER_REQUEST',
  }));
}

/**
 * Starts DynamoDB Local (in-memory) and creates the single table.
 *
 * @returns {Promise<DynamoDBClient>} A configured DynamoDB client
 */
export async function startDynamo() {
  stderrChunks = [];
  dynamoProcess = spawn({ port: PORT, stdio: 'pipe' });

  // Capture stderr for diagnostics on failure
  if (dynamoProcess.stderr) {
    dynamoProcess.stderr.on('data', (chunk) => {
      stderrChunks.push(chunk.toString());
    });
  }

  // Surface spawn errors (e.g., java not found)
  dynamoProcess.on('error', (err) => {
    console.error('DynamoDB Local process error:', err.message);
  });

  dynamoProcess.on('exit', (code, signal) => {
    if (code !== null && code !== 0) {
      console.error(`DynamoDB Local exited with code ${code}, signal ${signal}`);
    }
  });

  await waitForReady();

  const client = new DynamoDBClient({
    endpoint: ENDPOINT,
    region: 'us-east-1',
    credentials: { accessKeyId: 'dummy', secretAccessKey: 'dummy' },
  });

  await createTable(client);

  return client;
}

/**
 * Kills the DynamoDB Local process.
 */
export async function stopDynamo() {
  if (dynamoProcess) {
    dynamoProcess.kill();
    dynamoProcess = null;
  }
}
