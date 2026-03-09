# Secret Rotation Guide for S2S Consumers

This guide provides direction for rotating OAuth Server-to-Server client secrets for registered consumers.

> 📘 **Official Documentation**: For detailed technical steps, refer to Adobe's [Rotating Client Secrets](https://developer.adobe.com/developer-console/docs/guides/authentication/ServerToServerAuthentication/implementation#rotating-client-secrets) documentation as the single source of truth.

---

## When to Rotate Secrets

### Mandatory Rotation
- **Credential Compromise**: Immediately rotate if secrets are leaked in logs, repositories, or exposed publicly
- **Security Incident**: As directed by the on-call team or security response

---

## Rotation Workflow

### Overview

The rotation process uses a **dual-credential period** where both old and new secrets are active simultaneously, enabling zero-downtime migration.

```
[Old Secret Active] ─────────────────────────────> [Deleted]
                    [New Secret Added] ───────────> [Primary]
                         └─ Transition Period ─┘
```

### Responsibilities

| Step | Owner | Action |
|------|-------|--------|
| 1 | S2S Admin | Add new secret in Developer Console |
| 2 | Consumer Team | Update application to use new secret |
| 3 | Consumer Team | Deploy and verify new secret works |
| 4 | S2S Admin | Monitor old secret usage (last-used timestamp) |
| 5 | S2S Admin | Delete old secret after confirmation |
| 6 | S2S Admin | Monitor for access issues |

---

## Step-by-Step Process

### Step 1: Add New Secret

**S2S Admin** generates a new client secret in Adobe Developer Console.

> 🔗 **How to**: Follow Adobe's [Add New Secret](https://developer.adobe.com/developer-console/docs/guides/authentication/ServerToServerAuthentication/implementation#rotating-client-secrets) instructions

- Multiple secrets can be active simultaneously
- The new secret is immediately active upon creation
- S2S Admin provides the new secret to consumer team securely

### Step 2: Update Application

**Consumer Team** updates their application/service to use the new client secret.

- Update environment variables or secret management systems
- **Do NOT delete the old secret yet** - both should coexist during transition
- Test token generation with new secret in non-production environment first

### Step 3: Deploy Changes

**Consumer Team** deploys the updated application.

- Deploy to staging/dev environment first
- Validate token generation and API access work correctly
- Roll out to production after successful validation

### Step 4: Verify Transition

**Consumer Team** confirms deployment is complete and notifies **S2S Admin**.

**S2S Admin** verifies the old secret is no longer in use:
- Check **"Last Used"** timestamp in Developer Console for the old secret
- Wait sufficient time to ensure all application instances have picked up new secret
- Account for pod restarts, cache invalidation, and deployment cycles

> ⏱️ **Recommended Wait Time**: At least 24-48 hours in production to ensure all instances transition

### Step 5: Delete Old Secret

**S2S Admin** removes the old secret from Developer Console after consumer team confirmation.

> ⚠️ **WARNING**: Deletion is **permanent and irreversible**. Ensure the old secret is no longer used anywhere.

- Verify "Last Used" timestamp confirms inactivity
- Confirm with consumer team that transition is complete
- Delete via Developer Console UI or API
- Document the rotation in change log

---

## Emergency Rotation (Compromised Credentials)

When credentials are compromised, speed is critical while maintaining service availability.

### Immediate Actions

1. **Notify S2S Admin**: Alert via designated Slack channel or on-call team
2. **S2S Admin Suspends Consumer** (Optional): Temporarily suspend if unauthorized access is detected
3. **S2S Admin Rotates Secret**: Add new secret in Developer Console
4. **Consumer Team Validates**: Test new secret in dev environment
5. **Consumer Team Deploys**: Emergency deploy to production
6. **S2S Admin Reactivates** (if suspended): Resume consumer access after deployment confirmed

### Accelerated Timeline

- **S2S Admin adds new secret**: Immediate
- **Consumer team deploys with new secret**: Within hours (follow your emergency change process)
- **S2S Admin deletes old secret**: As soon as new deployment is verified (same day)

---

## Coordination with S2S Admin

### When to Involve S2S Admin

The S2S Admin **performs the secret rotation** in Developer Console. Consumer team should notify S2S Admin for:

1. **Compromised credentials**: Immediate notification required for emergency rotation
2. **Access issues during rotation**: If API returns authentication errors
3. **Planned maintenance rotation**: For scheduled secret updates

### What S2S Admin Does

