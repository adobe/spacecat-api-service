# Sandbox Configuration System

## Overview

The Sandbox Configuration System allows dynamic management of audit configurations for sandbox environments through a RESTful API. This system enables enabling/disabling specific audit types and configuring their parameters without code deployment.

## Architecture

### Components

1. **Configuration Model** (`spacecat-shared-data-access`)
   - Manages sandbox audit configurations
   - Provides methods for CRUD operations on sandbox audits
   - Uses proper accessor methods for data integrity

2. **Configuration Controller** (`spacecat-api-service`)
   - Handles HTTP requests for configuration management
   - Provides endpoints for retrieving and updating configurations

3. **Configuration DTO** (`spacecat-api-service`)
   - Serializes configuration objects for API responses
   - Ensures consistent data format across endpoints

## API Endpoints

The system uses a **PATCH-only approach** for simplicity and consistency. All operations (create, update, remove) are handled through a single endpoint.

### Get Latest Configuration
```http
GET /configurations/latest
```

**Response:**
```json
{
  "id": "config-uuid",
  "version": "1.0.0",
  "sandboxAudits": {
    "lhs-mobile": {
      "disabled": false
    },
    "cwv": {
      "disabled": true
    }
  },
  "createdAt": "2025-09-10T12:00:00Z",
  "updatedAt": "2025-09-10T12:00:00Z"
}
```

### Update Sandbox Configuration
```http
PATCH /configurations/sandbox
Content-Type: application/json

{
  "sandboxConfigs": {
    "lhs-mobile": {
      "disabled": false,
      "threshold": 85,
      "timeout": 30000,
      "retries": 3,
      "customParams": {
        "device": "mobile",
        "location": "US"
      }
    }
  }
}
```

**Response:**
```json
{
  "success": true,
  "message": "Sandbox audit configuration updated successfully"
}
```

### Remove Sandbox Configuration
To remove a configuration, set it to `null` in a PATCH request:

```http
PATCH /configurations/sandbox
Content-Type: application/json

{
  "sandboxConfigs": {
    "lhs-mobile": null
  }
}
```

**Response:**
```json
{
  "success": true,
  "message": "Sandbox configurations updated successfully"
}
```

## Schema Validation

### Sandbox Audit Configuration Schema

Each sandbox audit configuration must follow this strict schema:

```javascript
{
  "auditType": {
    "disabled": boolean,           // Optional: Enable/disable the audit
    "threshold": number (0-100),   // Optional: Performance threshold percentage
    "timeout": number (1000-300000), // Optional: Timeout in milliseconds (1s-5min)
    "retries": number (0-10),      // Optional: Number of retry attempts
    "customParams": object         // Optional: Custom parameters object
  }
}
```

### Validation Rules

#### Audit Type Names
- Must contain only: letters, numbers, hyphens, underscores
- Pattern: `/^[a-zA-Z0-9-_]+$/`
- Examples: ✅ `lhs-mobile`, `cwv`, `site_audit_v2` | ❌ `lhs mobile`, `audit@type`

#### Configuration Properties
- **disabled**: `boolean` - Enable/disable the audit
- **threshold**: `number` (0-100) - Performance threshold percentage
- **timeout**: `number` (1000-300000) - Request timeout in milliseconds
- **retries**: `number` (0-10) - Number of retry attempts
- **customParams**: `object` - Any custom parameters

#### Validation Errors
```json
{
  "error": "Bad Request",
  "message": "Invalid configuration keys for \"lhs-mobile\": invalidKey. Allowed keys: disabled, threshold, timeout, retries, customParams"
}

{
  "error": "Bad Request", 
  "message": "\"threshold\" for audit type \"cwv\" must be a number between 0 and 100"
}
```

### Valid Configuration Examples

#### Basic Configuration
```json
{
  "sandboxConfigs": {
    "lhs-mobile": {
      "disabled": false
    }
  }
}
```

