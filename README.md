# SpaceCat API Service

Test

> Provides an HTTP API to interact with SpaceCat data

## HTTP API Doc

https://opensource.adobe.com/spacecat-api-service/

### Build documentation locally

```bash
$ npm run docs
```

### Serve the documentation locally

```bash
$ npm run docs:serve
```

## Installation

```bash
$ npm install @adobe/spacecat-api-service
```

## Usage

See the [API documentation](docs/API.md).

## Development

To set up local development for `spacecat-api-service`, follow these steps:

1. Create an `.env` file in your project root and define the following environment variables with your AWS credentials:

```plaintext
AWS_REGION=your_aws_region
AWS_ACCESS_KEY_ID=your_access_key_id
AWS_SECRET_ACCESS_KEY=your_secret_access_key
```

2. Start the development server

```
npm start
```

### Build

```bash
$ npm install
```

### Test

```bash
$ npm test
```

### Lint

```bash
$ npm run lint
```

## Required ENV Variables

Currently, audit worker requires two env variables:

```plaintext
AUDIT_JOBS_QUEUE_URL=url of the queue to send audit jobs to
AUDIT_REPORT_SLACK_CHANNEL_ID=slack channel id to send the audit reports to
RUM_DOMAIN_KEY=global domain key for the rum api
SLACK_BOT_TOKEN=slack bot's token,
```

Fulfillment worker requires the following env variable:

```plaintext
FULFILLMENT_EVENTS_QUEUE_URL=url of the queue to send fulfillment events to
```

Organizations controller requires the following env variable:

```plaintext
SLACK_URL_WORKSPACE_EXTERNAL=url of the external Slack workspace, used to generate the Slack channel url
```

Slack controller requires the following env variables:

```plaintext
IMS_CLIENT_ID=client id for the IMS API
IMS_HOST=host for the IMS API
IMS_CLIENT_CODE=client code for the IMS API
IMS_CLIENT_SECRET=client secret for the IMS API

SLACK_TOKEN_WORKSPACE_EXTERNAL_ELEVATED=Slack token for the external workspace, elevated permissions
SLACK_OPS_CHANNEL_WORKSPACE_EXTERNAL=channel ID to use for operations messages in the external workspace
```

Import controller requires the following env variables:

```plaintext
IMPORT_CONFIGURATION=JSON document which includes the following configuration properties:
  - allowedApiKeys: array of allowed API keys, used to authenticate import requests
  - queues: array of queue names to use for import jobs. If a queue name is removed from this array, it will no longer be available for new import jobs
  - queueUrlPrefix: prefix for import queue URLs (eg. https://sqs.us-east-1.amazonaws.com/1234567890/), used to create the complete queue URL for import jobs
  - s3Bucket: the S3 bucket to store import job artifacts
```

The `multipartFormData` wrapper uses the following optional env variables:

```plaintext
MULTIPART_FORM_FILE_COUNT_LIMIT=Maximum number of files which can be included in a multipart/form-data request (defaults to 5)
MULTIPART_FORM_MAX_FILE_SIZE_MB=Maximum file size in MB for a single file in a multipart/form-data request (defaults to 20)
```
