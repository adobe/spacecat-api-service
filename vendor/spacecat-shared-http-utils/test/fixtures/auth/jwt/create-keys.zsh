#!/usr/bin/env zsh

# Prompt for the PEM pass phrase (input hidden)
echo -n "Enter PEM pass phrase: "
read -s PEM_PASSPHRASE
echo ""

# Generate an unencrypted EC private key
openssl ecparam -genkey -name prime256v1 -noout -out server-key.pem

# Encrypt the EC private key using AES256 with the provided pass phrase
openssl ec -in server-key.pem -out server-key-encrypted.pem -aes256 -passout pass:"$PEM_PASSPHRASE"

# Extract the public key from the encrypted key using the pass phrase
openssl ec -in server-key-encrypted.pem -pubout -out server-key-public.pem -passin pass:"$PEM_PASSPHRASE"

# Base64 encode the encrypted private key and public key using macOS syntax
base64 -i server-key-encrypted.pem -o server-key-encrypted.pem.b64
base64 -i server-key-public.pem -o server-key-public.pem.b64

echo "Generated files:"
echo "  - server-key.pem (unencrypted EC key)"
echo "  - server-key-encrypted.pem (encrypted EC key)"
echo "  - server-key-public.pem (extracted public key)"
echo "  - server-key-encrypted.pem.b64 (base64 of encrypted key)"
echo "  - server-key-public.pem.b64 (base64 of public key)"

