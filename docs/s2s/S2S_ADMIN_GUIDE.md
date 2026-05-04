# S2S Admin Operations Guide

This guide provides detailed instructions for Service-to-Service (S2S) administrators managing API consumers (Technical Accounts) in the SpaceCat API service.

---

## Table of Contents

- [S2S Admin Responsibilities](#s2s-admin-responsibilities)
- [Consumer Lifecycle Operations](#consumer-lifecycle-operations)
  - [1. Register Consumer](#1-register-consumer)
  - [2. Update/Upgrade Consumer](#2-updateupgrade-consumer)
  - [3. Suspend Consumer](#3-suspend-consumer)
  - [4. Revoke Consumer](#4-revoke-consumer)
- [Secret Rotation](#secret-rotation)
- [Capability Guidelines](#capability-guidelines)
- [Troubleshooting](#troubleshooting)

---

## S2S Admin Responsibilities

As an S2S Admin, you are responsible for:

1. **Consumer Registration**: Onboarding new service consumers (Technical Accounts) with appropriate capabilities
2. **Access Management**: Reviewing and approving capability upgrade requests with security scrutiny
3. **Security Enforcement**:
   - Scrutinizing write permission requests on all entities
   - Denying restricted capabilities (e.g., `fixEntity:write`, `organization:write`, `site:write`)
   - Ensuring least-privilege access principles
4. **Lifecycle Management**: Suspending or revoking consumer access when necessary
5. **Secret Rotation**: Coordinating secret rotation in response to security incidents or compromised credentials
6. **Audit Trail**: Maintaining visibility of all consumer operations through Slack notifications
7. **Environment Promotion**: Following dev → production workflow for all consumer operations

### Access Requirements

All consumer management operations require **S2S Admin** access (`is_s2s_admin` flag in your profile).

---

## Consumer Lifecycle Operations

### 1. Register Consumer

Registers a new Technical Account as an API consumer.

#### Pre-requisites

- Access to Adobe Developer Console for allowed IMS organization
- Consumer name and initial capabilities list

#### Registration Workflow

##### Step 0: Create Service-to-Service Account in Developer Console

Before registering a consumer in the SpaceCat API service, the Technical Account must first be created in Adobe Developer Console:

1. **Access Adobe Developer Console**:
   - **Stage**: Navigate to [Adobe Developer Console - Stage](https://developer-stage.adobe.com)
   - **Production**: Navigate to [Adobe Developer Console - Production](https://developer.adobe.com/console)
   - Select the appropriate IMS organization (must be an allowed org)
   - **Required Role**: You must have **System Admin** role to create the account

2. **Create OAuth Server-to-Server Credential**:
   - Follow the [official Adobe documentation](https://developer.adobe.com/developer-console/docs/guides/authentication/ServerToServerAuthentication/)
   - Create a new project or select an existing one
   - Add "OAuth Server-to-Server" credential type

3. **Generate Access Token**:
   - Once the credential is created, generate an access token from the Developer Console
   - Copy the access token - you'll need it for Step 1
   - Note the following values (automatically extracted during registration):
     - `client_id` (OAuth Client ID)
     - `technical_account_id` (Technical Account ID)
     - `ims_org_id` (IMS Organization ID)

> ⚠️ **IMPORTANT**: The Technical Account must be created in an **allowed IMS organization**:
> - **Stage**: "Aem Sites Optimizer UAT2"
> - **Production**: "Sites Internal"

##### Step 1: Register Consumer (Dev → Prod Workflow)

Execute the registration request in **development environment first**, then in **production** after confirmation.

```bash
POST /consumers/register
Headers:
  Authorization: Bearer <S2S_ADMIN_SESSION_TOKEN>
  x-ta-access-token: <TECHNICAL_ACCOUNT_ACCESS_TOKEN>
  Content-Type: application/json

{
  "consumerName": "Example Service Consumer",
  "capabilities": [
    "site:read",
    "audit:read",
    "organization:read"
  ]
}
```

> ⚠️ **IMPORTANT**: Execute in **dev environment first**. Only proceed to **production** after consumer team confirms dev registration is working correctly.

##### Step 2: Consumer Team Testing

- Consumer team validates access in dev environment
- Tests all required API endpoints
- Confirms capabilities are sufficient for their use case
- Once confirmed, S2S Admin executes the same registration request in production environment

#### Response

```json
{
  "consumerId": "550e8400-e29b-41d4-a716-446655440000",
  "clientId": "example-client-id",
  "technicalAccountId": "example-ta-id@techacct.adobe.com",
  "imsOrgId": "ABCD1234567890@AdobeOrg",
  "consumerName": "Example Service Consumer",
  "status": "ACTIVE",
  "capabilities": ["site:read", "audit:read", "organization:read"],
  "createdAt": "2026-03-09T10:30:00.000Z",
  "updatedAt": "2026-03-09T10:30:00.000Z"
}
```

#### Important Notes

- **IMS Organization Validation**: Ensure Technical Account is created in an allowed IMS organization
- **IMS Validation**: The access token is validated via Adobe IMS to extract identity fields
- **Duplicate Prevention**: Cannot register same `clientId` twice
- **Immutable Fields**: `clientId`, `technicalAccountId`, and `imsOrgId` are extracted from the token and cannot be changed later
- **Slack Notification**: Registration event is automatically posted to the configured S2S Slack channel
  - **Dev**: [#spacecat-services-dev](https://adobe.enterprise.slack.com/archives/C0AFP406ZK9)
  - **Prod**: [#spacecat-services](https://adobe.enterprise.slack.com/archives/C0AJ2DETDNY)
- **Initial Status**: All new consumers start with `ACTIVE` status

---

### 2. Update/Upgrade Consumer

Updates consumer details including name, capabilities, or status.

#### Use Cases

- Add new capabilities (capability upgrade)
- Remove unnecessary capabilities
- Change consumer name
- Change status to SUSPENDED (see [Suspend Consumer](#3-suspend-consumer))

#### Update Workflow

##### Step 1: Review Upgrade Request

When a consumer team requests capability changes:

1. **Scrutinize Write Permissions**: Carefully review requests for write capabilities on any entity
   - Examples: `audit:write`, `opportunity:write`
   - Verify legitimate business need
   - Consider security implications

2. **Check Restricted Capabilities**:
   > 🚨 **CRITICAL**: The following capabilities are RESTRICTED and must be explicitly denied:
   - `fixEntity:write` - Restricted capability for internal use only
   - `site:write` - Critical write access, rarely granted
   - `organization:write` - Critical write access, rarely granted

3. **Validate Capability Format**: All capabilities must follow `entity:operation` format
   - Valid: `site:read`, `opportunity:write`
   - Invalid: `admin`, `full-access`, `site-read`, `admin:*`

##### Step 2: Update in Development Environment

```bash
PATCH /consumers/{consumerId}
Headers:
  Authorization: Bearer <S2S_ADMIN_SESSION_TOKEN>
  Content-Type: application/json

{
  "capabilities": [
    "site:read",
    "audit:read",
    "audit:write",
    "organization:read"
  ]
}
```

##### Step 3: Consumer Team Testing

- Consumer team validates new capabilities in dev
- Tests new API operations
- Confirms upgrade meets requirements

##### Step 4: Update in Production Environment

> ⚠️ **IMPORTANT**: Only proceed to production after consumer team confirms dev upgrade is working correctly.

```bash
# Execute same update request in production
PATCH /consumers/{consumerId}
Headers:
  Authorization: Bearer <S2S_ADMIN_SESSION_TOKEN>
  Content-Type: application/json

{
  "capabilities": [
    "site:read",
    "audit:read",
    "audit:write",
    "organization:read"
  ]
}
```

#### Update Restrictions

- **Immutable Fields**: Cannot update `clientId`, `technicalAccountId`, or `imsOrgId`
- **Cannot Set REVOKED**: Cannot change status to `REVOKED` via update (use revoke endpoint)
- **Cannot Update Revoked Consumers**: Once revoked, consumers cannot be updated
- **Cannot Set revokedAt**: This field is managed by the revoke operation only

#### Example: Rename Consumer

```bash
PATCH /consumers/{consumerId}
Headers:
  Authorization: Bearer <S2S_ADMIN_SESSION_TOKEN>
  Content-Type: application/json

{
  "consumerName": "Updated Service Name"
}
```

---

### 3. Suspend Consumer

Temporarily disables a consumer's access without permanent revocation.

#### When to Suspend

- Temporary security concern requiring immediate access restriction
- Consumer service is undergoing maintenance
- Investigation of suspicious activity
- Non-compliance with API usage policies

#### Suspend Workflow

```bash
PATCH /consumers/{consumerId}
Headers:
  Authorization: Bearer <S2S_ADMIN_SESSION_TOKEN>
  Content-Type: application/json

{
  "status": "SUSPENDED"
}
```

#### Reactivate Suspended Consumer

```bash
PATCH /consumers/{consumerId}
Headers:
  Authorization: Bearer <S2S_ADMIN_SESSION_TOKEN>
  Content-Type: application/json

{
  "status": "ACTIVE"
}
```

#### Important Notes

- Suspended consumers can be reactivated
- Suspension is reversible (unlike revocation)
- All other consumer properties remain unchanged
- Slack notification sent on status change

---

### 4. Revoke Consumer

Permanently revokes a consumer's access. This operation is **irreversible**.

> 🚨 **CRITICAL WARNING**: Revocation is a **PERMANENT** and **IRREVERSIBLE** action.
>
> - Consumer status is set to `REVOKED`
> - Revocation timestamp is recorded
> - Consumer **CANNOT** be updated or reactivated after revocation
> - Only use when consumer access must be permanently terminated

#### When to Revoke

- Consumer service is being decommissioned permanently
- Security breach requiring permanent access termination
- Consumer violated terms of service
- Technical Account is being permanently retired

#### Revoke Workflow

##### Step 1: Confirm Revocation Decision

Before revoking, confirm:
- [ ] Revocation is necessary and justified
- [ ] Consumer team has been notified
- [ ] Alternative solutions (suspension) have been considered
- [ ] You understand this action **cannot be undone**

##### Step 2: Execute Revocation

```bash
POST /consumers/{consumerId}/revoke
Headers:
  Authorization: Bearer <S2S_ADMIN_SESSION_TOKEN>
```

##### Step 3: Response Confirmation

```json
{
  "consumerId": "550e8400-e29b-41d4-a716-446655440000",
  "clientId": "example-client-id",
  "status": "REVOKED",
  "revokedAt": "2026-03-09T15:45:00.000Z",
  "capabilities": ["site:read", "audit:read"],
  "updatedAt": "2026-03-09T15:45:00.000Z"
}
```

#### Post-Revocation

- Consumer immediately loses all API access
- All existing tokens for this consumer are no longer valid
- Consumer record remains in database for audit purposes
- Slack notification sent to S2S admin channel
- **No recovery possible** - must register new consumer if access needed again

---

## Secret Rotation

### Overview

Secret rotation is the process of invalidating and replacing compromised or expired Technical Account credentials.

### S2S Admin Role in Secret Rotation

As an S2S admin, you are responsible for:

1. **Receiving Rotation Requests**: On-call team may request secret rotation for security incidents
2. **Coordinating with Consumer Teams**: Notify affected consumer teams of rotation requirements
3. **Validating New Credentials**: Ensure new Technical Account tokens are properly configured
4. **Monitoring Post-Rotation**: Verify consumer services resume normal operation with new credentials

### Rotation Scenarios

#### Scenario 1: Compromised Credentials

**Trigger**: On-call team identifies credential compromise (e.g., leaked in logs, repository)

**Action Plan**:
1. **Immediate**: Suspend consumer to prevent unauthorized access
   ```bash
   PATCH /consumers/{consumerId}
   Headers:
     Authorization: Bearer <S2S_ADMIN_SESSION_TOKEN>
     Content-Type: application/json

   { "status": "SUSPENDED" }
   ```

2. **Notify**: Alert consumer team of compromise and rotation requirement

3. **Consumer Team**: Generates new Technical Account credentials in Adobe IMS

4. **Update**: Once new credentials are ready, consumer team provides new access token

5. **Validate**: Test new credentials in dev environment

6. **Reactivate**: Resume consumer access
   ```bash
   PATCH /consumers/{consumerId}
   Headers:
     Authorization: Bearer <S2S_ADMIN_SESSION_TOKEN>
     Content-Type: application/json

   { "status": "ACTIVE" }
   ```

#### Scenario 2: Scheduled Rotation

**Trigger**: Proactive security policy requiring periodic credential rotation

**Action Plan**:
1. **Notify**: Alert consumer team of upcoming rotation window

2. **Consumer Team**: Generates new Technical Account credentials

3. **Parallel Operation**: Consumer team updates their service with new credentials while old ones still work

4. **Verification**: Consumer team confirms new credentials work in dev/stage

5. **Completion**: Old credentials can be retired after cutover

### Secret Rotation Checklist

- [ ] Rotation reason documented (compromise vs. scheduled)
- [ ] Consumer team notified with timeline
- [ ] New Technical Account credentials generated (consumer team responsibility)
- [ ] New credentials tested in dev environment
- [ ] Consumer service updated with new credentials
- [ ] Old credentials retired/revoked in IMS (consumer team responsibility)
- [ ] Post-rotation verification completed
- [ ] Incident documented if security-related

---

## Capability Guidelines

### Capability Format

All capabilities must follow the format: `entity:operation`

**Valid Examples**:
- `site:read` - Read access to sites
- `audit:read` - Read access to audits
- `audit:write` - Write access to audits
- `opportunity:read` - Read access to opportunities
- `organization:read` - Read access to organizations

### Security Scrutiny Matrix

| Capability Type | Scrutiny Level | Approval Guidance |
|----------------|----------------|-------------------|
| `*:read` | Low | Generally safe, verify legitimate need |
| `*:write` (general) | **High** | Requires strong business justification |
| `*:delete` | **Critical** | Rarely granted, executive approval recommended |
| `fixEntity:write` | **RESTRICTED** | Never grant under any circumstances |
| `site:write` | **RESTRICTED** | Critical write access, rarely granted |
| `organization:write` | **RESTRICTED** | Critical write access, rarely granted |
| `admin:*` | **INVALID** | Invalid capability |

### Restricted Capabilities

The following capabilities are **RESTRICTED** and should **NEVER** be granted:

1. **`fixEntity:write`**: Restricted capability for internal use only
2. **`site:write`**: Critical write access to site configurations - rarely granted, requires executive approval
3. **`organization:write`**: Critical write access to organization configurations - rarely granted, requires executive approval
4. Wildcard capabilities (e.g., `*:*`, `*:write`)

### Review Questions for Write Permissions

When reviewing write permission requests, ask:

1. **Necessity**: Why does the consumer need write access? What is the specific use case?
2. **Scope**: Can read-only access with a separate update mechanism work instead?
3. **Impact**: What data could be modified? What is the blast radius of misuse?
4. **Alternatives**: Can the operation be performed through a different, more controlled mechanism?
5. **Audit**: Will modifications by this consumer be properly tracked and attributed?

### Principle of Least Privilege

Always grant the **minimum capabilities required** for the consumer's function:

✅ **Good**: `["site:read", "audit:read"]` for a monitoring service

❌ **Bad**: `["site:read", "site:write", "audit:read", "audit:write", "organization:write"]` for the same monitoring service

---

## Troubleshooting

### Issue: Registration Fails with "Only S2S admins can register consumers"

**Cause**: User does not have S2S Admin access

**Resolution**:
1. Verify you have `is_s2s_admin` flag in your profile
2. Contact your team lead to request S2S Admin access
3. Ensure you're using the correct authentication token with admin privileges

### Issue: Registration Fails with "Invalid or expired Technical Account access token"

**Cause**: IMS token validation failed

**Resolution**:
1. Verify token is correctly copied (no whitespace/truncation)
2. Confirm token is from a Technical Account (not user token)
3. Check token expiration - generate fresh token if needed
4. Verify Technical Account exists in correct IMS organization
5. Ensure IMS organization is in the allowed list

### Issue: Registration Fails with "Consumer with clientId already registered"

**Cause**: Technical Account already registered

**Resolution**:
1. Check existing consumers: `GET /consumers`
2. Look up by clientId: `GET /consumers/by-client-id/{clientId}`
3. If existing consumer found:
   - Use update endpoint to modify capabilities
   - If revoked, must register new Technical Account

### Issue: Update Fails with "Cannot update a revoked consumer"

**Cause**: Consumer status is `REVOKED`

**Resolution**:
- Revocation is permanent
- Must register a new Technical Account
- Cannot reuse revoked consumer

### Issue: Capability Validation Error

**Cause**: Capability format is invalid or contains restricted values

**Resolution**:
1. Verify format: `entity:operation` (e.g., `site:read`)
2. Check for typos: `site-read` → `site:read`
3. Remove invalid patterns: `admin:*`, `admin`, `full-access`
4. Ensure no wildcards: `*:write`

---

## Quick Reference

### List All Consumers
```bash
GET /consumers
Headers:
  Authorization: Bearer <S2S_ADMIN_SESSION_TOKEN>
```

### Get Consumer by ID
```bash
GET /consumers/{consumerId}
Headers:
  Authorization: Bearer <S2S_ADMIN_SESSION_TOKEN>
```

### Get Consumer by Client ID
```bash
GET /consumers/by-client-id/{clientId}
Headers:
  Authorization: Bearer <S2S_ADMIN_SESSION_TOKEN>
```

### Register Consumer
```bash
POST /consumers/register
Headers:
  Authorization: Bearer <S2S_ADMIN_SESSION_TOKEN>
  x-ta-access-token: <TOKEN>
Body: { "consumerName": "...", "capabilities": [...] }
```

### Update Consumer
```bash
PATCH /consumers/{consumerId}
Headers:
  Authorization: Bearer <S2S_ADMIN_SESSION_TOKEN>
Body: { "consumerName": "...", "capabilities": [...], "status": "..." }
```

### Revoke Consumer (IRREVERSIBLE)
```bash
POST /consumers/{consumerId}/revoke
Headers:
  Authorization: Bearer <S2S_ADMIN_SESSION_TOKEN>
```

---

## Additional Resources

- **Adobe Server-to-Server Authentication**: https://developer.adobe.com/developer-console/docs/guides/authentication/ServerToServerAuthentication/
- **SpaceCat API Documentation**: https://opensource.adobe.com/spacecat-api-service/
- **Data Model**: `@adobe/spacecat-shared-data-access` (Consumer model)

---

## Change Log

| Date | Version | Changes |
|------|---------|---------|
| 2026-03-09 | 1.0 | Initial S2S Admin Operations Guide |

---

**Document Maintained By**: S2S Admin Team
**Last Updated**: 2026-03-09
**Review Frequency**: Quarterly or as needed for process changes
