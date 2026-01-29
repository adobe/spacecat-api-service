# V1 to V2 Config Conversion

This directory contains V1 LLMO configs organized by customer, along with mapping files to convert them to V2 customer configs.

## Directory Structure

```
v1v2test/
├── README.md
├── generalmotors/
│   ├── mapping.json          # Mapping configuration
│   ├── chevrolet-v1.json     # V1 LLMO config for Chevrolet
│   ├── buick-v1.json         # (example) V1 LLMO config for Buick
│   └── gmImsOrg@adobe.com.json  # Generated V2 config (output)
└── <other-customers>/
    ├── mapping.json
    └── ...
```

## Mapping File Format

Each customer directory contains a `mapping.json` file:

```json
{
  "customerName": "General Motors",
  "imsOrgId": "gmImsOrg@adobe.com",
  "brands": [
    {
      "name": "Chevrolet",
      "v1File": "chevrolet-llmo-config.json",
      "v1SiteId": "site-uuid-chevrolet",
      "baseUrl": "chevrolet.com",
      "urls": [
        "https://www.chevrolet.com"
      ]
    },
    {
      "name": "Buick",
      "v1File": "buick-llmo-config.json",
      "v1SiteId": "site-uuid-buick",
      "baseUrl": "buick.com",
      "urls": [
        "https://www.buick.com"
      ]
    }
  ]
}
```

### Fields

- **customerName**: The top-level customer/organization name
- **imsOrgId**: The IMS Organization ID for this customer
- **brands**: Array of brand configurations
  - **name**: The brand name to use in the V2 config
  - **v1File**: Path to the V1 LLMO config file (relative to the customer directory)
  - **v1SiteId**: Legacy V1 site ID for backwards compatibility
  - **baseUrl**: The main domain for this brand (e.g., "chevrolet.com", "gmc.com")
  - **urls** (optional): Array of additional URLs to add to the brand (will be merged with URLs from V1 config)

## Converting V1→V2

Run the conversion script:

```bash
node scripts/convert-v1-to-v2.js scripts/v1v2test/generalmotors
```

This will:
1. Read `generalmotors/mapping.json`
2. Process each brand's V1 file
3. Collect regions and URLs from V1 data
4. Merge additional URLs from mapping (if provided)
5. Merge all brands into a single V2 config
6. Write output to `generalmotors/<imsOrgId>.json`

## Converting V2→V1

To convert a V2 config back to V1 format (e.g., for testing):

```bash
node scripts/convert-v2-to-v1.js scripts/v1v2test/generalmotors
```

This will:
1. Read `generalmotors/mapping.json` to get the `imsOrgId`
2. Load `generalmotors/{imsOrgId}.json` (the V2 config)
3. Generate separate V1 config files for each brand
4. Name each file by the brand's `v1SiteId`: `{v1SiteId}.json`

## Adding a New Customer

1. Create directory: `mkdir v1v2test/<customer-name>`
2. Add V1 files: See "Getting V1 Config Files from S3" below
3. Create `mapping.json` with customer info and brand mappings
4. Run conversion: `node scripts/convert-v1-to-v2.js scripts/v1v2test/<customer-name>`

## Getting V1 Config Files from S3

V1 LLMO configs are stored in S3:
- **Bucket**: `spacecat-prod-importer`
- **Path**: `config/llmo/{siteId}/config.json`

### Steps to Download

1. Get the `v1SiteId` for each brand from your mapping file
2. Download the config from S3:
   ```bash
   aws s3 cp s3://spacecat-prod-importer/config/llmo/{siteId}/config.json ./{brand-name}-llmo-config.json
   ```
3. Place the downloaded files in your customer directory

### Example for General Motors

```bash
# Create customer directory
mkdir -p scripts/v1v2test/generalmotors

# Download V1 configs using site IDs
aws s3 cp s3://spacecat-prod-importer/config/llmo/site-uuid-chevrolet/config.json scripts/v1v2test/generalmotors/chevrolet-llmo-config.json
aws s3 cp s3://spacecat-prod-importer/config/llmo/site-uuid-gmc/config.json scripts/v1v2test/generalmotors/gmc-llmo-config.json
aws s3 cp s3://spacecat-prod-importer/config/llmo/site-uuid-buick/config.json scripts/v1v2test/generalmotors/buick-llmo-config.json

# Create mapping.json (see examples below)
# Then run conversion
node scripts/convert-v1-to-v2.js scripts/v1v2test/generalmotors
```

**Important**: The filename you use must match the `v1File` field in your `mapping.json`.

## Example: Multiple Brands

For a customer with multiple brands (e.g., General Motors has Chevrolet, GMC, Buick):

```json
{
  "customerName": "General Motors",
  "imsOrgId": "gmImsOrg@adobe.com",
  "brands": [
    {
      "name": "Chevrolet",
      "v1File": "chevrolet-llmo-config.json",
      "v1SiteId": "a1b2c3d4-5678-90ab-cdef-chevrolet123",
      "baseUrl": "chevrolet.com",
      "urls": [
        "https://www.chevrolet.com"
      ]
    },
    {
      "name": "GMC",
      "v1File": "gmc-llmo-config.json",
      "v1SiteId": "a1b2c3d4-5678-90ab-cdef-gmc4567890ab",
      "baseUrl": "gmc.com",
      "urls": [
        "https://www.gmc.com"
      ]
    },
    {
      "name": "Buick",
      "v1File": "buick-llmo-config.json",
      "v1SiteId": "a1b2c3d4-5678-90ab-cdef-buick678901a",
      "baseUrl": "buick.com",
      "urls": [
        "https://www.buick.com"
      ]
    }
  ]
}
```

All brands will be merged into a single V2 customer config with multiple brands under `customer.brands[]`.

## Data Collection from V1

