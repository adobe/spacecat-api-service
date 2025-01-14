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

export default function approveOrg(lambdaContext) {
  const { log } = lambdaContext;

  return async ({ ack, body, respond }) => {
    try {
      const { message = {}, user } = body;
      const { blocks } = message;

      log.info(JSON.stringify(body));

      await ack(); // slack expects acknowledgement within 3s

      const replyText = Message()
        .blocks(
          Blocks.Section()
            .blockId(blocks[0]?.block_id)
            .text(blocks[0]?.text?.text),
          Blocks.Section().text(`Approved by @${user.username} :checked:`),
        )
        .buildToObject();

      const reply = {
        ...replyText,
        replace_original: true,
      };

      log.info(`Responding org approval with: ${JSON.stringify(reply)}`);

      await respond(reply);
    } catch (e) {
      log.error('Error occurred while acknowledging org approval', e);
      throw e;
    }
  };
}
