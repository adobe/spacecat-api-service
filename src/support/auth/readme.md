Sure, here's a README that provides an overview of the architecture, how to use the authentication wrapper, and how to implement an example authentication handler:

---

# Authentication System

The authentication system is designed to secure AWS Lambda functions by integrating various authentication methods.
It includes an authentication wrapper, a manager, and handler classes that implement specific authentication logic.

## Architecture

The architecture of the authentication system consists of the following components:

### Authentication Wrapper

The `authWrapper` function wraps your Lambda function, enforcing authentication based on defined handlers.
It determines which endpoints require authentication and delegates the actual authentication process to the `AuthenticationManager`.

### Authentication Manager

The `AuthenticationManager` class manages multiple authentication handlers.
It attempts to authenticate each request by delegating to the registered handlers in sequence.

### AuthInfo Class

The `AuthInfo` class represents information about the current authentication state, 
including whether the user is authenticated, the user's profile, and the type of authentication performed.

### Handlers

Handlers are responsible for implementing specific authentication mechanisms. 
Each handler extends the `AbstractHandler` class and implements the `checkAuth` method.

## Getting Started

### Using the Authentication Wrapper

To secure your Lambda function, wrap it with the `authWrapper` function. You must provide an array of authentication handlers to the wrapper.

```javascript
import { Response } from '@adobe/fetch';
import auth from './auth-wrapper.js';

const run = async (request, context) => {
  const authInfo = context.attributes.authInfo;
  return new Response(`Hello, ${authInfo.profile.user_id}!`, { status: 200 });
};

export const main = wrap(run)
  .with(auth, { authHandlers: [LegacyApiKeyHandler, AdobeImsHandler] });
```

### Implementing an Authentication Handler

To implement a new authentication handler, extend the `AbstractHandler` class and implement the `checkAuth` method.
This method should return an `AuthInfo` object if authentication is successful or `null` if it fails.

```javascript
import AbstractHandler from './abstract.js';
import AuthInfo from '../auth-info.js';

export default class ExampleHandler extends AbstractHandler {
  constructor(log) {
    super('exampleHandler', log);
  }

  async checkAuth(request, context) {
    // Implement your authentication logic here

    const isAuthenticated = true; // Replace with actual authentication logic
    if (isAuthenticated) {
      const profile = { user_id: 'example-user' };
      return new AuthInfo()
        .withAuthenticated(true)
        .withProfile(profile)
        .withType(this.name);
    }

    return null;
  }
}
```
