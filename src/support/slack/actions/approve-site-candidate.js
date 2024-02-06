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

export default function approveSiteCandidate(lambdaContext) {
  return async ({ ack, body, respond }) => {
    lambdaContext.log.info(JSON.stringify(body));

    await ack();

    const {
      message: {
        blocks,
      },
    } = body;

    const newBlocks = [blocks[0]];

    newBlocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'Added :checked:',
      },
    });

    await respond({
      replace_original: true,
      text: newBlocks[0].text.text,
      blocks: newBlocks,
    });
  };
}
