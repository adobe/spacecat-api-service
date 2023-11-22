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

/**
 * Performs a query to DynamoDB and automatically handles pagination to retrieve all items.
 * This function iterates over the paginated results from DynamoDB, accumulating all items
 * until no more pages are left. It handles potential exceptions during the query operation.
 *
 * @param {Object} originalParams - The parameters for the DynamoDB query. Should include
 *                                  necessary properties like TableName, KeyConditionExpression,
 *                                  ExpressionAttributeValues, etc.
 * @returns {Promise<Array<Object>>} A promise that resolves to an array of items retrieved
 *                                   from DynamoDB. If the query fails, the promise is rejected
 *                                   with an error.
 *
 * @example
 * // example usage
 * const items = await queryDb({
 *   TableName: 'myTable',
 *   KeyConditionExpression: 'id = :id',
 *   ExpressionAttributeValues: {
 *     ':id': '123'
 * });
 *
 * @throws Will throw an error if the DynamoDB query operation fails.
 */
async function queryDb(originalParams) {
  let items = [];
  const params = { ...originalParams }; // Create a local copy of params

  console.time(`Total queryDb Execution Time: ${params.TableName}`);
  try {
    let data;
    let iteration = 0;
    do {
      console.time(`Query Iteration ${iteration}: ${params.TableName}`);
      /*
        This is one of the scenarios where it's appropriate to disable
        the ESLint rule for this specific case.
        In this case, it's necessary because each query depends on the
        result of the previous one (to get the LastEvaluatedKey).
       */
      // eslint-disable-next-line no-await-in-loop
      data = await docClient.query(params);
      console.timeEnd(`Query Iteration ${iteration}: ${params.TableName}`);

      items = items.concat(data.Items);
      params.ExclusiveStartKey = data.LastEvaluatedKey;
      iteration += 1;
    } while (data.LastEvaluatedKey);
  } catch (error) {
    console.error('DB Query Error:', error);
    throw error;
  } finally {
    console.timeEnd(`Total queryDb Execution Time: ${params.TableName}`);
  }
  return items;
}

module.exports = { dbClient, docClient, queryDb };
