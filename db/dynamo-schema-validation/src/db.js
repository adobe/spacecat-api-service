require('dotenv').config();

const { DynamoDB } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocument } = require('@aws-sdk/lib-dynamodb');
const config = {
    endpoint: process.env.DYNAMODB_ENDPOINT,
    region: process.env.AWS_REGION
};

const dbClient = new DynamoDB(config);
const docClient = DynamoDBDocument.from(dbClient);

module.exports = { dbClient, docClient };
