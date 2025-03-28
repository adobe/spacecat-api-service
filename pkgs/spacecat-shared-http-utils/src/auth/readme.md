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

## Provided Authentication Handlers

### JWT Handler

The JWT (JSON Web Token) handler provides authentication using ES256-signed JSON Web Tokens. It validates tokens against a provided public key and ensures they're properly signed and not expired.

#### How It Works

1. The handler extracts the bearer token from the request
2. It validates the token using a public key (from the `AUTH_PUBLIC_KEY` environment variable)
3. It verifies:
   - The token is signed with the ES256 algorithm
   - The token is not expired
   - The token has the correct issuer (https://spacecat.experiencecloud.live)
4. On successful validation, it returns the token payload as the user profile

#### Configuration

To use the JWT handler, you need to:

1. Set the `AUTH_PUBLIC_KEY` environment variable with your SPKI-formatted public key
2. Add the handler to your auth wrapper configuration

```javascript
import { wrap } from '@adobe/helix-shared-wrap';
import auth from './auth-wrapper.js';
import JwtHandler from './handlers/jwt.js';

export const main = wrap(run)
  .with(auth, { authHandlers: [JwtHandler] });
```

#### Token Requirements

JWT tokens must:
- Be signed with the ES256 algorithm
- Include standard claims (exp, iat, iss)
- Use the issuer: `https://spacecat.experiencecloud.live`
- Be provided as a Bearer token in the Authorization header

Any additional claims in the JWT payload will be available in the `authInfo.profile` object after authentication.