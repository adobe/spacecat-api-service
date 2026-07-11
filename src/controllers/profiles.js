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
import { hasText, isNonEmptyObject } from '@adobe/spacecat-shared-utils';

import {
  selectComponentsWithClaude,
  buildComponentsForOpportunity,
  validateProfileSpec,
  validateComponents,
  detectAddIntent,
} from '../support/profile-builder.js';
import { createWorkflow } from '../support/workflows-storage.js';
import {
  createProfile,
  updateProfile,
  getProfileById,
  deleteProfile,
  listProfilesBySite,
  embedWorkflows,
} from '../support/profiles-storage.js';

/**
 * Profiles controller.
 *
 * Endpoints:
 *   POST /sites/:siteId/profiles/chat  { message } -> creates a profile
 *   GET  /sites/:siteId/profiles                    -> lists profiles
 *   GET  /sites/:siteId/profiles/:profileId         -> fetches one profile
 *
 * @param {object} ctx universal context
 * @param {object} log logger
 * @param {object} env environment variables (Bedrock config)
 * @returns {object} handlers
 */
function ProfilesController(ctx, log, env) {
  const { dataAccess } = ctx;

  const getPostgrestClient = () => dataAccess?.services?.postgrestClient;

  /**
   * POST /sites/:siteId/profiles/chat
   * Body: { message, profileId? }
   *
   * Unified chat endpoint. When `profileId` is provided the message is treated
   * as an "add opportunity" request on the existing profile. When it is absent a
   * brand-new profile is created from the message.
   */
  const createFromChat = async (context) => {
    const siteId = context.params?.siteId;
    const { message, profileId } = context?.data ?? {};

    if (!hasText(message)) {
      return badRequest('A non-empty "message" is required.');
    }

    const { Site, Opportunity } = dataAccess ?? {};
    if (!isNonEmptyObject(Site) || !isNonEmptyObject(Opportunity)) {
      return internalServerError('Data access is not available.');
    }

    // ── ADD-TO-EXISTING branch ────────────────────────────────────────────────
    if (hasText(profileId)) {
      try {
        const postgrestClient = getPostgrestClient();
        const profile = await getProfileById({ postgrestClient, siteId, profileId });
        if (!profile) {
          return notFound('Profile not found.');
        }

        const opportunities = await Opportunity.allBySiteId(siteId);
        if (!opportunities || opportunities.length === 0) {
          return notFound('This site has no opportunities to add.');
        }

        // Lightweight stubs — no full data payload needed for intent detection.
        const stubs = opportunities.map((o) => ({
          id: o.getId(),
          type: o.getType(),
          title: o.getTitle(),
        }));

        // Call 1: single LLM call detects both opportunity ids and workflows.
        const intent = await detectAddIntent({
          message,
          opportunities: stubs,
          currentProfileName: profile.name,
          env,
          log,
        });

        const { opportunityIds: rawIds, workflows: rawWorkflows } = intent;

        if (rawIds.length === 0 && rawWorkflows.length === 0) {
          return notFound('No matching opportunities or workflows found for your request.');
        }

        // ── Opportunities ─────────────────────────────────────────────────────
        const newComponents = [];
        const addedIds = [];
        let revisedName = intent.name ?? null;

        const newIds = rawIds.filter((id) => !profile.opportunityIds.includes(id));

        if (newIds.length > 0) {
          // Build a full-data candidate map for component building (call 2).
          const candidateMap = new Map(
            opportunities.map((o) => [o.getId(), {
              id: o.getId(),
              type: o.getType(),
              title: o.getTitle(),
              data: o.getData(),
            }]),
          );

          // Call 2: one Bedrock call per new opportunity (component building).
          const built = await Promise.all(
            newIds.map((id) => buildComponentsForOpportunity({
              message,
              opportunity: candidateMap.get(id),
              currentProfileName: profile.name,
              env,
              log,
            })),
          );

          built.forEach((result, i) => {
            const validated = validateComponents(result);
            if (validated) {
              newComponents.push(...validated.components);
              addedIds.push(newIds[i]);
              if (validated.name) {
                revisedName = validated.name;
              }
            }
          });
        }

        // ── Workflows ─────────────────────────────────────────────────────────
        const createdWorkflows = rawWorkflows.length > 0
          ? await Promise.all(
            rawWorkflows.map((w) => createWorkflow({
              postgrestClient,
              profileId,
              siteId,
              name: w.name,
              workflowId: w.workflowId,
              scope: w.scope,
            })),
          )
          : [];

        // ── Persist profile changes ───────────────────────────────────────────
        let updated = profile;
        if (addedIds.length > 0 || revisedName) {
          const patch = {
            components: [...profile.components, ...newComponents],
            opportunityIds: [...profile.opportunityIds, ...addedIds],
          };
          if (revisedName) {
            patch.name = revisedName;
          }
          updated = await updateProfile({
            postgrestClient, siteId, profileId, patch,
          });
        }

        // Embed the latest workflows (including newly created ones) into the
        // profile so the UI gets a consistent full-profile response shape.
        const withWorkflows = await embedWorkflows(postgrestClient, updated);

        const parts = [];
        if (addedIds.length > 0) {
          parts.push(`added ${addedIds.length} opportunit${addedIds.length === 1 ? 'y' : 'ies'}`);
        }
        if (createdWorkflows.length > 0) {
          parts.push(`scheduled ${createdWorkflows.length} workflow${createdWorkflows.length === 1 ? '' : 's'}`);
        }
        const reply = intent.reply
          ?? (parts.length > 0 ? `I ${parts.join(' and ')}.` : 'Done.');

        return ok({ ...withWorkflows, reply });
      } catch (error) {
        log.error(`Profile add error: ${error.message}`);
        return internalServerError('Failed to update profile.');
      }
    }

    // ── CREATE-NEW branch ─────────────────────────────────────────────────────
    try {
      const site = await Site.findById(siteId);
      if (!site) {
        return notFound('Site not found.');
      }

      const opportunities = await Opportunity.allBySiteId(siteId);
      if (!opportunities || opportunities.length === 0) {
        return notFound('This site has no opportunities to build a profile from.');
      }

      const candidates = opportunities.map((o) => ({
        id: o.getId(),
        type: o.getType(),
        title: o.getTitle(),
        data: o.getData(),
      }));

      const raw = await selectComponentsWithClaude({
        message, opportunities: candidates, env, log,
      });
      if (!raw) {
        return createResponse(
          { message: 'The profile builder is unavailable right now. Please try again.' },
          503,
        );
      }

      const validIds = new Set(candidates.map((c) => c.id));
      const spec = validateProfileSpec(raw, validIds);
      if (!spec) {
        return notFound('No matching opportunities found for your request on this site.');
      }

      const postgrestClient = getPostgrestClient();
      const profile = await createProfile({
        postgrestClient,
        siteId,
        name: spec.name,
        rationale: spec.rationale,
        components: spec.components,
        opportunityIds: spec.opportunityIds,
      });

      return createResponse({ ...profile, reply: spec.reply }, 201);
    } catch (error) {
      log.error(`Profile create-from-chat error: ${error.message}`);
      return internalServerError('Failed to create profile.');
    }
  };

  /**
   * POST /sites/:siteId/profiles
   * Body (optional): { name }
   * Creates an EMPTY profile (no components / opportunities) that the user then
   * builds up by adding opportunities via the add endpoint.
   */
  const createEmpty = async (context) => {
    const siteId = context.params?.siteId;
    const { Site } = dataAccess ?? {};
    if (!isNonEmptyObject(Site)) {
      return internalServerError('Data access is not available.');
    }

    try {
      const site = await Site.findById(siteId);
      if (!site) {
        return notFound('Site not found.');
      }

      const name = hasText(context?.data?.name)
        ? context.data.name
        : 'Custom profile';
      const rationale = hasText(context?.data?.rationale)
        ? context.data.rationale
        : '';
      const components = Array.isArray(context?.data?.components)
        ? context.data.components
        : [];
      const opportunityIds = Array.isArray(context?.data?.opportunityIds)
        ? context.data.opportunityIds
        : [];

      const profile = await createProfile({
        postgrestClient: getPostgrestClient(),
        siteId,
        name,
        rationale,
        components,
        opportunityIds,
      });

      return createResponse(profile, 201);
    } catch (error) {
      log.error(`Profile create-empty error: ${error.message}`);
      return internalServerError('Failed to create profile.');
    }
  };

  /**
   * GET /sites/:siteId/profiles
   */
  const list = async (context) => {
    const siteId = context.params?.siteId;
    try {
      const postgrestClient = getPostgrestClient();
      const profiles = await listProfilesBySite({ postgrestClient, siteId });
      const withWorkflows = await Promise.all(
        profiles.map((p) => embedWorkflows(postgrestClient, p)),
      );
      return ok(withWorkflows);
    } catch (error) {
      log.error(`Profile list error: ${error.message}`);
      return internalServerError('Failed to list profiles.');
    }
  };

  /**
   * GET /sites/:siteId/profiles/:profileId
   */
  const getById = async (context) => {
    const siteId = context.params?.siteId;
    const profileId = context.params?.profileId;
    if (!hasText(profileId)) {
      return badRequest('Profile ID is required.');
    }
    try {
      const postgrestClient = getPostgrestClient();
      const profile = await getProfileById({ postgrestClient, siteId, profileId });
      if (!profile) {
        return notFound('Profile not found.');
      }
      return ok(await embedWorkflows(postgrestClient, profile));
    } catch (error) {
      log.error(`Profile get error: ${error.message}`);
      return internalServerError('Failed to fetch profile.');
    }
  };

  /**
   * POST /sites/:siteId/profiles/:profileId/copy
   * Creates a new profile that is a copy of the source, appending " (Custom)" to the name.
   */
  const copyById = async (context) => {
    const siteId = context.params?.siteId;
    const profileId = context.params?.profileId;
    if (!hasText(profileId)) {
      return badRequest('Profile ID is required.');
    }
    try {
      const postgrestClient = getPostgrestClient();
      const source = await getProfileById({ postgrestClient, siteId, profileId });
      if (!source) {
        return notFound('Profile not found.');
      }
      const copy = await createProfile({
        postgrestClient,
        siteId,
        name: `${source.name} (Custom)`,
        rationale: source.rationale ?? '',
        components: source.components ?? [],
        opportunityIds: source.opportunityIds ?? [],
      });
      return createResponse(copy, 201);
    } catch (error) {
      log.error(`Profile copy error: ${error.message}`);
      return internalServerError('Failed to copy profile.');
    }
  };

  /**
   * DELETE /sites/:siteId/profiles/:profileId
   */
  const deleteById = async (context) => {
    const siteId = context.params?.siteId;
    const profileId = context.params?.profileId;
    if (!hasText(profileId)) {
      return badRequest('Profile ID is required.');
    }
    try {
      const postgrestClient = getPostgrestClient();
      const existing = await getProfileById({ postgrestClient, siteId, profileId });
      if (!existing) {
        return notFound('Profile not found.');
      }
      await deleteProfile({ postgrestClient, siteId, profileId });
      return createResponse(null, 204);
    } catch (error) {
      log.error(`Profile delete error: ${error.message}`);
      return internalServerError('Failed to delete profile.');
    }
  };

  return {
    createFromChat, createEmpty, list, getById, copyById, deleteById,
  };
}

export default ProfilesController;
