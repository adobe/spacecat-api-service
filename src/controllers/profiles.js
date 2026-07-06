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
  validateProfileSpec,
} from '../support/profile-builder.js';
import {
  createProfile,
  getProfileById,
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
   * Body: { message }
   * Fetches the site's opportunities, asks Claude to build a profile from the
   * ones matching the request, persists it, and returns it. Returns 404 when
   * no matching opportunities exist (no profile is created).
   */
  const createFromChat = async (context) => {
    const siteId = context.params?.siteId;
    const message = context?.data?.message;

    if (!hasText(message)) {
      return badRequest('A non-empty "message" is required.');
    }

    const { Site, Opportunity } = dataAccess ?? {};
    if (!isNonEmptyObject(Site) || !isNonEmptyObject(Opportunity)) {
      return internalServerError('Data access is not available.');
    }

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

  return { createFromChat, list, getById };
}

export default ProfilesController;
