# SpaceCat API Service

> Provides an HTTP API to interact with SpaceCat data

## HTTP API Doc

https://opensource.adobe.com/spacecat-api-service/

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

## Message Body Formats

Spacecat-api-service queues audit jobs to `AUDIT_JOBS_QUEUE` to be processed later on.

Output message body format sent to `AUDIT_JOBS_QUEUE` is:

```json
{
  "type": "string",
  "url": "string",
  "auditContext": "object|optional"
}
```

Currently, only `slackContext` property exist in the `auditContext`:

```json
{
  "slackContext": {
    "channel": "string",
    "ts": "string|optional"
  }
}
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