#### Advanced Configuration
```json
{
  "sandboxConfigs": {
    "lhs-mobile": {
      "disabled": false,
      "threshold": 85,
      "timeout": 30000,
      "retries": 2,
      "customParams": {
        "device": "mobile",
        "location": "US",
        "userAgent": "custom-agent"
      }
    },
    "cwv": {
      "disabled": true,
      "threshold": 90
    }
  }
}
```

#### Invalid Configurations ❌
```json
// Invalid audit type name
{
  "sandboxConfigs": {
    "lhs mobile": { "disabled": false }  // Spaces not allowed
  }
}

// Invalid threshold value
{
  "sandboxConfigs": {
    "lhs-mobile": { "threshold": 150 }   // Must be 0-100
  }
}

// Unknown property
{
  "sandboxConfigs": {
    "lhs-mobile": { "invalidProp": "value" }  // Not in allowed keys
  }
}
```

## Configuration Model Methods

### Core Methods

#### `getSandboxAuditConfig(auditType)`
Retrieves configuration for a specific audit type.

```javascript
const config = configuration.getSandboxAuditConfig('lhs-mobile');
// Returns: { disabled: false, customParam: "value" }
```

#### `updateSandboxAuditConfig(auditType, config)`
Updates configuration for a specific audit type.

```javascript
await configuration.updateSandboxAuditConfig('lhs-mobile', {
  disabled: true,
  threshold: 90
});
```


#### `getEnabledSandboxAudits()`
Returns array of enabled audit types.

```javascript
const enabledAudits = configuration.getEnabledSandboxAudits();
// Returns: ['cwv', 'lhs-desktop']
```

#### `isAuditEnabledForSandbox(auditType)`
Checks if an audit type is enabled for sandbox.

```javascript
const isEnabled = configuration.isAuditEnabledForSandbox('lhs-mobile');
// Returns: true/false
```

## Usage Examples

### Enable an Audit Type
```bash
curl -X PATCH http://localhost:3000/configurations/sandbox \
  -H "Content-Type: application/json" \
  -d '{
    "auditType": "lhs-mobile",
    "config": {
      "disabled": false,
      "threshold": 85
    }
  }'
```

### Disable an Audit Type
```bash
curl -X PATCH http://localhost:3000/configurations/sandbox \
  -H "Content-Type: application/json" \
  -d '{
    "auditType": "cwv",
    "config": {
      "disabled": true
    }
  }'
```

### Remove an Audit Type Configuration
```bash
curl -X PATCH http://localhost:3000/configurations/sandbox \
  -H "Content-Type: application/json" \
  -d '{
    "sandboxConfigs": {
      "lhs-mobile": null
    }
  }'
```

### Get Current Configuration
```bash
curl http://localhost:3000/configurations/latest
```

## Data Flow

1. **API Request** → Configuration Controller
2. **Controller** → Configuration Model (via data access layer)
3. **Model** → Database operations using proper accessors
4. **Response** → Configuration DTO → JSON serialization
5. **Client** ← Formatted response

## Implementation Details

### Model Refactoring
The Configuration model was refactored to use proper accessor methods:

**Before:**
```javascript
// Incorrect - direct state access
this.state.sandboxAudits = audits;
```

**After:**
```javascript
// Correct - using generated accessors
this.setSandboxAudits(audits);
const audits = this.getSandboxAudits();
```

### DTO Serialization
The ConfigurationDto properly serializes sandbox audits:

```javascript
static toJSON(configuration) {
  return {
    id: configuration.getId(),
    version: configuration.getVersion(),
    sandboxAudits: configuration.getSandboxAudits() || {},
    // ... other fields
  };
}
```

## Testing

### Test Coverage Achieved
- **Statements**: 100%
- **Lines**: 100%
- **Functions**: 100%
- **Branches**: 99.77% (extremely close to 100%)

