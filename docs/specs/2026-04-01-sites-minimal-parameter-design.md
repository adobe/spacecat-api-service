# Minimal Query Parameter for Organization Sites Endpoint

**Date:** 2026-04-01  
**Status:** Approved

## Overview

Add an optional `minimal` query parameter to the `/api/ci/organizations/{organizationId}/sites` endpoint that returns only `id` and `baseURL` for each site, reducing payload size for clients that don't need the full site representation.

## Motivation

Clients that need to list sites for an organization often only require basic identifying information (site ID and URL) rather than the complete site object with all metadata, configuration, delivery details, and timestamps. Returning the full object when only minimal data is needed:

- Increases network bandwidth usage unnecessarily
- Slows down response times
- Increases client-side parsing overhead
- Makes the API less efficient for simple lookup operations

This feature provides a way for clients to request only the essential site information when that's all they need.

## API Contract

### Endpoint

`GET /api/ci/organizations/{organizationId}/sites`

### New Query Parameter

- **Name:** `minimal`
- **Type:** boolean
- **Required:** No
- **Default:** `false`

**Behavior:**
- When `false` or omitted: Returns full `Site` objects (current behavior - backward compatible)
- When `true`: Returns minimal objects containing only `{ id, baseURL }`

### Request Examples

**Full response (existing behavior):**
```
GET /api/ci/organizations/9033554c-de8a-44ac-a356-09b51af8cc28/sites
```

**Minimal response (new):**
```
GET /api/ci/organizations/9033554c-de8a-44ac-a356-09b51af8cc28/sites?minimal=true
```

### Response Format

**When minimal=true:**
```json
[
  {
    "id": "a1b2c3d4-e5f6-7g8h-9i0j-k11l12m13n14",
    "baseURL": "https://example.com"
  },
  {
    "id": "b2c3d4e5-f6g7-h8i9-j0k1-l12m13n14o15",
    "baseURL": "https://another-example.com"
  }
]
```

**When minimal=false or omitted:**
```json
[
  {
    "id": "a1b2c3d4-e5f6-7g8h-9i0j-k11l12m13n14",
    "baseURL": "https://example.com",
    "name": "Example Site",
    "organizationId": "9033554c-de8a-44ac-a356-09b51af8cc28",
    "deliveryType": "aem_edge",
    "gitHubURL": "https://github.com/example/repo",
    "isLive": true,
    "isSandbox": false,
    "createdAt": "2024-01-20T10:00:00Z",
    "updatedAt": "2024-01-20T10:00:00Z",
    "config": { ... },
    ... (all other Site fields)
  }
]
```

### HTTP Status Codes

The endpoint maintains the same status codes as the existing implementation:
- `200 OK`: Sites returned successfully (either format)
- `400 Bad Request`: Missing/invalid organizationId or product code
- `401 Unauthorized`: Missing or invalid authentication
- `403 Forbidden`: User doesn't have access to the organization
- `404 Not Found`: Organization not found
- `500 Internal Server Error`: Server error

## Implementation Design

### 1. DTO Layer

**File:** `src/dto/site.js`

Add a new method `toMinimalJSON()` to the `SiteDto` object:

```javascript
toMinimalJSON: (site) => ({
  id: site.getId(),
  baseURL: site.getBaseURL(),
})
```

This follows the existing pattern where the DTO provides multiple transformation methods:
- `toJSON()` - Full representation
- `toListJSON()` - Slim representation for list endpoints
- `toMinimalJSON()` - Minimal representation (new)

### 2. Controller Layer

**File:** `src/controllers/organizations.js`

Update the `getSitesForOrganization()` method to:

1. Extract the `minimal` query parameter from `context.pathInfo.queryParams`
2. Parse it as a boolean (handle string values "true"/"false")
3. Apply conditional DTO transformation at the final return statement

**Implementation approach:**
```javascript
const minimal = context.pathInfo.queryParams?.minimal === 'true';

// ... existing access control and site filtering logic remains unchanged ...

// Final return - conditional DTO selection
const dtoMethod = minimal ? SiteDto.toMinimalJSON : SiteDto.toJSON;
return ok([...filteredSites, ...delegatedSites].map(dtoMethod));
```

**Key points:**
- Query parameter extraction happens early in the method
- All existing business logic (access control, product filtering, delegation) remains unchanged
- Only the final serialization step differs based on the parameter
- Both own sites and delegated sites use the same DTO method

### 3. OpenAPI Specification

**File:** `docs/openapi/sites-api.yaml`

Update the `sites-for-organization` definition to include the new parameter:

