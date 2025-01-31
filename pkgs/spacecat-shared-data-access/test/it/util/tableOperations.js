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

import { CreateTableCommand, DeleteTableCommand } from '@aws-sdk/client-dynamodb';

import schema from '../../../docs/schema.json' with { type: 'json' };

/**
 * Creates a DynamoDB table based on the provided table definition.
 *
 * The function defines key schema and attribute definitions for the table,
 * including the partition key and optional sort key. It also handles the
 * configuration of global secondary indexes (GSIs) if provided
 * in the table definition.
 *
 * @param {Object} dbClient - The DynamoDB client instance used for sending commands.
 * @param {Object} tableDefinition - An object describing the table to be created. It should contain
 *                                   the table name, key attributes, and optionally GSIs.
 *
 * @example
 * // Example of tableDefinition object
 * {
 *   TableName: 'MyTable',
 *   KeyAttributes: {
 *     PartitionKey: { AttributeName: 'Id', AttributeType: 'S' },
 *     SortKey: { AttributeName: 'SortKey', AttributeType: 'N' }
 *   },
 *   GlobalSecondaryIndexes: [
 *     {
 *       IndexName: 'MyGSI',
 *       KeyAttributes: {
 *         PartitionKey: { AttributeName: 'GSIKey', AttributeType: 'S' },
 *         SortKey: { AttributeName: 'GSISortKey', AttributeType: 'N' }
 *       },
 *       Projection: {
 *         ProjectionType: 'ALL'
 *       }
 *     }
 *   ]
 * }
 */
async function createTable(dbClient, tableDefinition) {
  const keySchema = [];
  const attributeDefinitions = [];

  // Define partition key
  if (tableDefinition.KeyAttributes.PartitionKey) {
    keySchema.push({ AttributeName: tableDefinition.KeyAttributes.PartitionKey.AttributeName, KeyType: 'HASH' });
    attributeDefinitions.push({
      AttributeName: tableDefinition.KeyAttributes.PartitionKey.AttributeName,
      AttributeType: tableDefinition.KeyAttributes.PartitionKey.AttributeType,
    });
  }

  // Define sort key if present
  if (tableDefinition.KeyAttributes.SortKey) {
    keySchema.push({ AttributeName: tableDefinition.KeyAttributes.SortKey.AttributeName, KeyType: 'RANGE' });
    attributeDefinitions.push({
      AttributeName: tableDefinition.KeyAttributes.SortKey.AttributeName,
      AttributeType: tableDefinition.KeyAttributes.SortKey.AttributeType,
    });
  }

  const params = {
    TableName: tableDefinition.TableName,
    KeySchema: keySchema,
    AttributeDefinitions: attributeDefinitions,
    BillingMode: 'PAY_PER_REQUEST', // or specify ProvisionedThroughput
  };

  // Add GSI configuration if present
  if (tableDefinition.GlobalSecondaryIndexes) {
    params.GlobalSecondaryIndexes = tableDefinition.GlobalSecondaryIndexes.map((gsi) => {
      // Add GSI key attributes to AttributeDefinitions
      if (gsi.KeyAttributes.PartitionKey) {
        if (!attributeDefinitions.some(
          (attr) => attr.AttributeName === gsi.KeyAttributes.PartitionKey.AttributeName,
        )
        ) {
          attributeDefinitions.push({
            AttributeName: gsi.KeyAttributes.PartitionKey.AttributeName,
            AttributeType: gsi.KeyAttributes.PartitionKey.AttributeType,
          });
        }
      }
      if (gsi.KeyAttributes.SortKey) {
        if (!attributeDefinitions.some(
          (attr) => attr.AttributeName === gsi.KeyAttributes.SortKey.AttributeName,
        )
        ) {
          attributeDefinitions.push({
            AttributeName: gsi.KeyAttributes.SortKey.AttributeName,
            AttributeType: gsi.KeyAttributes.SortKey.AttributeType,
          });
        }
      }

      // Define GSI Key Schema
      const gsiKeySchema = [
        { AttributeName: gsi.KeyAttributes.PartitionKey.AttributeName, KeyType: 'HASH' },
        gsi.KeyAttributes.SortKey ? {
          AttributeName: gsi.KeyAttributes.SortKey.AttributeName,
          KeyType: 'RANGE',
        } : null,
      ].filter(Boolean);

      return {
        IndexName: gsi.IndexName,
        KeySchema: gsiKeySchema,
        Projection: gsi.Projection,
      };
    });
  }

  try {
    await dbClient.send(new CreateTableCommand(params));
    console.log(`Table ${tableDefinition.TableName} created successfully.`);
  } catch (error) {
    console.error(`Error creating table ${tableDefinition.TableName}:`, error);
  }
}

/**
 * Deletes a specified DynamoDB table.
 *
 * The function sends a command to delete the table with the given table name.
 * It handles the response and logs the result of the operation, including handling the case
 * where the table does not exist.
 *
 * @param {Object} dbClient - The DynamoDB client instance used for sending commands.
 * @param {string} tableName - The name of the table to be deleted.
 *
 * @example
 * // Example usage
 * deleteTable(dynamoDBClient, 'MyTable');
 */
async function deleteTable(dbClient, tableName) {
  const deleteParams = {
    TableName: tableName,
  };

  try {
    await dbClient.send(new DeleteTableCommand(deleteParams));
    console.log(`Table ${tableName} deleted successfully.`);
  } catch (error) {
    if (error.name === 'ResourceNotFoundException') {
      console.log(`Table ${tableName} does not exist.`);
    } else {
      console.error(`Error deleting table ${tableName}:`, error);
    }
  }
}

/**
 * Creates all tables defined in a schema.
 *
 * Iterates over a predefined schema object and creates each table using the createTable function.
 * The schema object should define all required attributes and configurations for each table.
 *
 * @param {AWS.DynamoDB.DocumentClient} dbClient - The DynamoDB client to use for creating tables.
 */
async function createTablesFromSchema(dbClient) {
  const creationPromises = schema.DataModel.map(
    (tableDefinition) => createTable(dbClient, tableDefinition),
  );
  await Promise.all(creationPromises);
}

/**
 * Deletes a predefined set of tables from the database.
 *
 * Iterates over a list of table names and deletes each one using the deleteTable function.
 * This is typically used to clean up the database before creating new tables or
 * generating test data.
 *
 * @param {Object} dbClient - The DynamoDB client to use for creating tables.
 * @param {Array<string>} tableNames - An array of table names to delete.
 * @returns {Promise<void>} A promise that resolves when all tables have been deleted.
 */
async function deleteExistingTables(dbClient, tableNames) {
  const deletionPromises = tableNames.map((tableName) => deleteTable(dbClient, tableName));
  await Promise.all(deletionPromises);
}

export {
  createTablesFromSchema,
  deleteExistingTables,
  createTable,
  deleteTable,
};
