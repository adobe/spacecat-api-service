# @adobe/spacecat-shared-tokowaka-client

Tokowaka Client for SpaceCat - Manages edge optimization configurations for LLM/AI agent traffic.

## Installation

```bash
npm install @adobe/spacecat-shared-tokowaka-client
```

## Usage

```javascript
import TokowakaClient from '@adobe/spacecat-shared-tokowaka-client';

const tokowakaClient = TokowakaClient.createFrom(context);
const result = await tokowakaClient.deploySuggestions(site, opportunity, suggestions);
```

## API Reference

### TokowakaClient.createFrom(context)

Creates a client instance from a context object.

**Required context properties:**
- `context.s3.s3Client` (S3Client): AWS S3 client instance
- `context.log` (Object, optional): Logger instance
- `context.env.TOKOWAKA_SITE_CONFIG_BUCKET` (string): S3 bucket name for deployed configurations
- `context.env.TOKOWAKA_PREVIEW_BUCKET` (string): S3 bucket name for preview configurations
- `context.env.TOKOWAKA_CDN_PROVIDER` (string): CDN provider for cache invalidation
- `context.env.TOKOWAKA_CDN_CONFIG` (string): JSON configuration for CDN client
- `context.env.TOKOWAKA_EDGE_URL` (string): Tokowaka edge URL for preview HTML fetching

## Environment Variables

**Required:**
- `TOKOWAKA_SITE_CONFIG_BUCKET` - S3 bucket name for storing deployed configurations
- `TOKOWAKA_PREVIEW_BUCKET` - S3 bucket name for storing preview configurations

**Optional (for CDN invalidation):**
- `TOKOWAKA_CDN_PROVIDER` - CDN provider name (e.g., "cloudfront")
- `TOKOWAKA_CDN_CONFIG` - JSON string with CDN-specific configuration. (e.g., { "cloudfront": { "distributionId": <distribution-id>, "region": "us-east-1" }})

**Optional (for preview functionality):**
- `TOKOWAKA_EDGE_URL` - Tokowaka edge URL for fetching HTML content during preview

### Main Methods

#### `deploySuggestions(site, opportunity, suggestions)`

Generates configuration and uploads to S3 **per URL**. **Automatically fetches existing configuration for each URL and merges** new suggestions with it. Invalidates CDN cache after upload.

**Architecture Change:** Creates one S3 file per URL instead of a single file with all URLs. This prevents files from growing too large over time.

**Returns:** `Promise<DeploymentResult>` with:
- `s3Paths` - Array of S3 keys where configs were uploaded (one per URL)
- `cdnInvalidations` - Array of CDN invalidation results (one per URL)
- `succeededSuggestions` - Array of deployed suggestions
- `failedSuggestions` - Array of `{suggestion, reason}` objects for ineligible suggestions

#### `rollbackSuggestions(site, opportunity, suggestions)`

Rolls back previously deployed suggestions by removing their patches from the configuration. **Automatically fetches existing configuration for each URL** and removes patches matching the provided suggestions. Invalidates CDN cache after upload.

**Architecture Change:** Updates one S3 file per URL instead of a single file with all URLs.

**Mapper-Specific Rollback Behavior:**
- Each opportunity mapper handles its own rollback logic via `rollbackPatches()` method
- **FAQ:** Automatically removes the "FAQs" heading patch if no FAQ suggestions remain for that URL
- **Headings/Summarization:** Simple removal by suggestion ID (default behavior)

**Returns:** `Promise<RollbackResult>` with:
- `s3Paths` - Array of S3 keys where configs were uploaded (one per URL)
- `cdnInvalidations` - Array of CDN invalidation results (one per URL)
- `succeededSuggestions` - Array of rolled back suggestions
- `failedSuggestions` - Array of `{suggestion, reason}` objects for ineligible suggestions
- `removedPatchesCount` - Total number of patches removed across all URLs

#### `previewSuggestions(site, opportunity, suggestions, options)`

Previews suggestions by uploading to preview S3 path and fetching HTML comparison. **All suggestions must belong to the same URL.**

**Returns:** `Promise<PreviewResult>` with:
- `s3Path` - S3 key where preview config was uploaded
- `config` - Preview configuration object
- `cdnInvalidation` - CDN invalidation result
- `succeededSuggestions` - Array of previewed suggestions
- `failedSuggestions` - Array of `{suggestion, reason}` objects for ineligible suggestions
- `html` - Object with `url`, `originalHtml`, and `optimizedHtml`

#### `fetchConfig(url, isPreview)`

Fetches existing Tokowaka configuration from S3 for a specific URL.

**Parameters:**
- `url` - Full URL (e.g., 'https://www.example.com/products/item')
- `isPreview` - Whether to fetch from preview path (default: false)

