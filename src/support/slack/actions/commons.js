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
import { BUTTON_LABELS } from '../../../controllers/hooks.js';

export function extractURLFromSlackMessage(inputString) {
  // Regular expression to match URLs
  const start = inputString.indexOf('https');
  const end = inputString.indexOf('|', inputString.indexOf('<'));

  return inputString.substring(start, end);
}

export function composeReply(opts) {
  const {
    blocks,
    username,
    isFnF,
    approved,
  } = opts;

  const reaction = approved
    ? `Added by @${username} \`${isFnF ? BUTTON_LABELS.APPROVE_FRIENDS_FAMILY : BUTTON_LABELS.APPROVE_CUSTOMER}\` :checked:`
    : `Ignored by @${username} :cross-x:`;

  const message = Message()
    .blocks(
      Blocks.Section()
        .blockId(blocks[0]?.block_id)
        .text(blocks[0]?.text?.text),
      Blocks.Section().text(reaction),
    )
    .buildToObject();

  return {
    ...message,
    text: blocks[0]?.text?.text,
    replace_original: true,
  };
}
