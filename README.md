# SpaceCat API Service

> Provides an HTTP API to interact with SpaceCat data

## Status
[![codecov](https://img.shields.io/codecov/c/github/adobe-rnd/spacecat-api-service.svg)](https://codecov.io/gh/adobe-rnd/spacecat-api-service)
[![CircleCI](https://img.shields.io/circleci/project/github/adobe-rnd/spacecat-api-service.svg)](https://circleci.com/gh/adobe-rnd/spacecat-api-service)
[![GitHub license](https://img.shields.io/github/license/adobe-rnd/spacecat-api-service.svg)](https://github.com/adobe-rnd/spacecat-api-service/blob/master/LICENSE.txt)
[![GitHub issues](https://img.shields.io/github/issues/adobe-rnd/spacecat-api-service.svg)](https://github.com/adobe-rnd/spacecat-api-service/issues)
[![LGTM Code Quality Grade: JavaScript](https://img.shields.io/lgtm/grade/javascript/g/adobe-rnd/spacecat-api-service.svg?logo=lgtm&logoWidth=18)](https://lgtm.com/projects/g/adobe-rnd/spacecat-api-service)
[![semantic-release](https://img.shields.io/badge/%20%20%F0%9F%93%A6%F0%9F%9A%80-semantic--release-e10079.svg)](https://github.com/semantic-release/semantic-release)

## API Doc

https://scaling-robot-wovlqzk.pages.github.io

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
RUM_DOMAIN_KEY=global domain key for the rum api
TARGET_SLACK_CHANNELS=comma separated key values containing slack channel names and ids,
SLACK_BOT_TOKEN=slack bot's token,
```
