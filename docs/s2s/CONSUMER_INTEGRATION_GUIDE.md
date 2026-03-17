# S2S Consumer Integration Guide

This guide helps service teams request and integrate Service-to-Service (S2S) authentication for accessing the SpaceCat API.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Request S2S Account](#request-s2s-account)
- [Integration Steps](#integration-steps)
- [Testing](#testing)
- [Production Deployment](#production-deployment)
- [Troubleshooting](#troubleshooting)
- [Quick Reference](#quick-reference)

---

## Prerequisites

Before requesting an S2S account, ensure you have:

### Technical Requirements
- **Service/Application**: A service that needs programmatic access to SpaceCat API
- **Required Capabilities**: Clear understanding of which SpaceCat API endpoints you need to access

---

## Request S2S Account

### Step 1: Create JIRA Ticket

Create a JIRA ticket in the **SITES** project with the following information:

**JIRA Template**:

```
Title: S2S Consumer Registration Request - [Your Service Name]

Service Information:
- Service Name: [e.g., Analytics Service Connector]
- Hosted Platform: [AWS / Ethos / Azure / Other]
- Secrets Location: [e.g., AWS Secrets Manager path, HashiCorp Vault path, etc.]
- Estimated Requests per Minute: [e.g., 10 RPM, 100 RPM]
- Multi-Org Scope Access Required: [Yes / No]

Required Access:
List of SpaceCat API Service Endpoints:
- [e.g., GET /sites]
- [e.g., GET /sites/{siteId}/audits]
- [e.g., GET /sites/{siteId}/opportunities]
- [e.g., POST /audits]
- [Add all endpoints you need to access]

Use Case Description:
[Brief description of how your service will use the SpaceCat API]

Environment:
- [ ] Development
- [ ] Production

Technical Contact:
- Name:
- Email:
- Slack Handle:
```

> ⚠️ **IMPORTANT**:
- Share ticket on channel [#aem-sites-optimizer-engineering](https://adobe.enterprise.slack.com/archives/C05A45JBP9N) with taging group `@mysticat-s2s-admin`.
- Permission is subject to approval. The SpaceCat Security Team reserves the right to grant or deny access based on security requirements and business justification.

### Step 2: Capability Review & Approval

The S2S Admin and SpaceCat Security Team will review your JIRA request:

- **Read capabilities** (`*:read`): Generally approved quickly
- **Write capabilities** (`*:write`): Require business justification and scrutiny
- **Restricted capabilities**: The following are typically denied:
  - `fixEntity:write` - Never granted
  - `site:write` - Rarely granted, requires executive approval
  - `organization:write` - Rarely granted, requires executive approval

The team will respond via JIRA with approval or request additional information.

> 💡 **Tip**: Request only the minimum capabilities you need. You can request upgrades later via a new JIRA ticket if needed.

### Step 3: Provisioning

Once approved, the SpaceCat Security Team will:

1. **Create OAuth Server-to-Server credential** in Adobe Developer Console
2. **Register your consumer** in the SpaceCat API service
3. **Store credentials securely** in your service's specified secret location (from JIRA template)
4. **Confirm approved capabilities** and notify you when provisioning is complete

> 🔐 **Security Note**: Credentials (Client ID and Client Secret) will be automatically stored in your specified secret location. No manual credential sharing is required.

---

## Integration Steps

### Authentication Flow Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│ 1. Your Service → IMS                                               │
│    Generate IMS Access Token (24h lifetime)                         │
│    Using: Client ID + Client Secret                                 │
└─────────────────────────────────────────────────────────────────────┘
                               ↓
┌─────────────────────────────────────────────────────────────────────┐
│ 2. Your Service → SpaceCat S2S Login                                │
│    Exchange IMS Token for Session Token (15min lifetime)            │
│    Endpoint: POST /auth/s2s/login                                   │
│    Payload: { imsOrgId or domainBaseURL }                           │
└─────────────────────────────────────────────────────────────────────┘
                               ↓
┌─────────────────────────────────────────────────────────────────────┐
│ 3. Your Service → SpaceCat API                                      │
│    Use Session Token for API calls                                  │
│    Header: Authorization: Bearer {sessionToken}                     │
│    Refresh session token before 15min expiration                    │
└─────────────────────────────────────────────────────────────────────┘
```

> 📝 **Note**: All code examples below use **Development/Stage environment** endpoints (`api/ci`, `ims-na1-stg1`). For production deployment, replace with production endpoints (`api/v1`, `ims-na1`). See [Environment URLs](#environment-urls) table for details.

### Step 1: Generate IMS Access Token

Retrieve your OAuth Server-to-Server credentials from your service's secret location (configured during provisioning), then generate an IMS access token:

```bash
# Sample curl command to get IMS access token for your registered consumer
curl -X POST 'https://ims-na1-stg1.adobelogin.com/ims/token/v3' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'grant_type=client_credentials&client_id=<client_id>&client_secret=<client_secret>&scope=openid,AdobeID,user_management_sdk'
```

```javascript
// Example using Node.js
const axios = require('axios');

async function getIMSAccessToken() {
  // Retrieve credentials from your secret management system
  const clientId = process.env.CLIENT_ID; // or retrieve from secret manager
  const clientSecret = process.env.CLIENT_SECRET; // or retrieve from secret manager

  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'openid,AdobeID,user_management_sdk'
  });

  const response = await axios.post(
    'https://ims-na1-stg1.adobelogin.com/ims/token/v3',
    params,
    {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    }
  );

  return response.data.access_token;
}
```

> 🔐 **Credentials Location**: Your Client ID and Client Secret are stored in the secret location you specified in your JIRA request.

### Step 2: Exchange IMS Token for SpaceCat Session Token

Call the SpaceCat S2S login endpoint to exchange your IMS access token for a short-lived session token:

```bash
# Sample curl command to get SpaceCat session token
curl --request POST \
  --url https://spacecat.experiencecloud.live/api/ci/auth/s2s/login \
  --header 'Authorization: Bearer <IMS_ACCESS_TOKEN>' \
  --header 'Content-Type: application/json' \
  --data '{
    "imsOrgId": "<SCOPED_IMS_ORG_ID>"
  }'
```

```javascript
async function getSpaceCatSessionToken(imsAccessToken, imsOrgId) {
  const response = await axios.post(
    'https://spacecat.experiencecloud.live/api/ci/auth/s2s/login',
    {
      // Option 1: Using IMS Org ID (scoped)
      imsOrgId: imsOrgId,

      // Option 2: Using Domain Base URL (alternative to imsOrgId)
      // domainBaseURL: 'https://example.com'
    },
    {
      headers: {
        'Authorization': `Bearer ${imsAccessToken}`,
        'Content-Type': 'application/json'
      }
    }
  );

  return response.data.sessionToken;
}
```

> 📝 **Session Token Lifetime**: Session tokens are valid for **15 minutes**. You must refresh before expiration.

### Step 3: Call SpaceCat API with Session Token

Use the session token for subsequent SpaceCat API calls:

```javascript
// Example: Get all sites
async function getSites(sessionToken) {
  const response = await axios.get(
    'https://spacecat.experiencecloud.live/api/ci/sites',
    {
      headers: {
        'Authorization': `Bearer ${sessionToken}`,
        'Content-Type': 'application/json'
      }
    }
  );

  return response.data;
}

// Example: Get opportunities for a specific site
async function getSiteOpportunities(sessionToken, siteId) {
  const response = await axios.get(
    `https://spacecat.experiencecloud.live/api/ci/sites/${siteId}/opportunities`,
    {
      headers: {
        'Authorization': `Bearer ${sessionToken}`,
        'Content-Type': 'application/json'
      }
    }
  );

  return response.data;
}
```

### Step 4: Implement Token Caching and Refresh

Implement caching for both IMS and session tokens with automatic refresh:

> ⚠️ **Lambda/Serverless Note**: The following caching pattern uses module-level variables which persist across invocations in the same container. For AWS Lambda or similar serverless environments, consider using external caching (Redis, ElastiCache) for cross-invocation token reuse.

```javascript
let cachedIMSToken = null;
let imsTokenExpiry = null;
let cachedSessionToken = null;
let sessionTokenExpiry = null;

async function getValidIMSToken() {
  // Check if cached IMS token is still valid (with 5 min buffer)
  if (cachedIMSToken && imsTokenExpiry && Date.now() < imsTokenExpiry - 300000) {
    return cachedIMSToken;
  }

  // Generate new IMS token
  cachedIMSToken = await getIMSAccessToken();

  // IMS tokens expire in 24 hours
  imsTokenExpiry = Date.now() + (24 * 60 * 60 * 1000);

  return cachedIMSToken;
}

async function getValidSessionToken(imsOrgId) {
  // Check if cached session token is still valid (with 2 min buffer)
  if (cachedSessionToken && sessionTokenExpiry && Date.now() < sessionTokenExpiry - 120000) {
    return cachedSessionToken;
  }

  // Get valid IMS token
  const imsToken = await getValidIMSToken();

  // Exchange for new session token
  cachedSessionToken = await getSpaceCatSessionToken(imsToken, imsOrgId);

  // Session tokens expire in 15 minutes
  sessionTokenExpiry = Date.now() + (15 * 60 * 1000);

  return cachedSessionToken;
}
```

### Step 5: Complete Integration with Error Handling

Combine all steps with proper error handling:

```javascript
async function callSpaceCatAPIWithAuth(imsOrgId, endpoint) {
  try {
    // Get valid session token (auto-refreshes if needed)
    const sessionToken = await getValidSessionToken(imsOrgId);

    // Call SpaceCat API
    const response = await axios.get(
      `https://spacecat.experiencecloud.live/api/ci${endpoint}`,
      {
        headers: {
          'Authorization': `Bearer ${sessionToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return response.data;
  } catch (error) {
    if (error.response?.status === 401) {
      // Token expired - clear cache and retry once
      cachedSessionToken = null;
      cachedIMSToken = null;

      const sessionToken = await getValidSessionToken(imsOrgId);
      const response = await axios.get(
        `https://spacecat.experiencecloud.live/api/ci${endpoint}`,
        {
          headers: {
            'Authorization': `Bearer ${sessionToken}`,
            'Content-Type': 'application/json'
          }
        }
      );
      return response.data;
    }
    throw error;
  }
}

// Usage examples
const sites = await callSpaceCatAPIWithAuth('YOUR_IMS_ORG_ID', '/sites');

// Get opportunities for a specific site
const siteId = '123e4567-e89b-12d3-a456-426614174000';
const opportunities = await callSpaceCatAPIWithAuth(
  'YOUR_IMS_ORG_ID',
  `/sites/${siteId}/opportunities`
);
```

---

## Testing

### Development Environment Testing

#### 1. Verify IMS Token Generation

```bash
# Test IMS token generation (retrieve CLIENT_ID and CLIENT_SECRET from your secret location)
curl -X POST 'https://ims-na1-stg1.adobelogin.com/ims/token/v3' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d "grant_type=client_credentials&client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}&scope=openid,AdobeID,user_management_sdk"
```

**Expected Response**:
```json
{
  "access_token": "eyJ...",
  "token_type": "bearer",
  "expires_in": 86399
}
```

#### 2. Exchange IMS Token for Session Token

```bash
# Get SpaceCat session token
IMS_TOKEN="<IMS_ACCESS_TOKEN_FROM_STEP_1>"

curl --request POST \
  --url https://spacecat.experiencecloud.live/api/ci/auth/s2s/login \
  --header "Authorization: Bearer ${IMS_TOKEN}" \
  --header 'Content-Type: application/json' \
  --data "{
    \"imsOrgId\": \"${IMS_ORG_ID}\"
  }"
```

**Expected Response**:
```json
{
  "sessionToken": "eyJ..."
}
```

#### 3. Test SpaceCat API Access

```bash
# Test SpaceCat API with session token - Get all sites
SESSION_TOKEN="<SESSION_TOKEN_FROM_STEP_2>"

curl -X GET https://spacecat.experiencecloud.live/api/ci/sites \
  -H "Authorization: Bearer ${SESSION_TOKEN}"
```

**Expected Response**: 200 with sites array

#### 4. Test Required Endpoints

Verify all endpoints from your JIRA request work correctly:

```bash
# Example 1: Get opportunities for a site
SITE_ID="<SITE_UUID>"
curl -X GET https://spacecat.experiencecloud.live/api/ci/sites/${SITE_ID}/opportunities \
  -H "Authorization: Bearer ${SESSION_TOKEN}"

# Example 2: Get audits for a site
curl -X GET https://spacecat.experiencecloud.live/api/ci/sites/${SITE_ID}/audits \
  -H "Authorization: Bearer ${SESSION_TOKEN}"
```

**Expected Response**: 200 with data for each endpoint

#### 5. Test Token Expiration

Verify your token refresh logic works:
- Wait 15+ minutes and confirm session token expires
- Confirm your code automatically refreshes the token
- Test that requests continue to work after refresh

### Validation Checklist

- [ ] IMS token generation succeeds
- [ ] S2S login endpoint returns session token
- [ ] Session token works for API calls
- [ ] API returns 200 responses (not 401/403)
- [ ] All required endpoints are accessible
- [ ] Write operations work (if write capabilities granted)
- [ ] Token refresh works before 15 minute expiration
- [ ] Error handling works for expired tokens
- [ ] 403 errors are handled with proper logging

---

## Production Deployment

### Pre-Production Checklist

Before deploying to production:

1. **Dev Testing Complete**: All functionality verified in development environment
2. **Production Registration**: S2S Admin has registered your consumer in production
3. **Credentials Secured**: Production credentials stored in secure secret management
4. **Monitoring Setup**: Logging and alerting configured for authentication failures
5. **Documentation**: Internal documentation updated with integration details

### Deployment Steps

1. **Deploy Configuration**: Update production environment with production credentials
2. **Verify Connection**: Test token generation and API access in production
3. **Monitor**: Watch logs for authentication errors or API failures
4. **Notify S2S Admin**: Confirm production deployment successful

### Post-Deployment

- Monitor API response times and error rates
- Set up alerts for authentication failures (401/403 responses)
- Document any issues for future reference
- Plan for capability upgrades if needed

---

## Troubleshooting

### Issue: IMS Token Generation Fails

**Symptoms**: Error when requesting access token from IMS

**Common Causes**:
- Incorrect client ID or client secret
- Technical Account not in allowed IMS organization
- Network connectivity issues

**Resolution**:
1. Verify credentials from your secret location are correct (no whitespace/truncation)
2. Contact SpaceCat Security Team via JIRA if credentials appear invalid
3. Test with curl to isolate application vs. credential issues

```bash
# Test IMS token generation
curl -X POST 'https://ims-na1-stg1.adobelogin.com/ims/token/v3' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d "grant_type=client_credentials&client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}&scope=openid,AdobeID,user_management_sdk"
```

### Issue: S2S Login Endpoint Returns 401 Unauthorized

**Symptoms**: `/auth/s2s/login` endpoint returns 401 response

**Common Causes**:
- IMS access token expired or invalid
- Consumer not registered in SpaceCat
- Invalid IMS token format

**Resolution**:
1. Generate fresh IMS access token
2. Verify token is passed in `Authorization: Bearer {imsToken}` header
3. Confirm consumer is registered (check JIRA ticket status)
4. Verify using correct environment endpoint (dev vs. prod)

### Issue: API Returns 401 Unauthorized

**Symptoms**: SpaceCat API endpoints return 401 response

**Common Causes**:
- Session token expired (15 minute lifetime)
- Consumer is suspended
- Invalid session token format

**Resolution**:
1. Generate fresh session token from `/auth/s2s/login` endpoint
2. Verify session token is passed in `Authorization: Bearer {sessionToken}` header
3. Implement automatic token refresh before 15 minute expiration
4. Check consumer status with S2S Admin via JIRA or Slack

### Issue: API Returns 403 Forbidden

**Symptoms**: SpaceCat API endpoints return 403 response

> ⚠️ **Most Common Cause**: **403 response indicates your S2S consumer does not have the required capability to access this endpoint.**

**Common Causes**:
1. **Missing Capability**: Consumer lacks required capability for the endpoint
2. **Consumer Suspended**: Consumer status is `SUSPENDED` or `REVOKED`
3. **Multi-Org Access Issue**: Attempting to access resources outside your approved IMS org scope
4. **Restricted Resource**: Attempting to access a resource you don't have permission for

**Resolution**:
1. **Check Approved Capabilities**: Review your approved capabilities in the JIRA ticket
   - Example: Accessing `POST /audits` requires `audit:write` capability
   - Example: Accessing `GET /sites` requires `site:read` capability
2. **Request Capability Upgrade**: If you need access to additional endpoints, create a new JIRA ticket
3. **Check Consumer Status**: Ensure consumer is `ACTIVE` via S2S Admin
4. **Verify IMS Org Scope**: Confirm you're accessing resources within your approved IMS organization
5. **Review Endpoint Requirements**: Check API documentation for required capabilities

**Common Capability to Endpoint Mapping Examples**:
```
GET /sites                              → site:read
POST /sites                             → site:write
GET /sites/{siteId}/audits              → audit:read
POST /audits                            → audit:write
GET /sites/{siteId}/opportunities       → opportunity:read
POST /sites/{siteId}/opportunities      → opportunity:write
GET /organizations                      → organization:read
PATCH /organizations/{id}               → organization:write
```

### Issue: Consumer Suspended

**Symptoms**: All API calls return 403, even with valid token

**Cause**: S2S Admin suspended consumer (usually for security reasons)

**Resolution**:
1. Contact S2S Admin via Slack
2. Determine reason for suspension
3. Address security concerns if applicable
4. Request reactivation once resolved

### Issue: Need Additional Capabilities

**Symptoms**: 403 errors when accessing specific endpoints

**Process**:
1. Contact S2S Admin via Slack
2. Request capability upgrade with business justification
3. S2S Admin reviews and approves (or denies) request
4. Test upgraded capabilities in dev first
5. Request production upgrade after dev validation

---

## Capability Reference

### Common Capabilities

| Capability | Description | Typical Use Case |
|-----------|-------------|------------------|
| `site:read` | Read site information | Retrieve site details, configurations |
| `site:write` | Modify site information | Update site settings (rarely granted) |
| `audit:read` | Read audit results | Access audit data, performance metrics |
| `audit:write` | Trigger audits | Initiate audit jobs |
| `organization:read` | Read organization info | List organizations, get org details |
| `organization:write` | Modify organizations | Update org settings (rarely granted) |
| `opportunity:read` | Read opportunities | Access recommendations, issues |
| `suggestion:read` | Read AI suggestions | Access AI-generated suggestions |

### Restricted Capabilities (Typically Denied)

- `fixEntity:write` - Never granted, internal use only
- `site:write` - Rarely granted, requires executive approval
- `organization:write` - Rarely granted, requires executive approval

---

## Best Practices

### Security

- **Use Secret Management**: Store credentials in vault systems (AWS Secrets Manager, HashiCorp Vault, etc.)
- **Rotate Secrets Periodically**: Coordinate with S2S Admin for secret rotation
- **Monitor Access**: Log all API calls for audit trail
- **Implement Rate Limiting**: Respect API rate limits to avoid throttling
- **Secure Token Cache**: If caching tokens, ensure cache is encrypted

### Integration

- **Start with Minimum Capabilities**: Request only what you need, upgrade later if needed
- **Test in Dev First**: Always validate in dev before production deployment
- **Implement Retry Logic**: Handle transient failures with exponential backoff
- **Log Authentication Errors**: Track 401/403 responses for troubleshooting
- **Document Integration**: Maintain internal documentation of your S2S integration

### Operational

- **Monitor Token Expiry**: Implement token refresh before expiration
- **Set Up Alerts**: Alert on authentication failures or API errors
- **Plan for Incidents**: Have runbook for handling S2S account issues
- **Coordinate with S2S Admin**: Notify admin of planned maintenance or issues

---

## Quick Reference

### Complete Authentication Flow (curl)

```bash
# Retrieve CLIENT_ID and CLIENT_SECRET from your secret location

# Step 1: Generate IMS Access Token
IMS_RESPONSE=$(curl -s -X POST 'https://ims-na1-stg1.adobelogin.com/ims/token/v3' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d "grant_type=client_credentials&client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}&scope=openid,AdobeID,user_management_sdk")

IMS_TOKEN=$(echo $IMS_RESPONSE | jq -r '.access_token')

# Step 2: Exchange for SpaceCat Session Token
SESSION_RESPONSE=$(curl -s --request POST \
  --url https://spacecat.experiencecloud.live/api/ci/auth/s2s/login \
  --header "Authorization: Bearer ${IMS_TOKEN}" \
  --header 'Content-Type: application/json' \
  --data "{\"imsOrgId\": \"${IMS_ORG_ID}\"}")

SESSION_TOKEN=$(echo $SESSION_RESPONSE | jq -r '.sessionToken')

# Step 3: Call SpaceCat API
# Example: Get all sites
curl -X GET https://spacecat.experiencecloud.live/api/ci/sites \
  -H "Authorization: Bearer ${SESSION_TOKEN}"

# Example: Get opportunities for a site
SITE_ID="<SITE_UUID>"
curl -X GET https://spacecat.experiencecloud.live/api/ci/sites/${SITE_ID}/opportunities \
  -H "Authorization: Bearer ${SESSION_TOKEN}"
```

### Environment URLs

| Environment | IMS Token Endpoint | SpaceCat S2S Login | SpaceCat API Base |
|-------------|-------------------|-------------------|-------------------|
| **Development/Stage** | `https://ims-na1-stg1.adobelogin.com/ims/token/v3` | `https://spacecat.experiencecloud.live/api/ci/auth/s2s/login` | `https://spacecat.experiencecloud.live/api/ci` |
| **Production** | `https://ims-na1.adobelogin.com/ims/token/v3` | `https://spacecat.experiencecloud.live/api/v1/auth/s2s/login` | `https://spacecat.experiencecloud.live/api/v1` |

### Token Lifetimes

| Token Type | Lifetime | Refresh Strategy |
|-----------|----------|------------------|
| **IMS Access Token** | 24 hours | Cache and refresh before expiration (with 5min buffer) |
| **SpaceCat Session Token** | 15 minutes | Cache and refresh before expiration (with 2min buffer) |

---

## Additional Resources

- **S2S Admin Operations Guide**: `docs/s2s/S2S_ADMIN_GUIDE.md`
- **Secret Rotation Guide**: `docs/s2s/SECRET_ROTATION_GUIDE.md`
- **Adobe Server-to-Server Authentication**: [Official Documentation](https://developer.adobe.com/developer-console/docs/guides/authentication/ServerToServerAuthentication/)
- **SpaceCat API Documentation**: [API Reference](https://opensource.adobe.com/spacecat-api-service/)

### Contact

- **Dev Support**: [#spacecat-services-dev](https://adobe.enterprise.slack.com/archives/C0AFP406ZK9)
- **Prod Support**: [#spacecat-services](https://adobe.enterprise.slack.com/archives/C0AJ2DETDNY)
- **S2S Admin Team**: Contact via Slack channels above

---

**Document Owner**: S2S Admin Team
**Target Audience**: Consumer Service Teams
**Last Updated**: 2026-03-09
**Review Frequency**: Quarterly or as S2S process changes
