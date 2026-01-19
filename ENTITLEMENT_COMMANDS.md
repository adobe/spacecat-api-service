# Slack Entitlement Commands

This document describes the new Slack commands for managing entitlements in the SpaceCat API Service.

## Commands Overview

Six new commands have been added to manage entitlements for sites and organizations:

### 1. Ensure Entitlement for Site
**Command:** `ensure entitlement site <siteURL>`

**Description:** Creates entitlement and enrollment for a site by URL.

**Behavior:**
- Validates the site URL
- Checks if the site exists in the database
- Shows a button to select products (ASO, ACO and/or LLMO)
- Opens a modal for product selection
- Creates entitlements and enrollments for selected products

**Example:**
```
@spacecat ensure entitlement site https://example.com
```

### 2. Ensure Entitlement for IMS Org
**Command:** `ensure entitlement imsorg <imsOrgId>`

**Description:** Creates entitlement for an organization by IMS Org ID.

**Behavior:**
- Validates the IMS Org ID
- Checks if the organization exists in the database
- Shows a button to select products (ASO, ACO and/or LLMO)
- Opens a modal for product selection
- Creates entitlements for selected products (no site enrollments for org-level)

**Example:**
```
@spacecat ensure entitlement imsorg 12345@AdobeOrg
```

### 3. Get Entitlement for Site
**Command:** `get entitlement site <siteURL>`

**Description:** Retrieves entitlement and enrollment information for a site.

**Behavior:**
- Validates the site URL
- Checks if the site exists in the database
- Queries entitlements for ASO, ACO and LLMO products
- Displays entitlement details including:
  - Product code
  - Entitlement ID
  - Tier (e.g., FREE_TRIAL)
  - Enrollment ID (if applicable)

**Example:**
```
@spacecat get entitlement site https://example.com
```

### 4. Get Entitlement for IMS Org
**Command:** `get entitlement imsorg <imsOrgId>`

**Description:** Retrieves entitlement information for an organization by IMS Org ID.

**Behavior:**
- Validates the IMS Org ID
- Checks if the organization exists in the database
- Queries entitlements for ASO, ACO and LLMO products
- Displays entitlement details including:
  - Product code
  - Entitlement ID
  - Tier
  - Number of active site enrollments

**Example:**
```
@spacecat get entitlement imsorg 12345@AdobeOrg
```

### 5. Revoke Entitlement for Site
**Command:** `revoke entitlement site <siteURL>`

**Description:** Revokes enrollment for a site by URL.

**Behavior:**
- Validates the site URL
- Checks if the site exists in the database
- Shows a button to select products to revoke
- Opens a modal for product selection
- Revokes site enrollments for selected products (does not delete the org-level entitlement)

**Example:**
```
@spacecat revoke entitlement site https://example.com
```

### 6. Revoke Entitlement for IMS Org
**Command:** `revoke entitlement imsorg <imsOrgId>`

**Description:** Revokes entitlement for an organization by IMS Org ID.

**Behavior:**
- Validates the IMS Org ID
- Checks if the organization exists in the database
- Shows a button to select products to revoke
- Opens a modal for product selection
- For each selected product:
  - Finds all site enrollments for the entitlement
  - Removes all site enrollments
  - Deletes the entitlement

**Example:**
```
@spacecat revoke entitlement imsorg 12345@AdobeOrg
```

## Technical Implementation

### Files Created

1. **Commands:**
   - `src/support/slack/commands/ensure-entitlement-site.js`
   - `src/support/slack/commands/ensure-entitlement-imsorg.js`
   - `src/support/slack/commands/get-entitlement-site.js`
   - `src/support/slack/commands/get-entitlement-imsorg.js`
   - `src/support/slack/commands/revoke-entitlement-site.js`
   - `src/support/slack/commands/revoke-entitlement-imsorg.js`

2. **Actions (Modal Handlers):**
   - `src/support/slack/actions/entitlement-modals.js`

3. **Modified Files:**
   - `src/support/slack/commands.js` - Registered new commands
   - `src/support/slack/actions/index.js` - Registered new actions

### Key Features

- **Validation:** All commands validate URLs and IMS Org IDs before processing
- **Error Handling:** Proper error messages for site/org not found
- **Modal-based Product Selection:** Reuses existing `entitlement-modal-utils.js` for consistent UI
- **TierClient Integration:** Uses `@adobe/spacecat-shared-tier-client` for all entitlement operations
- **Product Support:** Supports ASO, ACO and LLMO product codes
- **Interactive UI:** Uses Slack buttons and modals for better user experience

### Architecture

The commands follow the existing Slack command pattern:

1. **Command receives app mention** → Validates input → Shows button
2. **User clicks button** → Opens modal with product selection
3. **User submits modal** → Performs entitlement operation → Posts results

This architecture ensures:
- Proper trigger_id handling (required for Slack modals)
- Non-blocking user experience
- Clear feedback at each step

## Error Handling

All commands handle the following scenarios:
- Invalid or missing parameters
- Site/Organization not found
- Failed entitlement operations
- Network/API errors

Error messages are posted back to the Slack thread with appropriate emoji indicators (`:x:` for errors, `:warning:` for warnings).

## Notes

- Sites and organizations must exist in the database before entitlements can be managed
- The commands do NOT create new sites or organizations
- Revoking a site enrollment does not delete the organization-level entitlement
- Revoking an organization entitlement removes ALL associated site enrollments
- The default tier for new entitlements is `FREE_TRIAL`

