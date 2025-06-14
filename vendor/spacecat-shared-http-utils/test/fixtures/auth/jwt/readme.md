# JWT Key Management

Spacecat requires a private key pair per environment to sign JWT "session" tokens after IMS user login. The private key is only used by the `spacecat-api-service` deployment within the login endpoint. The public key is provided to all deployments in order to be able to validate provided JWT bearer tokens.

## Key Algorithm

The key pair must be generated using the `ES256` (`prim256v1`) algorithm.

## Generate new server key pair

```zsh
# generate private key
./test/fixtures/auth/jwt/create-keys.zsh
```

This will have an output like this:

```zsh
Enter PEM pass phrase:
read EC key
writing EC key
read EC key
writing EC key
Generated files:
  - server-key.pem (unencrypted EC key)
  - server-key-encrypted.pem (encrypted EC key)
  - server-key-public.pem (extracted public key)
  - server-key-encrypted.pem.b64 (base64 of encrypted key)
  - server-key-public.pem.b64 (base64 of public key)
```

## Test fixtures

The keys in `./test/fixtures/auth/jwt/` are generated using the above script. The `private_key.pem` is encrypted with the password `test`.