- **Add new secret**: Generate new client secret in Developer Console
- **Delete old secret**: Remove old secret after consumer team confirms transition complete
- **Suspend consumer**: Temporarily block access via `PATCH /consumers/{consumerId}` with `status: "SUSPENDED"` (if needed during security incidents)
- **Reactivate consumer**: Restore access after rotation complete
- **Monitor activity**: Check consumer access logs and "Last Used" timestamps
- **Coordinate incident response**: Facilitate communication with security team

### What Consumer Team Does

- **Request rotation**: Notify S2S Admin when rotation is needed
- **Update application**: Implement new secret in their application/service
- **Test and deploy**: Validate new secret works and deploy to production
- **Confirm transition**: Notify S2S Admin when old secret is no longer in use

---

## Troubleshooting

### Issue: New Secret Doesn't Work

**Symptoms**: Authentication errors after deploying new secret

**Resolution**:
1. Verify secret was copied correctly (no whitespace/truncation)
2. Ensure correct client ID is being used
3. Check token generation endpoint response for specific errors
4. Verify IMS organization hasn't changed
5. If old secret still works, roll back deployment temporarily

### Issue: Service Outage After Deleting Old Secret

**Symptoms**: Authentication failures after old secret deletion

**Cause**: Some application instances still using old secret

**Resolution**:
1. **Emergency**: S2S Admin adds a new secret immediately (old secret cannot be restored)
2. Consumer team updates application with the newly added secret
3. Consumer team emergency deploys to all instances
4. **Prevention**: S2S Admin should always verify "Last Used" timestamp and confirm with consumer team before deletion

### Issue: Cannot Delete Old Secret

**Cause**: Old secret was recently used

**Resolution**:
1. S2S Admin checks "Last Used" timestamp in Developer Console
2. Contact consumer team to verify deployment status
3. Consumer team may need to force restart all application pods/instances to pick up new secret
4. S2S Admin re-verifies timestamp before deletion

---

## Best Practices

### ✅ Do

- **Test in non-production first**: Consumer team should validate rotation in dev/staging before production
- **Monitor "Last Used" timestamp**: S2S Admin should wait for confirmed inactivity before deletion
- **Document rotations**: S2S Admin maintains audit trail of when and why secrets were rotated
- **Coordinate between teams**: Clear communication between S2S Admin and consumer team
- **Use secret management systems**: Consumer team should store secrets in vault systems, not in code
- **Secure secret transfer**: S2S Admin should share new secrets via encrypted/secure methods only

### ❌ Don't

- **Don't delete old secret immediately**: S2S Admin must allow transition period for application instances
- **Don't store secrets in code repositories**: Consumer team must use environment variables or secret managers
- **Don't share secrets via insecure channels**: Always use encrypted/secure methods
- **Don't skip testing**: Consumer team must verify new secret works before production deployment
- **Don't ignore "Last Used" timestamp**: S2S Admin must check this before deletion

---

## Quick Reference

### S2S Admin Actions
```bash
# 1. Add new secret in Developer Console (follow Adobe docs)
# 2. Provide new secret to consumer team securely
# 3. Wait for consumer team to deploy
# 4. Monitor "Last Used" timestamp for old secret
# 5. Delete old secret after consumer team confirms transition
```

### Consumer Team Actions
```bash
# 1. Request rotation from S2S Admin
# 2. Receive new secret from S2S Admin
# 3. Update application with new secret
# 4. Deploy application
# 5. Confirm transition complete to S2S Admin
```

### S2S Admin - Consumer Suspend/Reactivate (Emergency)
```bash
# Suspend consumer (if needed during security incident)
PATCH /consumers/{consumerId}
Headers:
  Authorization: Bearer <S2S_ADMIN_SESSION_TOKEN>
  Content-Type: application/json
Body:
  { "status": "SUSPENDED" }

# Reactivate after rotation
PATCH /consumers/{consumerId}
Headers:
  Authorization: Bearer <S2S_ADMIN_SESSION_TOKEN>
  Content-Type: application/json
Body:
  { "status": "ACTIVE" }
```

---

## Additional Resources

- **Official Adobe Documentation**: [Rotating Client Secrets](https://developer.adobe.com/developer-console/docs/guides/authentication/ServerToServerAuthentication/implementation#rotating-client-secrets)
- **S2S Admin Operations Guide**: `docs/s2s/S2S_ADMIN_GUIDE.md`
- **Developer Console (Stage)**: https://developer-stage.adobe.com
- **Developer Console (Production)**: https://developer.adobe.com/console

---

**Document Owner**: S2S Admin Team
**Last Updated**: 2026-03-09
**Review Frequency**: Quarterly or after major security incidents