**Returns:** `Promise<TokowakaConfig | null>` - Configuration object or null if not found

#### `mergeConfigs(existingConfig, newConfig)`

Merges existing configuration with new configuration. For each URL path, checks if `opportunityId` + `suggestionId` combination exists and either updates or adds patches accordingly.

**Returns:** `TokowakaConfig` - Merged configuration

#### `generateConfig(url, opportunity, suggestions)`

Generates Tokowaka configuration from opportunity suggestions for a specific URL without uploading.

**Parameters:**
- `url` - Full URL for which to generate config
- `opportunity` - Opportunity entity
- `suggestions` - Array of suggestion entities

#### `uploadConfig(url, config, isPreview)`

Uploads configuration to S3 for a specific URL.

**Parameters:**
- `url` - Full URL (e.g., 'https://www.example.com/products/item')
- `config` - Tokowaka configuration object
- `isPreview` - Whether to upload to preview path (default: false)

**Returns:** `Promise<string>` - S3 key of uploaded configuration

## CDN Cache Invalidation

The client invalidates CDN cache after uploading configurations. Failures are logged but don't block deployment.

## Site Configuration

Sites must have the following configuration in their `tokowakaConfig`:

```javascript
{
  "tokowakaConfig": {
    "apiKey": "legacy-key-kept-for-backward-compatibility", // Optional, kept for backward compatibility
    "forwardedHost": "www.example.com"  // Required for preview functionality
  }
}
```

**Note:** 
- `apiKey` is optional and **not used** for S3 paths or HTTP headers (kept in schema for potential future use)
- `forwardedHost` is **required** for preview functionality to fetch HTML from Tokowaka edge

## Supported Opportunity Types

### Headings

**Deployment Eligibility:** Only suggestions with `checkType: 'heading-empty'`, `checkType: 'heading-missing-h1'` and `checkType: 'heading-h1-length'` can be deployed currently.

### FAQ

**Deployment Eligibility:** Suggestions must have `shouldOptimize: true` flag and valid FAQ item structure.

**Special Behavior:** Automatically manages heading patch - adds heading when first FAQ is deployed, removes heading when last FAQ is rolled back.

### Content Summarization

**Deployment Eligibility:** Currently all suggestions for `summarization` opportunity can be deployed.

## S3 Storage

Configurations are now stored **per URL** with domain-level metadata:

### Structure
```
s3://{TOKOWAKA_SITE_CONFIG_BUCKET}/opportunities/{normalized-domain}/
├── config (domain-level metaconfig: siteId, prerender)
├── {base64-encoded-path-1} (URL-specific patches)
├── {base64-encoded-path-2} (URL-specific patches)
└── ...
```

For preview configurations:
```
s3://{TOKOWAKA_PREVIEW_BUCKET}/preview/opportunities/{normalized-domain}/
├── config
├── {base64-encoded-path-1}
└── ...
```

**Architecture Change:** Each URL has its own configuration file instead of one file per site. Domain-level metaconfig is stored separately to avoid duplication.

**URL Normalization:**
- Domain: Strips `www.` prefix (e.g., `www.example.com` → `example.com`)
- Path: Removes trailing slash (except for root `/`), ensures starts with `/`, then base64 URL encodes

**Example:**
- URL: `https://www.example.com/products/item`
- Metaconfig Path: `opportunities/example.com/config`
- Patch Config Path: `opportunities/example.com/L3Byb2R1Y3RzL2l0ZW0`
- Where `L3Byb2R1Y3RzL2l0ZW0` is base64 URL encoding of `/products/item`

### Metaconfig File Structure
Domain-level metaconfig (created once per domain, shared by all URLs):
```json
{
  "siteId": "abc-123",
  "prerender": true
}
```

### Configuration File Structure
Per-URL configuration (flat structure):
```json
{
  "url": "https://example.com/products/item",
  "version": "1.0",
  "forceFail": false,
  "prerender": true,
  "patches": [
    {
      "opportunityId": "abc-123",
      "suggestionId": "xyz-789",
      "prerenderRequired": true,
      "lastUpdated": 1234567890,
      "op": "insertAfter",
      "selector": "main",
      "value": { ... },
      "valueFormat": "hast",
      "target": "ai-bots"
    }
  ]
}
```

**Note:** 
- `siteId` is stored only in domain-level `config` (metaconfig)
- `prerender` is stored in both metaconfig (domain-level) and patch files (URL-level)
- The `baseURL` field has been renamed to `url`
- The `tokowakaOptimizations` nested structure has been removed
- The `tokowakaForceFail` field has been renamed to `forceFail`

## Reference Material

https://wiki.corp.adobe.com/display/AEMSites/Tokowaka+-+Spacecat+Integration
https://wiki.corp.adobe.com/display/AEMSites/Tokowaka+Patch+Format
