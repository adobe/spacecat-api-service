## Secrets

see https://git.corp.adobe.com/CQ/project-franklin/blob/main/secrets/readme.md on how to update the production secrets

### Development secrets

If you want to run a dev server in order to debug the admin, you can fetch the dev-secrets from
the adobe vault, using the [fetch-dev-secrets.sh](./fetch-dev-secrets.sh) tool.

### how to generate a new key pair

The public keys for the custom IDP simulation are stored in [src/support/idp-configs/jwks-json.js](../src/support/idp-configs/jwks-json.js).
whenever a new private key is generated, its public key should be added to the `jkws-json.js`.

1. Generate the files:
   ```console
   $ node secrets/pk.js
   public jwk saved as: admin-idp-pub-20230131093034.json
   private jwk saved as: admin-idp-prv-20230131093034.json
   ```
   
2. update the `keys` array in [src/login/jwks-json.js](../src/support/idp-configs/jwks-json.js) with the generated public key.

3. test if the keypair works:
   ```console
   $ node secrets/pk-test.js admin-idp-prv-20230131093034.json
   created jwt eyJhbGciOiJSUzI1NiIsImtpZCI6Ijdzb2...
   valid {
     email: 'bob',
     name: 'Bob',
     userId: '112233',
     iat: 1675157611,
     iss: 'urn:example:issuer',
     aud: 'dummy-clientid',
     exp: 1675164811
   }
   ```

4. update the private key secret in adobe vault:
   ```console
   $ vault kv patch dx_aem_franklin/runtime/helix3/admin HLX_ADMIN_IDP_PRIVATE_KEY=- < admin-idp-prv-20230131093034.json
   ============== Secret Path ==============
   dx_aem_franklin/data/runtime/helix3/admin
   
   ======= Metadata =======
   Key                Value
   ---                -----
   created_time       2023-01-31T09:43:34.484315412Z
   custom_metadata    <nil>
   deletion_time      n/a
   destroyed          false
   version            2
   ```
   
5. commit the new JWKS, create a PR and wait until the new admin is deployed.

6. sync the vault secret with the AWS secrets manager, see https://git.corp.adobe.com/CQ/project-franklin/blob/main/secrets/readme.md

7. delete the generated JWK files:
   ```console
   $ rm admin-idp-p*.json
   ```
