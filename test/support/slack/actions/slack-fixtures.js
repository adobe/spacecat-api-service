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

export const slackActionResponse = {
  type: 'block_actions',
  user: {
    id: 'user-id',
    username: 'approvers-username',
    name: 'username',
    team_id: 'team-id',
  },
  api_app_id: 'api-app-id',
  token: 'token',
  container: {
    type: 'message',
    message_ts: 'message-ts',
    channel_id: 'channel-id',
    is_ephemeral: false,
  },
  trigger_id: 'trigger-od',
  team: {
    id: 'team-id',
    domain: 'cq-dev',
    enterprise_id: 'enterprise-id',
    enterprise_name: 'adobe',
  },
  enterprise: {
    id: 'enterprise-id',
    name: 'Adobe',
  },
  is_enterprise_install: false,
  channel: {
    id: 'channel-id',
    name: 'privategroup',
  },
  message: {
    bot_id: 'bot-id',
    type: 'message',
    text: 'I discovered a new site on Edge Delivery Services: *<https://spacecat.com|https://spacecat.com>*. Would you like me to include it in the Star Catalogue? (_source:_ *CDN*) Yes button Ignore button',
    user: 'user-id',
    ts: 'thread-id',
    app_id: 'app-id',
    blocks: [
      {
        type: 'section',
        block_id: 'initial-block-id',
        text: {
          type: 'mrkdwn',
          text: 'I discovered a new site on Edge Delivery Services: *<https://spacecat.com|https://spacecat.com>*. Would you like me to include it in the Star Catalogue? (_source:_ *CDN*)',
          verbatim: false,
        },
      },
      {
        type: 'actions',
        block_id: 'action-block-id',
        elements: [
          {
            type: 'button',
            action_id: 'approveSiteCandidate',
            text: {
              type: 'plain_text',
              text: 'Yes',
              emoji: true,
            },
            style: 'primary',
          },
          {
            type: 'button',
            action_id: 'ignoreSiteCandidate',
            text: {
              type: 'plain_text',
              text: 'Ignore',
              emoji: true,
            },
            style: 'danger',
          },
        ],
      },
    ],
    team: 'team-id',
  },
  state: {
    values: {},
  },
  response_url: 'https://hooks.slack.com/actions/resp/url',
  actions: [
    {
      action_id: 'approveSiteCandidate',
      block_id: 'action-block-id',
      text: {
        type: 'plain_text',
        text: 'As Customer',
        emoji: true,
      },
      style: 'primary',
      type: 'button',
      action_ts: 'action-thread',
    },
  ],
};

export const slackFriendsFamilyResponse = {
  ...slackActionResponse,
  actions: [
    {
      action_id: 'approveSiteCandidate',
      block_id: 'action-block-id',
      text: {
        type: 'plain_text',
        text: 'As Friends/Family',
        emoji: true,
      },
      style: 'primary',
      type: 'button',
      action_ts: 'action-thread',
    },
  ],
};

export const slackApprovedReply = {
  blocks: [
    {
      block_id: 'initial-block-id',
      text: {
        text: 'I discovered a new site on Edge Delivery Services: *<https://spacecat.com|https://spacecat.com>*. Would you like me to include it in the Star Catalogue? (_source:_ *CDN*)',
        type: 'mrkdwn',
      },
      type: 'section',
    },
    {
      text: {
        text: 'Added by @some-user `As Customer` :checked:',
        type: 'mrkdwn',
      },
      type: 'section',
    },
  ],
  replace_original: true,
  text: 'I discovered a new site on Edge Delivery Services: *<https://spacecat.com|https://spacecat.com>*. Would you like me to include it in the Star Catalogue? (_source:_ *CDN*)',
};

export const slackApprovedFriendsFamilyReply = {
  blocks: [
    {
      block_id: 'initial-block-id',
      text: {
        text: 'I discovered a new site on Edge Delivery Services: *<https://spacecat.com|https://spacecat.com>*. Would you like me to include it in the Star Catalogue? (_source:_ *CDN*)',
        type: 'mrkdwn',
      },
      type: 'section',
    },
    {
      text: {
        text: 'Added by @some-user `As Friends/Family` :checked:',
        type: 'mrkdwn',
      },
      type: 'section',
    },
  ],
  replace_original: true,
  text: 'I discovered a new site on Edge Delivery Services: *<https://spacecat.com|https://spacecat.com>*. Would you like me to include it in the Star Catalogue? (_source:_ *CDN*)',
};

export const slackIgnoredReply = {
  blocks: [
    {
      block_id: 'initial-block-id',
      text: {
        text: 'I discovered a new site on Edge Delivery Services: *<https://spacecat.com|https://spacecat.com>*. Would you like me to include it in the Star Catalogue? (_source:_ *CDN*)',
        type: 'mrkdwn',
      },
      type: 'section',
    },
    {
      text: {
        text: 'Ignored by @some-user :cross-x:',
        type: 'mrkdwn',
      },
      type: 'section',
    },
  ],
  replace_original: true,
  text: 'I discovered a new site on Edge Delivery Services: *<https://spacecat.com|https://spacecat.com>*. Would you like me to include it in the Star Catalogue? (_source:_ *CDN*)',
};

export const expectedAnnouncedMessage = Message()
  .channel('channel-id')
  .blocks(
    Blocks.Section()
      .text('A new site, *<https://spacecat.com|https://spacecat.com>*, has gone *live* :rocket: on Edge Delivery Services and has been added to the Star Catalogue. (_source:_ *CDN*)'),
  )
  .buildToObject();

export const expectedApprovedReply = {
  ...Message()
    .blocks(
      Blocks.Section()
        .blockId('initial-block-id')
        .text('I discovered a new site on Edge Delivery Services: *<https://spacecat.com|https://spacecat.com>*. Would you like me to include it in the Star Catalogue? (_source:_ *CDN*)'),
      Blocks.Section().text('Added by @approvers-username `As Customer` :checked:'),
    )
    .buildToObject(),
  text: 'I discovered a new site on Edge Delivery Services: *<https://spacecat.com|https://spacecat.com>*. Would you like me to include it in the Star Catalogue? (_source:_ *CDN*)',
  replace_original: true,
};

export const expectedApprovedFnFReply = {
  ...Message()
    .blocks(
      Blocks.Section()
        .blockId('initial-block-id')
        .text('I discovered a new site on Edge Delivery Services: *<https://spacecat.com|https://spacecat.com>*. Would you like me to include it in the Star Catalogue? (_source:_ *CDN*)'),
      Blocks.Section().text('Added by @approvers-username `As Friends/Family` :checked:'),
    )
    .buildToObject(),
  text: 'I discovered a new site on Edge Delivery Services: *<https://spacecat.com|https://spacecat.com>*. Would you like me to include it in the Star Catalogue? (_source:_ *CDN*)',
  replace_original: true,
};

export const expectedIgnoredReply = {
  ...Message()
    .blocks(
      Blocks.Section()
        .blockId('initial-block-id')
        .text('I discovered a new site on Edge Delivery Services: *<https://spacecat.com|https://spacecat.com>*. Would you like me to include it in the Star Catalogue? (_source:_ *CDN*)'),
      Blocks.Section().text('Ignored by @approvers-username :cross-x:'),
    )
    .buildToObject(),
  text: 'I discovered a new site on Edge Delivery Services: *<https://spacecat.com|https://spacecat.com>*. Would you like me to include it in the Star Catalogue? (_source:_ *CDN*)',
  replace_original: true,
};
