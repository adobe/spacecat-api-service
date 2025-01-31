# Spacecat Shared - HTTP Utilities 

A set of TypeScript functions for creating HTTP responses with standardized formats, and classes for dealing with
authenticating HTTP requests.

## Table of Contents

- [Introduction](#introduction)
- [Installation](#installation)
- [Usage](#usage)
- [API](#api)
- [Contributing](#contributing)
- [License](#license)

## Introduction

This library provides a collection of functions related to http to be used in Spacecat development. The functions are designed to create responses with standardized formats, making it easier to maintain a consistent structure across different parts of your application.

## Installation

Install the package using npm or yarn:

```bash
npm install @adobe/spacecat-shared-http-utils
```

or

```bash
yarn add @adobe/spacecat-shared-http-utils
```

## Usage

Import the functions in your TypeScript file and use them to generate HTTP responses. Here's an example:

```typescript
import {
  ok,
  noContent,
  badRequest,
  notFound,
  internalServerError,
} from '@adobe/spacecat-shared-http-utils';

// Example usage
const successResponse: Response = ok('Request was successful');

const emptyResponse: Response = noContent();

const errorResponse: Response = badRequest('Invalid input');

const notFoundResponse: Response = notFound('Resource not found');

const serverErrorResponse: Response = internalServerError('Something went wrong');
```

## API

### `ok(body?: string): Response`

Creates a successful response with an optional body.

### `noContent(headers?: Headers): Response`

Creates a response with no content and optional headers.

### `badRequest(message: string, headers?: Headers): Response`

Creates a response for a bad request with an error message and optional headers.

### `notFound(message: string, headers?: Headers): Response`

Creates a response for a not found scenario with an error message and optional headers.

### `internalServerError(message: string, headers?: Headers): Response`

Creates a response for an internal server error with an error message and optional headers.

## Authentication

This package includes classes for dealing with authenticating HTTP requests.

### ScopedApiKeyHandler

Scoped API keys are defined in the datalayer and can be used to authenticate requests to the Spacecat API. They employ
"scopes" to enable fine-grained access to resources. An example API key entity looks like this (`id` omitted):

```
{
  "name": "Example API Key",
  "hashedApiKey": "4c806362b613f7496abf284146efd31da90e4b16169fe001841ca17290f427c4",
  "createdAt": "2024-08-21T19:00:00.000Z",
  "expiresAt": "2024-12-21T19:00:00.000Z",
  "scopes": [
    { "name": "imports.write" },
    { "name": "imports.read" }
  ]
}
```

Key points on the above:
- `hashedApiKey` is the SHA-256 hash of the actual API key ("test-api-key" above)
- `scopes` are the permissions granted to the API key
- Each `scope` object can contain additional data, but the `name` field is required

The `ScopedApiKeyHandler` class is used to authenticate requests using scoped API keys. To support the existing 
Legacy API keys, it should be ordered after the `LegacyApiKeyHandler` in the `authHandlers` array. This enables requests
with the existing API keys to be authenticated quickly without requiring a database lookup.

#### Checking for scope access

To enable a new scope, first refer to the `scopeNames` array in the ApiKey model (/packages/spacecat-shared-data-access/src/models/api-key.js).
If the scope you need is not listed here, please add it. Note the convention for scope names is `resource.action`, 
e.g. `imports.write` or `sites.read_all`. The `_all` action suffix indicates access beyond resources created (or
jobs initiated by) the current API key.

Next, you will want to check that the API used to make the request has access to the required scope(s) from your
controller. The `authWrapper` adds an `auth` helper to the context which makes this easy. Here's an example of how to 
check for scope access from a controller:

```
// This route requires the 'imports.write' scope
function protectedRoute(context) {
  const { auth } = context;
  
  try {
    auth.checkScopes(['imports.write']);
  } catch (error) {
    throw new ErrorWithStatusCode('Missing required scopes', 401);
  }
  
  return ok('You have access to this resource');
}
```

Need additional details from the API key entity object? The `authWrapper` places the authenticated `authInfo` object
into the context at `context.attributes.authInfo`, with the API key entity available in its `profile` property.

#### Creating a new API key

This is currently a manual process, and involves duplicating an existing API key entity in the datalayer and updating
its properties. For the table to update, refer to the `TABLE_NAME_API_KEYS` constant (which will be overridden on prod).

In the future we are planning to support a way for clients to request their own API key, given a valid IMS token.

## Contributing

Feel free to contribute by opening issues or creating pull requests. Please follow the existing coding style and include tests when adding new features.

## License

This project is licensed under the Apache 2.0 - see the [LICENSE](LICENSE) file for details.