```yaml
sites-for-organization:
  parameters:
    - $ref: './parameters.yaml#/organizationId'
    - name: minimal
      in: query
      required: false
      description: When true, returns only id and baseURL for each site
      schema:
        type: boolean
        default: false
  get:
    # ... existing definition ...
    responses:
      '200':
        description: A list of sites
        content:
          application/json:
            schema:
              oneOf:
                - $ref: './schemas.yaml#/SiteList'
                - $ref: './schemas.yaml#/SiteMinimalList'
            examples:
              full:
                summary: Full site objects (minimal=false or omitted)
                value:
                  - id: 'a1b2c3d4-e5f6-7g8h-9i0j-k11l12m13n14'
                    baseURL: 'https://example.com'
                    name: 'Example Site'
                    # ... full object
              minimal:
                summary: Minimal site objects (minimal=true)
                value:
                  - id: 'a1b2c3d4-e5f6-7g8h-9i0j-k11l12m13n14'
                    baseURL: 'https://example.com'
```

### 4. Schema Definitions

**File:** `docs/openapi/schemas.yaml`

Add two new schema definitions:

```yaml
SiteMinimal:
  type: object
  properties:
    id:
      description: The site ID in uuid format
      $ref: '#/Id'
    baseURL:
      description: The base URL of the site
      $ref: '#/URL'
  required:
    - id
    - baseURL
  example:
    id: 'a1b2c3d4-e5f6-7g8h-9i0j-k11l12m13n14'
    baseURL: 'https://example.com'

SiteMinimalList:
  type: array
  items:
    $ref: '#/SiteMinimal'
```

## Data Flow

```
1. Client Request
   ↓
   GET /organizations/{orgId}/sites?minimal=true
   ↓
2. Authentication & Authorization
   ↓ (unchanged)
3. Controller: getSitesForOrganization()
   - Extract minimal parameter
   - Validate organization access
   - Fetch own sites
   - Fetch delegated sites
   - Apply product filtering
   ↓ (all existing logic unchanged)
4. Serialization (NEW CONDITIONAL LOGIC)
   ├─ If minimal=true → SiteDto.toMinimalJSON()
   └─ If minimal=false → SiteDto.toJSON()
   ↓
5. Response: [{ id, baseURL }, ...]
```

## Backward Compatibility

This change is fully backward compatible:

1. **Existing clients**: Unaffected because the parameter defaults to `false`
2. **Existing tests**: Will continue to pass without modification
3. **Response format**: Full format remains unchanged when parameter is omitted
4. **Business logic**: All access control, filtering, and delegation logic unchanged
5. **Security**: Access control checks remain identical regardless of format

## Testing Requirements

### Unit Tests

**File:** `test/dto/site.test.js`
- Test `SiteDto.toMinimalJSON()` returns only `id` and `baseURL`
- Verify all other fields are excluded

**File:** `test/controllers/organizations.test.js`
- Test `getSitesForOrganization()` with `minimal=true` returns minimal format
- Test `getSitesForOrganization()` with `minimal=false` returns full format
- Test `getSitesForOrganization()` without parameter returns full format (default)
- Test minimal format with delegated sites
- Verify access control still applies correctly with minimal format

### Integration Tests

**File:** `test/it/shared/tests/organizations.js`
- Add shared test cases for minimal parameter
- Test minimal=true returns only id and baseURL
- Test minimal=false/omitted returns full objects
- Verify product filtering works with minimal format

**File:** `test/it/postgres/organizations.test.js`
- Wire shared tests to PostgreSQL harness
- Verify against real database with seed data

### OpenAPI Validation

```bash
npm run docs:lint  # Validate OpenAPI specs
npm run docs:build # Build documentation
```

## Scope Limitations

This feature is intentionally scoped to only:
- The `/organizations/{organizationId}/sites` endpoint

It does NOT include:
- Other site list endpoints (`/sites`, `/sites/by-delivery-type/{deliveryType}`, etc.)
- Project-based site endpoints
- Single site retrieval endpoints

These can be added in future iterations if needed, but starting with a single endpoint allows us to validate the pattern and gather feedback before expanding.

## Future Considerations

If this feature proves valuable, similar minimal parameters could be added to:
- `/sites` - Global site listing
- `/sites/by-delivery-type/{deliveryType}` - Filtered site listings
- `/projects/{projectId}/sites` - Project-based site listings
- Other resource list endpoints (audits, organizations, etc.)

The pattern established here (DTO method + query parameter) can be replicated easily across other endpoints.

## Security Considerations

- Access control checks remain identical regardless of response format
- No additional data is exposed - the minimal format is a strict subset of the full format
- Product filtering and entitlement validation still apply
- Delegation validation unchanged

## Performance Impact

Positive impacts:
- Reduced response payload size (roughly 90% smaller for typical sites)
- Faster JSON serialization (fewer fields to process)
- Lower network bandwidth usage
- Faster client-side parsing

No negative impacts expected:
- Database queries remain unchanged
- Access control logic unchanged
- Same number of model objects instantiated