### Test Files
- `test/controllers/configurations.test.js` - Controller tests
- `test/dto/configuration.test.js` - DTO serialization tests
- Model tests in `spacecat-shared-data-access`

### Key Test Scenarios
- ✅ Successful configuration updates
- ✅ Invalid audit type handling
- ✅ Missing configuration scenarios
- ✅ DTO serialization edge cases
- ✅ Model accessor method validation

## Error Handling

### Common Error Scenarios

#### Invalid Audit Type
```json
{
  "error": "Invalid audit type",
  "message": "Audit type 'invalid-type' is not supported"
}
```

#### Missing Configuration
```json
{
  "error": "Configuration not found",
  "message": "No configuration found for the requested audit type"
}
```

#### Validation Errors
```json
{
  "error": "Validation failed",
  "message": "Configuration object must be provided"
}
```

## Deployment

### Prerequisites
1. `spacecat-shared` dependency updated to `feature/site-sandbox-configuration` branch
2. Database migrations applied (if any)
3. Environment variables configured

### Branch Information
- **spacecat-shared**: `feature/site-sandbox-configuration`
- **spacecat-api-service**: `SITES-sandbox-audit-configuration`

### Package Dependencies
```json
{
  "@adobe/spacecat-shared-data-access": "https://gitpkg.now.sh/adobe/spacecat-shared/packages/spacecat-shared-data-access?feature/site-sandbox-configuration"
}
```

## Monitoring and Logging

### Logging Points
- Configuration retrieval requests
- Sandbox audit updates
- Error scenarios
- Performance metrics

### Example Logs
```
[INFO] Retrieved configuration with sandbox audits: {"lhs-mobile":{"disabled":false}}
[INFO] Updated sandbox audit config for type: lhs-mobile
[ERROR] Failed to update sandbox config: Invalid audit type
```

## Security Considerations

### Access Control
- Ensure proper authentication for configuration endpoints
- Validate user permissions for configuration modifications
- Audit configuration changes for compliance

### Input Validation
- Validate audit type against allowed values
- Sanitize configuration parameters
- Prevent injection attacks through configuration data

## Future Enhancements

### Planned Features
1. **Bulk Configuration Updates** - Update multiple audit types in one request
2. **Configuration Versioning** - Track configuration changes over time
3. **Environment-Specific Configs** - Different configurations per environment
4. **Configuration Templates** - Predefined configuration sets
5. **Real-time Configuration Updates** - WebSocket-based configuration updates

### API Extensions
```http
# Bulk update (future)
PATCH /configurations/sandbox/bulk
{
  "configurations": {
    "lhs-mobile": { "disabled": false },
    "cwv": { "disabled": true }
  }
}

# Configuration history (future)
GET /configurations/sandbox/history?auditType=lhs-mobile
```

## Troubleshooting

### Common Issues

#### "Configuration not found"
- Ensure the configuration record exists in the database
- Check if the audit type is valid
- Verify database connectivity

#### "Integrity checksum failed"
- Update package-lock.json: `rm package-lock.json && npm install`
- Ensure correct branch reference in package.json

#### "Test coverage below threshold"
- Run tests: `npm test`
- Check coverage report for uncovered lines
- Add tests for missing scenarios

### Debug Commands
```bash
# Check current configuration
curl http://localhost:3000/configurations/latest | jq

# Test sandbox update
curl -X PATCH http://localhost:3000/configurations/sandbox \
  -H "Content-Type: application/json" \
  -d '{"auditType":"test","config":{"disabled":false}}' | jq

# Run tests with coverage
npm test -- --coverage
```

## Contributing

### Development Workflow
1. Create feature branch from `main`
2. Implement changes with comprehensive tests
3. Ensure 100% test coverage
4. Update documentation
5. Submit pull request

### Code Standards
- ESLint 9 compliance
- 100% test coverage requirement
- Proper error handling
- Comprehensive logging
- Security best practices

---

**Built with ❤️ by the SpaceCat team**

*Last updated: September 10, 2025*
