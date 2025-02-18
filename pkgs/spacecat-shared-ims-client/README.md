# Spacecat Shared - IMS Client

## Overview

The ImsClient library is designed to interact with the IMS (Identity Management System) API, facilitating the retrieval of organization details, user information, and service access tokens. This document outlines the necessary steps for setting up the environment and provides usage examples for integrating the ImsClient into your projects.

## Environment Setup

Before using the ImsClient, ensure your environment is correctly configured with the necessary credentials and endpoints. The following environment variables are required:

- `IMS_HOST`: The hostname of the IMS API.
- `IMS_CLIENT_ID`: Your IMS client ID.
- `IMS_CLIENT_CODE`: Your IMS client code, used for authentication.
- `IMS_CLIENT_SECRET`: Your IMS client secret, used for authentication.

## Installation

Include the ImsClient in your project by importing it from its source file. Ensure that dependencies such as `@adobe/fetch` and `@adobe/spacecat-shared-utils` are also installed in your project.

```javascript
import ImsClient from 'path/to/ImsClient';
```

## Usage

### Creating an ImsClient Instance

To create an instance of the ImsClient, you need to provide a context object containing the necessary environment configurations and an optional log.

```javascript
const context = {
  env: {
    IMS_HOST: 'ims.example.com',
    IMS_CLIENT_ID: 'yourClientId',
    IMS_CLIENT_CODE: 'yourClientCode',
    IMS_CLIENT_SECRET: 'yourClientSecret',
  },
  log: console, // Optional: Custom log can be provided
};

const imsClient = ImsClient.createFrom(context);
```

### Retrieving Service Access Token

To fetch a service access token, use the `getServiceAccessToken` method. This token is required for authenticating subsequent API requests.

```javascript
async function fetchServiceAccessToken() {
  try {
    const token = await imsClient.getServiceAccessToken();
    console.log('Service Access Token:', token);
  } catch (error) {
    console.error('Error fetching service access token:', error);
  }
}

fetchServiceAccessToken();
```

### Getting IMS Organization Details

Retrieve details about an IMS organization by its ID using the `getImsOrganizationDetails` method.

```javascript
async function fetchImsOrganizationDetails(imsOrgId) {
  try {
    const details = await imsClient.getImsOrganizationDetails(imsOrgId);
    console.log('Organization Details:', details);
  } catch (error) {
    console.error('Error fetching organization details:', error);
  }
}

const imsOrgId = 'yourImsOrgId';
fetchImsOrganizationDetails(imsOrgId);
```

## Error Handling

All methods return promises. It's important to handle errors using `try/catch` blocks in async functions to manage API request failures or invalid responses gracefully.

## Development

### Testing

To run tests:

```bash
npm test
```

### Linting

Lint your code:

```bash
npm run lint
```

### Cleaning

To remove `node_modules` and `package-lock.json`:

```bash
npm run clean
```

## Additional Information

- **Repository**: [GitHub](https://github.com/adobe/spacecat-shared.git)
- **Issue Tracking**: [GitHub Issues](https://github.com/adobe/spacecat-shared/issues)
- **License**: Apache-2.0
