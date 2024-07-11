# Key Management

## Create a new key pair
```bash
openssl genpkey -algorithm RSA -out private_key.pem -pkeyopt rsa_keygen_bits:2048
openssl rsa -pubout -in private_key.pem -out public_key.pem
```

## Convert public key to JWK
Use an online converter, result should look like:
```json
{
  "kty": "RSA",
  "e": "AQAB",
  "kid": "some-id",
  "n": "some-key"
}
```
Store in `public-jwks.js`.
