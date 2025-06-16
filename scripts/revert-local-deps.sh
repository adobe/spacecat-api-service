#!/bin/bash

# Revert Local Dependencies Script
# This script reverts back to using npm packages instead of local copies

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}?? Reverting to npm packages...${NC}"

# Update package.json to use npm version
echo -e "${YELLOW}?? Updating package.json...${NC}"
sed -i.bak 's|"@adobe/spacecat-shared-http-utils": "file:./vendor/spacecat-shared-http-utils"|"@adobe/spacecat-shared-http-utils": "1.14.1"|g' package.json

# Remove vendor directory
if [ -d "./vendor" ]; then
    echo -e "${YELLOW}???  Removing vendor directory...${NC}"
    rm -rf ./vendor
fi

# Reinstall dependencies
echo -e "${YELLOW}?? Reinstalling dependencies...${NC}"
rm -rf node_modules package-lock.json
npm install

echo -e "${GREEN}? Successfully reverted to npm packages!${NC}"
echo -e "${YELLOW}?? You're now using the published versions from npm.${NC}" 