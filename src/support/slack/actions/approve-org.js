/*
 * Copyright 2024 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { Blocks, Message } from 'slack-block-builder';
import { assertSiteOrgReassignmentSafe } from '../../site-org-reassignment.js';

function extractOrg(text) {
  const regex = /IMS org ID `([^`]+)`.*<([^|>]+)/;
  const match = text.match(regex);

  if (match) {
    return {
      imsOrgId: match[1],
      baseURL: match[2],
    };
  } else {
    return null;
  }
}

export default function approveOrg(lambdaContext) {
  const { dataAccess, log } = lambdaContext;

  const { Site, Organization } = dataAccess;

  return async ({ ack, body, respond }) => {
    try {
      const { message = {}, user } = body;
      const { blocks } = message;

      await ack(); // slack expects acknowledgement within 3s

      const messageText = blocks[0]?.text?.text;

      const extractedOrg = extractOrg(messageText);

      if (extractedOrg) {
        const { imsOrgId, baseURL } = extractedOrg;
        const org = await Organization.findByImsOrgId(imsOrgId);
        const site = await Site.findByBaseURL(baseURL);

        // LLMO-7284 (AC12): don't silently orphan the site's enrollments on
        // reassignment — fail explicitly if the move would leave foreign enrollments
        // behind. A same-org approval is a no-op inside the guard.
        await assertSiteOrgReassignmentSafe({ site, targetOrgId: org.getId(), log });

        site.setOrganizationId(org.getId());
        await site.save();
      }

      const replyText = Message()
        .blocks(
          Blocks.Section()
            .blockId(blocks[0]?.block_id)
            .text(messageText),
          Blocks.Section().text(`Approved by @${user.username} :checked:`),
        )
        .buildToObject();

      const reply = {
        ...replyText,
        replace_original: true,
      };

      await respond(reply);
    } catch (e) {
      log.error('Error occurred while acknowledging org approval', e);
      // LLMO-7284 (AC12): surface a blocked/unverified reassignment to the operator
      // (parity with set-ims-org-modal.js and onboard-llmo-modal.js) so the actionable
      // "offboard or transfer the enrollments first" reason is not swallowed into logs.
      if (typeof e?.code === 'string' && e.code.startsWith('site_org_reassignment')) {
        await respond({ replace_original: false, text: `:x: ${e.message}` });
      }
      throw e;
    }
  };
}
