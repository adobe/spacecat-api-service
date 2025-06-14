#!/bin/bash

# Update Local Dependencies Script
# This script copies the latest changes from spacecat-shared packages to the vendor directory

set -e

# Configuration
SHARED_REPO_PATH="$HOME/code/spacecat-shared"
VENDOR_DIR="./vendor"
HTTP_UTILS_PACKAGE="spacecat-shared-http-utils"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}🔄 Updating local dependencies...${NC}"

# Check if the shared repo exists
if [ ! -d "$SHARED_REPO_PATH" ]; then
    echo -e "${RED}❌ Error: spacecat-shared repository not found at $SHARED_REPO_PATH${NC}"
    echo "Please make sure the spacecat-shared repository is cloned at ~/code/spacecat-shared"
    exit 1
fi

# Create vendor directory if it doesn't exist
mkdir -p "$VENDOR_DIR"

# Function to update a package
update_package() {
    local package_name=$1
    local source_path="$SHARED_REPO_PATH/packages/$package_name"
    local dest_path="$VENDOR_DIR/$package_name"
    
    if [ ! -d "$source_path" ]; then
        echo -e "${RED}❌ Error: Package $package_name not found at $source_path${NC}"
        return 1
    fi
    
    echo -e "${YELLOW}📦 Updating $package_name...${NC}"
    
    # Remove existing copy
    if [ -d "$dest_path" ]; then
        rm -rf "$dest_path"
    fi
    
    # Copy the package
    cp -r "$source_path" "$dest_path"
    
    # Clean up unnecessary files
    cd "$dest_path"
    rm -rf node_modules coverage junit .git 2>/dev/null || true
    
    echo -e "${GREEN}✅ $package_name updated successfully${NC}"
    cd - > /dev/null
}

# Update the http-utils package
update_package "$HTTP_UTILS_PACKAGE"

# Reinstall dependencies to ensure the local package is properly linked
echo -e "${YELLOW}📦 Reinstalling dependencies...${NC}"
npm install

echo -e "${GREEN}🎉 All local dependencies updated successfully!${NC}"
echo -e "${YELLOW}💡 The following packages are now using local versions:${NC}"
echo -e "   • @adobe/spacecat-shared-http-utils" 