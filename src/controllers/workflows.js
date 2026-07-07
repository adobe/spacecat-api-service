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
  badRequest,
  notFound,
  internalServerError,
  ok,
  createResponse,
} from '@adobe/spacecat-shared-http-utils';
import { hasText } from '@adobe/spacecat-shared-utils';

import {
  createWorkflow,
  updateWorkflowStatus,
  updateWorkflowResult,
  deleteWorkflow,
  listWorkflowsForProfile,
  getWorkflowById,
} from '../support/workflows-storage.js';
import { getProfileById } from '../support/profiles-storage.js';

const VALID_STATUSES = new Set(['pending', 'running', 'completed', 'failed']);

/**
 * Formats a single suggestion row as Jira wiki markup, tailored per opportunity type.
 * @param {string} type  opportunity type slug (e.g. 'alt-text', 'broken-backlinks')
 * @param {object} d     suggestion data object
 * @returns {string}
 */
function formatSuggestionRow(type, d) {
  if (type === 'alt-text') {
    const recs = Array.isArray(d.recommendations) ? d.recommendations : [];
    if (recs.length === 0) {
      return '_(no recommendations)_\n\n';
    }
    return recs
      .filter((r) => !r.isDecorative)
      .map((r) => {
        const suggested = r.altText ? `"${r.altText}"` : '_(none)_';
        return `|| *Page* | ${r.pageUrl ?? '_(unknown)_'} |\n|| *Image* | ${r.imageUrl ?? '_(unknown)_'} |\n|| *Suggested alt* | ${suggested} |\n\n`;
      })
      .join('');
  }

  if (type === 'broken-backlinks' || type === 'broken-internal-links') {
    const from = d.fromUrl ?? '_(unknown)_';
    const to = d.toUrl ?? '_(unknown)_';
    const status = d.httpStatus ?? d.status ?? '';
    const traffic = d.traffic ?? '—';
    const fix = d.suggestedFix ?? '_(none)_';
    return `|| *From* | ${from} |\n|| *Broken URL* | ${to} |\n|| *Status* | ${status} |\n|| *Traffic* | ${traffic} |\n|| *Suggested fix* | ${fix} |\n\n`;
  }

  if (type === 'meta-tags') {
    const page = d.url ?? d.pageUrl ?? '_(unknown)_';
    const issue = d.issue ?? d.type ?? '';
    const current = d.currentValue ?? d.current ?? '_(empty)_';
    const suggested = d.suggestedValue ?? d.suggestion ?? '_(none)_';
    return `|| *Page* | ${page} |\n|| *Issue* | ${issue} |\n|| *Current* | ${current} |\n|| *Suggested* | ${suggested} |\n\n`;
  }

  // Generic fallback for any other type
  const url = d.url ?? d.pageUrl ?? '';
  const fix = d.suggestedFix ?? d.recommendation ?? d.fix ?? '';
  return `* ${url}${fix ? ` — ${fix}` : ''}\n`;
}

/**
 * Workflows controller.
 *
 * Endpoints:
 *   GET    /sites/:siteId/profiles/:profileId/workflows
 *   POST   /sites/:siteId/profiles/:profileId/workflows
 *   PATCH  /sites/:siteId/profiles/:profileId/workflows/:workflowId
 *   DELETE /sites/:siteId/profiles/:profileId/workflows/:workflowId
 *
 * @param {object} ctx universal context
 * @param {object} log logger
 * @returns {object} handlers
 */
