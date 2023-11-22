/*
 * Copyright 2023 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */
require('dotenv').config();

const { DynamoDB } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocument } = require('@aws-sdk/lib-dynamodb');

const config = {
  endpoint: process.env.DYNAMODB_ENDPOINT,
  region: process.env.AWS_REGION,
};

const dbClient = new DynamoDB(config);
const docClient = DynamoDBDocument.from(dbClient);

async function queryDb(params) {
  try {
    const data = await docClient.query(params);
    return data.Items;
  } catch (error) {
    console.error('DB Query Error:', error);
    throw error;
  }
}

module.exports = { dbClient, docClient, queryDb };