The converter automatically collects and aggregates data from V1 configs:

### Regions
- Collected from brand aliases, competitors, categories, and prompts
- All unique regions are merged into the brand's `region` array
- Normalized to lowercase
- Defaults to `["gl"]` if no regions found

### URLs
- Collected from all category `urls` fields in the V1 config
- Additional URLs from the mapping file are merged (deduplicated)
- Each URL becomes `{ value: "...", type: "url" }`

### Status
- All created entities default to `status: "active"`
- Applies to brands, categories, topics, and prompts

### Origin & Updated By
- `origin`: Set to `"system"` for brands, preserved from V1 for categories
- `updatedBy`: Always set to `"system"` for migration
- `updatedAt`: Preserved from V1 if available, otherwise current timestamp

## Testing API Endpoints Locally

After generating V2 configs, you can test the API endpoints locally. The server will use mock data from the generated V2 config files.

### Start the Local Server

```bash
npm start
# Server runs on http://localhost:3000
```

### Available V2 Endpoints

All endpoints require a `spaceCatId` (Organization UUID). The API will:
1. Look up the organization by UUID in the database
2. Get the `imsOrgId` from that organization
3. Use the `imsOrgId` to fetch the customer config from S3 or mock data

**Important**: For local testing, you need to use a real organization UUID from your database that has an `imsOrgId` set.

#### Get Full Customer Config

```bash
curl "http://localhost:3000/v2/orgs/{spaceCatId}/llmo-customer-config" | jq '.'
```

Returns the complete customer configuration including categories, topics, and all prompts for all brands.

#### Get Lean Customer Config

```bash
curl "http://localhost:3000/v2/orgs/{spaceCatId}/llmo-customer-config-lean" | jq '.'
```

Returns brands with prompt/category/topic counts, but without the actual prompts, categories, or topics collections.

#### Get Topics

```bash
curl "http://localhost:3000/v2/orgs/{spaceCatId}/llmo-topics" | jq '.'
```

Returns the top-level topics collection.

#### Get Prompts

```bash
curl "http://localhost:3000/v2/orgs/{spaceCatId}/llmo-prompts" | jq '.'
```

Returns all prompts with enriched category/topic information.

**Filter by brand:**
```bash
curl "http://localhost:3000/v2/orgs/{spaceCatId}/llmo-prompts?brandId=chevrolet" | jq '.'
```

**Filter by category:**
```bash
curl "http://localhost:3000/v2/orgs/{spaceCatId}/llmo-prompts?categoryId={categoryId}" | jq '.'
```

**Filter by topic:**
```bash
curl "http://localhost:3000/v2/orgs/{spaceCatId}/llmo-prompts?topicId={topicId}" | jq '.'
```

#### Save Customer Config

```bash
curl -X POST "http://localhost:3000/v2/orgs/{spaceCatId}/llmo-customer-config" \
  -H "Content-Type: application/json" \
  -d @scripts/v1v2test/generalmotors/757A02BE532B22BA0A490D4CAdobeOrg.json \
  | jq '.'
```

### Status Filtering

All GET endpoints support status filtering:

**Default behavior** (no `?status=` param): Returns only `active` and `pending` items, excludes `deleted`.

**Filter by specific status:**
```bash
# Get only deleted topics
curl "http://localhost:3000/v2/orgs/{spaceCatId}/llmo-topics?status=deleted" | jq '.'

# Get only active prompts
curl "http://localhost:3000/v2/orgs/{spaceCatId}/llmo-prompts?status=active" | jq '.'
```

### Mock Data for Local Testing

When running locally without S3, the API falls back to mock data defined in `src/support/customer-config-data.js`:

```javascript
const TEST_CONFIG_PATHS = {
  '757A02BE532B22BA0A490D4CAdobeOrg': '../../scripts/v1v2test/generalmotors/757A02BE532B22BA0A490D4CAdobeOrg.json',
  '51F301D95EC6EC0A0A495EDFAdobeOrg': '../../scripts/v1v2test/adobe/51F301D95EC6EC0A0A495EDFAdobeOrg.json',
};
```

The API will look up the organization by `spaceCatId`, get its `imsOrgId`, and then load the corresponding mock file.

### Finding Organization IDs for Testing

To test with a real organization:

1. **Find organizations with IMS Org IDs:**
   ```bash
   # Use the SpaceCat CLI or API to list organizations
   curl "http://localhost:3000/organizations" | jq '.[] | select(.imsOrgId != null) | {id, name, imsOrgId}'
   ```

2. **Use the organization's `id` (UUID) as `spaceCatId` in the endpoints:**
   ```bash
   # Example: If organization ID is "a1b2c3d4-5678-90ab-cdef-1234567890ab"
   curl "http://localhost:3000/v2/orgs/a1b2c3d4-5678-90ab-cdef-1234567890ab/llmo-customer-config" | jq '.'
   ```

### Example: Complete Testing Workflow

```bash
# 1. Generate V2 config
node scripts/convert-v1-to-v2.js scripts/v1v2test/generalmotors

# 2. Start local server
npm start

# 3. Find an organization with the matching IMS Org ID
SPACE_CAT_ID=$(curl "http://localhost:3000/organizations" | jq -r '.[] | select(.imsOrgId == "757A02BE532B22BA0A490D4CAdobeOrg") | .id')

# 4. Test the endpoints
curl "http://localhost:3000/v2/orgs/${SPACE_CAT_ID}/llmo-customer-config" | jq '.customer.brands | length'
curl "http://localhost:3000/v2/orgs/${SPACE_CAT_ID}/llmo-topics" | jq '.topics | length'
curl "http://localhost:3000/v2/orgs/${SPACE_CAT_ID}/llmo-prompts?brandId=chevrolet" | jq '.prompts | length'
```
