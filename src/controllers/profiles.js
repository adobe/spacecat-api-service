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
} from '../support/profile-builder.js';
import {
  createProfile,
  updateProfile,
  getProfileById,
  deleteProfile,
  listProfilesBySite,
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

        const candidates = opportunities.map((o) => ({
          id: o.getId(),
          type: o.getType(),
          title: o.getTitle(),
          data: o.getData(),
        }));

        const selection = await selectComponentsWithClaude({
          message, opportunities: candidates, env, log,
        });
        if (!selection) {
          return createResponse(
            { message: 'The profile builder is unavailable right now. Please try again.' },
            503,
          );
        }

        const validIds = new Set(candidates.map((c) => c.id));
        const matchedIds = [...new Set(selection.opportunityIds || [])]
          .filter((id) => validIds.has(id));
        if (matchedIds.length === 0) {
          return notFound('No matching opportunity found for your request on this site.');
        }

        const newComponents = [];
        const addedIds = [];
        const alreadyPresent = [];
        let revisedName = null;
        for (const id of matchedIds) {
          if (profile.opportunityIds.includes(id)) {
            alreadyPresent.push(id);
            // eslint-disable-next-line no-continue
            continue;
          }
          const matched = candidates.find((c) => c.id === id);
          // eslint-disable-next-line no-await-in-loop
          const built = await buildComponentsForOpportunity({
            message,
            opportunity: matched,
            currentProfileName: profile.name,
            env,
            log,
          });
          const validated = validateComponents(built);
          if (validated) {
            newComponents.push(...validated.components);
            addedIds.push(id);
            // Use the last non-null name the LLM returned across all added opps.
            if (validated.name) {
              revisedName = validated.name;
            }
          }
        }

        if (addedIds.length === 0) {
          const reply = alreadyPresent.length > 0
            ? 'Those opportunities are already in this profile.'
            : 'Could not build a component for that opportunity.';
          return ok({ ...profile, reply });
        }

        const patch = {
          components: [...profile.components, ...newComponents],
          opportunityIds: [...profile.opportunityIds, ...addedIds],
        };
        if (revisedName) {
          patch.name = revisedName;
        }

        const updated = await updateProfile({
          postgrestClient, siteId, profileId, patch,
        });

        const reply = `Added ${addedIds.length} opportunit${addedIds.length === 1 ? 'y' : 'ies'} to your profile.`;
        return ok({ ...updated, reply });
      } catch (error) {
        log.error(`Profile add-opportunity error: ${error.message}`);
        return internalServerError('Failed to add opportunity.');
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

      const profile = await createProfile({
        postgrestClient: getPostgrestClient(),
        siteId,
        name,
        rationale: '',
        components: [],
        opportunityIds: [],
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
      const profiles = await listProfilesBySite({
        postgrestClient: getPostgrestClient(),
        siteId,
      });
      return ok(profiles);
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
      const profile = await getProfileById({
        postgrestClient: getPostgrestClient(),
        siteId,
        profileId,
      });
      if (!profile) {
        return notFound('Profile not found.');
      }
      return ok(profile);
    } catch (error) {
      log.error(`Profile get error: ${error.message}`);
      return internalServerError('Failed to fetch profile.');
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
    createFromChat, createEmpty, list, getById, deleteById,
  };
}

export default ProfilesController;
