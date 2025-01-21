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

import { Blocks, Message, Md } from 'slack-block-builder';
import { BaseSlackClient, SLACK_TARGETS } from '@adobe/spacecat-shared-slack-client';

export default function rejectOrg(lambdaContext) {
  const { log } = lambdaContext;

  return async ({ ack, body, respond }) => {
    try {
      const { channel, message = {}, user } = body;
      const { blocks, ts: threadTs } = message;

      log.info(JSON.stringify(body));

      await ack(); // slack expects acknowledgement within 3s

      const messageText = blocks[0]?.text?.text;

      const replyText = Message()
        .blocks(
          Blocks.Section()
            .blockId(blocks[0]?.block_id)
            .text(messageText),
          Blocks.Section().text(`Rejected by @${user.username} :cross-x:`),
        )
        .buildToObject();

      const reply = {
        ...replyText,
        replace_original: true,
      };

      log.info(`Responding org rejection with: ${JSON.stringify(reply)}`);

      await respond(reply);

      const followUpMessage = Message()
        .channel(channel.id)
        .threadTs(threadTs)
        .blocks(
          Blocks.Section()
            .text(`Please let me know about the correct organization details using ${Md.codeInline('@spacecat set imsorg [url] [imsOrgId]')}. Example:`),
          Blocks.Section()
            .text(Md.codeBlock('@spacecat set imsorg spacecat.com XXXX@AdobeOrg')),
        )
        .buildToObject();

      const slackClient = BaseSlackClient.createFrom(
        lambdaContext,
        SLACK_TARGETS.WORKSPACE_INTERNAL,
      );
      await slackClient.postMessage(followUpMessage);
    } catch (e) {
      log.error('Error occurred while acknowledging org approval', e);
      throw e;
    }
  };
}
