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

/**
 * Opens the preflight configuration modal when the button is clicked
 */
export default function openPreflightConfig(lambdaContext) {
  const { dataAccess, log } = lambdaContext;
  const { Site } = dataAccess;

  return async ({ ack, body, client }) => {
    await ack();

    try {
      // Parse the button value to get site ID and audit type
      const { siteId, auditType } = JSON.parse(body.actions[0].value);

      // Get the site to populate current values
      const site = await Site.findById(siteId);
      if (!site) {
        log.error(`Site with ID ${siteId} not found`);
        return;
      }

      const messageTs = body.message?.ts;
      const threadTs = body.message?.thread_ts || messageTs;
      const channelId = body.channel?.id;
      const userName = body.user?.name || 'User';

      if (messageTs && channelId) {
        try {
          await client.chat.update({
            channel: channelId,
            ts: messageTs,
            text: `:gear: Preflight configuration started by ${userName}`,
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: `:gear: *Preflight configuration started by ${userName}*\n\`${site.getBaseURL()}\`\n\nConfiguring preflight audit...`,
                },
              },
            ],
          });
        } catch (error) {
          log.error('Failed to update original message:', error);
        }
      }

      // Get current values or defaults
      const currentAuthoringType = site.getAuthoringType() || '';
      const currentDeliveryConfig = site.getDeliveryConfig() || {};

      const modal = {
        type: 'modal',
        callback_id: 'preflight_config_modal',
        title: {
          type: 'plain_text',
          text: 'Preflight Configuration',
        },
        submit: {
          type: 'plain_text',
          text: 'Enable Audit',
        },
        close: {
          type: 'plain_text',
          text: 'Cancel',
        },
        private_metadata: JSON.stringify({
          siteId,
          auditType,
          channelId,
          threadTs,
          messageTs,
        }),
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Preflight audit requires additional configuration for:*\n\`${site.getBaseURL()}\``,
            },
          },
          {
            type: 'divider',
          },
          {
            type: 'input',
            block_id: 'authoring_type_input',
            element: {
              type: 'static_select',
              action_id: 'authoring_type',
              placeholder: {
                type: 'plain_text',
                text: 'Select authoring type',
              },
              options: [
                {
                  text: { type: 'plain_text', text: 'Document Authoring' },
                  value: 'documentauthoring',
                },
                {
                  text: { type: 'plain_text', text: 'Cloud Service' },
                  value: 'cs',
                },
                {
                  text: { type: 'plain_text', text: 'Cloud Service/Crosswalk' },
                  value: 'cs/crosswalk',
                },
                {
                  text: { type: 'plain_text', text: 'Adobe Managed Services (AMS)' },
                  value: 'ams',
                },
              ],
              initial_option: currentAuthoringType ? {
                text: {
                  type: 'plain_text',
                  text: (() => {
                    if (currentAuthoringType === 'cs') return 'Cloud Service';
                    if (currentAuthoringType === 'cs/crosswalk') return 'Cloud Service/Crosswalk';
                    if (currentAuthoringType === 'ams') return 'Adobe Managed Services';
                    return 'Document Authoring';
                  })(),
                },
                value: currentAuthoringType,
              } : undefined,
            },
            label: {
              type: 'plain_text',
              text: 'Authoring Type *',
            },
          },
          {
            type: 'input',
            block_id: 'preview_url_input',
            element: {
              type: 'plain_text_input',
              action_id: 'preview_url',
              placeholder: {
                type: 'plain_text',
                text: 'AEM CS or AMS or EDS URL',
              },
              initial_value: currentDeliveryConfig.authorURL || '',
            },
            label: {
              type: 'plain_text',
              text: 'Preview URL *',
            },
            hint: {
              type: 'plain_text',
              text: 'Document Authoring: main--site--owner.aem.live. CS/CS-Crosswalk/AMS: AEM CS URL (author-p12345-e67890.adobeaemcloud.com).',
            },
          },
        ],
      };

      await client.views.open({
        trigger_id: body.trigger_id,
        view: modal,
      });
    } catch (error) {
      log.error('Error opening preflight config modal:', error);
    }
  };
}