function WorkflowsController(ctx, log) {
  const { dataAccess } = ctx;
  const getPostgrestClient = () => dataAccess?.services?.postgrestClient;

  /**
   * GET /sites/:siteId/profiles/:profileId/workflows
   */
  const list = async (context) => {
    const { siteId, profileId } = context.params ?? {};
    try {
      const postgrestClient = getPostgrestClient();
      const profile = await getProfileById({ postgrestClient, siteId, profileId });
      if (!profile) {
        return notFound('Profile not found.');
      }
      const workflows = await listWorkflowsForProfile({ postgrestClient, profileId });
      return ok(workflows);
    } catch (error) {
      log.error(`Workflow list error: ${error.message}`);
      return internalServerError('Failed to list workflows.');
    }
  };

  /**
   * POST /sites/:siteId/profiles/:profileId/workflows
   * Body: { name, workflowId, scope? }
   */
  const create = async (context) => {
    const { siteId, profileId } = context.params ?? {};
    const { name, workflowId, scope = 'all' } = context?.data ?? {};

    if (!hasText(name)) {
      return badRequest('A non-empty "name" is required.');
    }
    if (!hasText(workflowId)) {
      return badRequest('A non-empty "workflowId" is required.');
    }

    try {
      const postgrestClient = getPostgrestClient();
      const profile = await getProfileById({ postgrestClient, siteId, profileId });
      if (!profile) {
        return notFound('Profile not found.');
      }

      const workflow = await createWorkflow({
        postgrestClient,
        siteId,
        profileId,
        name,
        workflowId,
        scope,
      });
      return createResponse(workflow, 201);
    } catch (error) {
      log.error(`Workflow create error: ${error.message}`);
      return internalServerError('Failed to create workflow.');
    }
  };

  /**
   * PATCH /sites/:siteId/profiles/:profileId/workflows/:workflowId
   * Body: { status }
   */
  const updateStatus = async (context) => {
    const { siteId, profileId, workflowId } = context.params ?? {};
    const { status } = context?.data ?? {};

    if (!hasText(status) || !VALID_STATUSES.has(status)) {
      return badRequest(`"status" must be one of: ${[...VALID_STATUSES].join(', ')}.`);
    }

    try {
      const postgrestClient = getPostgrestClient();
      const profile = await getProfileById({ postgrestClient, siteId, profileId });
      if (!profile) {
        return notFound('Profile not found.');
      }
      const existing = await getWorkflowById({ postgrestClient, siteId, workflowId });
      if (!existing || existing.profileId !== profileId) {
        return notFound('Workflow not found.');
      }
      const updated = await updateWorkflowStatus({
        postgrestClient, siteId, workflowId, status,
      });
      return ok(updated);
    } catch (error) {
      log.error(`Workflow update error: ${error.message}`);
      return internalServerError('Failed to update workflow status.');
    }
  };

  /**
   * DELETE /sites/:siteId/profiles/:profileId/workflows/:workflowId
   */
  const deleteById = async (context) => {
    const { siteId, profileId, workflowId } = context.params ?? {};
    try {
      const postgrestClient = getPostgrestClient();
      const profile = await getProfileById({ postgrestClient, siteId, profileId });
      if (!profile) {
        return notFound('Profile not found.');
      }
      const existing = await getWorkflowById({ postgrestClient, siteId, workflowId });
      if (!existing || existing.profileId !== profileId) {
        return notFound('Workflow not found.');
      }
      await deleteWorkflow({ postgrestClient, siteId, workflowId });
      return createResponse(null, 204);
    } catch (error) {
      log.error(`Workflow delete error: ${error.message}`);
      return internalServerError('Failed to delete workflow.');
    }
  };

  /**
   * POST /sites/:siteId/profiles/:profileId/workflows/:workflowId/run
   *
   * Executes a workflow. Currently supports workflowId = 'createJiraTicket':
   *   1. Fetches the profile's opportunity IDs from the spec.
   *   2. Fetches suggestions for each opportunity from spacecat-api-service.
   *   3. Creates a Jira task with the suggestions as the description.
   *   4. Stores the ticket key + URL in workflows.result and sets status = 'completed'.
   *
   * Requires env vars: JIRA_PAT, JIRA_BASE_URL, JIRA_PROJECT_KEY, JIRA_ISSUE_TYPE_ID.
   */
  const run = async (context) => {
    const { siteId, profileId, workflowId } = context.params ?? {};

    try {
      const postgrestClient = getPostgrestClient();

      const profile = await getProfileById({ postgrestClient, siteId, profileId });
      if (!profile) {
        return notFound('Profile not found.');
      }

      const workflow = await getWorkflowById({ postgrestClient, siteId, workflowId });
      if (!workflow || workflow.profileId !== profileId) {
        return notFound('Workflow not found.');
      }

      if (workflow.status === 'running') {
        return badRequest('Workflow is already running.');
      }

      await updateWorkflowStatus({
        postgrestClient,
        siteId,
        workflowId,
        status: 'running',
      });

      // -----------------------------------------------------------------
      // Collect suggestions for this workflow's scope.
      // profile.spec.opportunity_ids (snake_case from DB) contains the IDs.
      // -----------------------------------------------------------------
      const allOpportunityIds = Array.isArray(profile.opportunityIds) ? profile.opportunityIds : [];

      // Filter opportunity IDs by workflow scope.
      // scope === 'all' → all opportunities; otherwise match by opportunity type slug.
      let opportunityIds = allOpportunityIds;
      if (workflow.scope !== 'all' && allOpportunityIds.length > 0) {
        const { data: scopedOpps } = await postgrestClient
          .from('opportunities')
          .select('id, type')
          .in('id', allOpportunityIds)
          .eq('type', workflow.scope);
        opportunityIds = (scopedOpps ?? []).map((o) => o.id);
      }

      const jiraPat = process.env.JIRA_PAT ?? '';
      const jiraBase = (process.env.JIRA_BASE_URL ?? 'https://jira.corp.adobe.com').replace(/\/$/, '');
      const jiraProject = process.env.JIRA_PROJECT_KEY ?? 'SITES';
      const jiraIssueTypeId = process.env.JIRA_ISSUE_TYPE_ID ?? '3';

      if (!jiraPat) {
        await updateWorkflowResult({
          postgrestClient,
          siteId,
          workflowId,
          status: 'failed',
          result: { error: 'JIRA_PAT not configured' },
        });
        return internalServerError('JIRA_PAT is not configured on this server.');
      }

      // Build Jira ticket description from suggestions
      let jiraDescription = `h2. Profile: ${profile.name ?? profileId}\n\n`;
      jiraDescription += `h3. Workflow: ${workflow.name}\n\n`;

      if (opportunityIds.length > 0) {
        const oppSections = await Promise.all(
          opportunityIds.map(async (oppId) => {
            try {
              const [{ data: oppRow }, { data: suggestionRows }] = await Promise.all([
                postgrestClient.from('opportunities').select('id, title, type').eq('id', oppId).maybeSingle(),
                postgrestClient.from('suggestions').select('data').eq('opportunity_id', oppId).limit(10),
              ]);
              if (!oppRow) {
                return '';
              }
              let section = `h3. ${oppRow.title ?? oppRow.type ?? oppId}\n`;
              if (suggestionRows?.length > 0) {
                for (const s of suggestionRows) {
                  const d = s.data ?? {};
                  section += formatSuggestionRow(oppRow.type, d);
                }
              } else {
                section += '_(no suggestions)_\n';
              }
              return `${section}\n`;
            } catch {
              return '';
            }
          }),
        );
        jiraDescription += oppSections.join('');
      } else {
        jiraDescription += '_(no opportunities attached to this profile)_\n';
      }

      // Create Jira ticket
      const jiraPayload = {
        fields: {
          project: { key: jiraProject },
          issuetype: { id: jiraIssueTypeId },
          components: [{ id: process.env.JIRA_COMPONENT_ID ?? '201300' }],
          labels: ['garage-week-profiles'],
          summary: `[ASO] ${workflow.name} — ${profile.name ?? profileId}`,
          description: jiraDescription,
        },
      };

      const jiraRes = await fetch(`${jiraBase}/rest/api/2/issue`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${jiraPat}`,
        },
        body: JSON.stringify(jiraPayload),
      });

      if (!jiraRes.ok) {
        const errText = await jiraRes.text().catch(() => '');
        log.error(`Jira create issue failed ${jiraRes.status}: ${errText}`);
        await updateWorkflowResult({
          postgrestClient,
          siteId,
          workflowId,
          status: 'failed',
          result: { error: `Jira API error ${jiraRes.status}`, detail: errText },
        });
        return createResponse({ message: 'Failed to create Jira ticket.', status: jiraRes.status, detail: errText }, 500);
      }

      const jiraData = await jiraRes.json();
      const ticketKey = jiraData.key;
      const ticketUrl = `${jiraBase}/browse/${ticketKey}`;

      const updated = await updateWorkflowResult({
        postgrestClient,
        siteId,
        workflowId,
        status: 'completed',
        result: { ticketKey, ticketUrl },
      });

      return ok(updated);
    } catch (error) {
      log.error(`Workflow run error: ${error.message}`);
      try {
        const postgrestClient = getPostgrestClient();
        await updateWorkflowResult({
          postgrestClient,
          siteId,
          workflowId,
          status: 'failed',
          result: { error: error.message },
        });
      } catch { /* best-effort */ }
      return internalServerError('Workflow run failed.');
    }
  };

  return {
    list, create, updateStatus, deleteById, run,
  };
}

export default WorkflowsController;
