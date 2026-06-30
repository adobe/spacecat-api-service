/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import {
  badRequest, forbidden, internalServerError, notFound, ok,
} from '@adobe/spacecat-shared-http-utils';
import { isValidUUID } from '@adobe/spacecat-shared-utils';
import AccessControlUtil from '../support/access-control-util.js';
// eslint-disable-next-line no-unused-vars
import { AuditPolicyDto, AuditPolicyRevisionDto } from '../dto/audit-policy.js';

const POLICY_TABLE = 'audit_policy';
// eslint-disable-next-line no-unused-vars
const REVISION_TABLE = 'audit_policy_revision';
// eslint-disable-next-line no-unused-vars
const UPSERT_RPC = 'wrpc_upsert_audit_policy';

// eslint-disable-next-line no-unused-vars
function getAuthor(context) {
  const profile = context.attributes?.authInfo?.getProfile?.();
  const identity = profile?.email || profile?.name;
  if (!identity) {
    context.log?.warn?.('audit-policy write has no authenticated identity; attributing to "system"');
    return 'system';
  }
  return identity;
}

export default function AuditPolicyController() {
  // Resolve site + client + read access.
  // Returns { error } on failure, else { site, siteId, client }.
  async function authorizeRead(context) {
    const { siteId } = context.params || {};
    if (!isValidUUID(siteId)) {
      return { error: badRequest('siteId is required and must be a UUID') };
    }
    const site = await context.dataAccess.Site.findById(siteId);
    if (!site) {
      return { error: notFound(`Site not found: ${siteId}`) };
    }
    const client = context.dataAccess.services?.postgrestClient;
    if (!client?.from) {
      return { error: internalServerError('PostgREST client is not available') };
    }
    const ac = AccessControlUtil.fromContext(context);
    if (!await ac.hasAccess(site)) {
      return { error: forbidden('Only users belonging to the organization can access the audit policy') };
    }
    return {
      site, siteId, client, ac,
    };
  }

  async function getPolicy(context) {
    const auth = await authorizeRead(context);
    if (auth.error) {
      return auth.error;
    }
    const { siteId, client } = auth;
    const { data, error } = await client
      .from(POLICY_TABLE).select('*').eq('site_id', siteId).maybeSingle();
    if (error) {
      context.log?.error?.(`audit-policy getPolicy failed: ${error.code} ${error.message}`);
      return internalServerError('Failed to read audit policy');
    }
    if (!data) {
      return ok(AuditPolicyDto.defaultDocument(siteId));
    }
    return ok(AuditPolicyDto.toJSON(data));
  }

  return { getPolicy };
}
