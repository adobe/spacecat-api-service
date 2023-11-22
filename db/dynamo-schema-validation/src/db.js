require('dotenv').config();

const { DynamoDB } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocument } = require('@aws-sdk/lib-dynamodb');
const config = {
    endpoint: process.env.DYNAMODB_ENDPOINT,
    region: process.env.AWS_REGION
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
