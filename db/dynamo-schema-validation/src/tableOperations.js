// AWS SDK imports
const { CreateTableCommand, DeleteTableCommand } = require("@aws-sdk/client-dynamodb");
const { dbClient } = require("./db");

// Function to create a single table

async function createTable(dbClient, tableDefinition) {
    const keySchema = [];
    const attributeDefinitions = [];

    // Define partition key
    if (tableDefinition.KeyAttributes.PartitionKey) {
        keySchema.push({ AttributeName: tableDefinition.KeyAttributes.PartitionKey.AttributeName, KeyType: 'HASH' });
        attributeDefinitions.push({ AttributeName: tableDefinition.KeyAttributes.PartitionKey.AttributeName, AttributeType: tableDefinition.KeyAttributes.PartitionKey.AttributeType });
    }

    // Define sort key if present
    if (tableDefinition.KeyAttributes.SortKey) {
        keySchema.push({ AttributeName: tableDefinition.KeyAttributes.SortKey.AttributeName, KeyType: 'RANGE' });
        attributeDefinitions.push({ AttributeName: tableDefinition.KeyAttributes.SortKey.AttributeName, AttributeType: tableDefinition.KeyAttributes.SortKey.AttributeType });
    }

    const params = {
        TableName: tableDefinition.TableName,
        KeySchema: keySchema,
        AttributeDefinitions: attributeDefinitions,
        BillingMode: 'PAY_PER_REQUEST', // or specify ProvisionedThroughput
    };

    // Add GSI configuration if present
    if (tableDefinition.GlobalSecondaryIndexes) {
        const gsIndexes = tableDefinition.GlobalSecondaryIndexes.map(gsi => {
            // Add GSI key attributes to AttributeDefinitions
            if (gsi.KeyAttributes.PartitionKey) {
                if (!attributeDefinitions.some(attr => attr.AttributeName === gsi.KeyAttributes.PartitionKey.AttributeName)) {
                    attributeDefinitions.push({ AttributeName: gsi.KeyAttributes.PartitionKey.AttributeName, AttributeType: gsi.KeyAttributes.PartitionKey.AttributeType });
                }
            }
            if (gsi.KeyAttributes.SortKey) {
                if (!attributeDefinitions.some(attr => attr.AttributeName === gsi.KeyAttributes.SortKey.AttributeName)) {
                    attributeDefinitions.push({ AttributeName: gsi.KeyAttributes.SortKey.AttributeName, AttributeType: gsi.KeyAttributes.SortKey.AttributeType });
                }
            }

            // Define GSI Key Schema
            const gsiKeySchema = [
                { AttributeName: gsi.KeyAttributes.PartitionKey.AttributeName, KeyType: 'HASH' },
                gsi.KeyAttributes.SortKey ? { AttributeName: gsi.KeyAttributes.SortKey.AttributeName, KeyType: 'RANGE' } : null,
            ].filter(Boolean);

            return {
                IndexName: gsi.IndexName,
                KeySchema: gsiKeySchema,
                Projection: gsi.Projection,
            };
        });

        params.GlobalSecondaryIndexes = gsIndexes;
    }

    try {
        await dbClient.send(new CreateTableCommand(params));
        console.log(`Table ${tableDefinition.TableName} created successfully.`);
    } catch (error) {
        console.error(`Error creating table ${tableDefinition.TableName}:`, error);
    }
}

// Function to delete a single table
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

module.exports = { createTable, deleteTable };
