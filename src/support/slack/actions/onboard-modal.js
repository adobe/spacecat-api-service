/*
 * Copyright 2025 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { isValidUrl } from '@adobe/spacecat-shared-utils';
import { onboardSingleSite as sharedOnboardSingleSite } from '../../utils.js';
import { loadProfileConfig } from '../../../utils/slack/base.js';

export const AEM_CS_HOST = /^author-p(\d+)-e(\d+)/i;

/**
 * Extracts program and environment ID from AEM Cloud Service preview URLs.
 * @param {string} previewUrl - The preview URL to parse
 * @returns {Object|null} Object with programId and environmentId, or null if not extractable
 */
export function extractDeliveryConfigFromPreviewUrl(previewUrl) {
  try {
    if (!isValidUrl(previewUrl)) {
      return null;
    }
    const url = new URL(previewUrl);
    const { hostname } = url;

    const [, programId, envId] = AEM_CS_HOST.exec(hostname);

    return {
      programId: `${programId}`,
      environmentId: `${envId}`,
      authorURL: previewUrl,
    };
  } catch (error) {
    return null;
  }
}

/**
 * Onboards a single site from modal input
 */
const onboardSingleSiteFromModal = async (
  baseURLInput,
  imsOrganizationID,
  configuration,
  profileName,
  workflowWaitTime,
  slackContext,
  context,
  additionalParams = {},
) => {
  // Load the profile configuration
  const profile = await loadProfileConfig(profileName);

  // Use the shared onboarding function from utils
  return sharedOnboardSingleSite(
    baseURLInput,
    imsOrganizationID,
    configuration,
    profile,
    workflowWaitTime,
    slackContext,
    context,
    additionalParams,
    { profileName },
  );
};

/**
 * Handles "Start Onboarding" button click to open modal.
 */
export function startOnboarding(lambdaContext) {
  const { log } = lambdaContext;

  return async ({
    ack, body, client, respond,
  }) => {
    try {
      await ack();

      const { user } = body;

      // Parse initial values from button value for backwards compatibility
      let initialValues = {};
      try {
        if (body.actions?.[0]?.value && body.actions[0].value !== 'start_onboarding') {
          initialValues = JSON.parse(body.actions[0].value);
        }
      } catch (error) {
        log.warn('Failed to parse initial values from button:', error);
        initialValues = {};
      }

      // Update the original message to show user's choice
      await respond({
        text: `:gear: ${user.name} started the onboarding process...`,
        replace_original: true,
      });

      // Capture original channel and thread context
      const originalChannel = body.channel?.id;
      const originalThreadTs = body.message?.thread_ts || body.message?.ts;

      // Open the onboarding modal
      await client.views.open({
        trigger_id: body.trigger_id,
        view: {
          type: 'modal',
          callback_id: 'onboard_site_modal',
          private_metadata: JSON.stringify({
            originalChannel,
            originalThreadTs,
          }),
          title: {
            type: 'plain_text',
            text: 'Onboard Site',
          },
          submit: {
            type: 'plain_text',
            text: 'Start Onboarding',
          },
          close: {
            type: 'plain_text',
            text: 'Cancel',
          },
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: ':rocket: *Site Onboarding*\n\nProvide the details to onboard a new site to AEM Sites Optimizer.',
              },
            },
            {
              type: 'input',
              block_id: 'site_url_input',
              element: {
                type: 'url_text_input',
                action_id: 'site_url',
                placeholder: {
                  type: 'plain_text',
                  text: 'https://site.url',
                },
                ...(initialValues.site && { initial_value: initialValues.site }),
              },
              label: {
                type: 'plain_text',
                text: 'Site URL',
              },
            },
            {
              type: 'input',
              block_id: 'ims_org_input',
              element: {
                type: 'plain_text_input',
                action_id: 'ims_org_id',
                placeholder: {
                  type: 'plain_text',
                  text: 'ABC123@AdobeOrg (leave empty for default)',
                },
                ...(initialValues.imsOrgId && { initial_value: initialValues.imsOrgId }),
              },
              label: {
                type: 'plain_text',
                text: 'IMS Organization ID',
              },
              optional: true,
            },
            {
              type: 'input',
              block_id: 'profile_input',
              element: {
                type: 'static_select',
                action_id: 'profile',
                placeholder: {
                  type: 'plain_text',
                  text: 'Select onboarding profile',
                },
                initial_option: (() => {
                  const profileOptions = [
                    { text: 'Demo', value: 'demo' },
                    { text: 'Default', value: 'default' },
                  ];

                  const selectedProfile = initialValues.profile || 'demo';
                  const option = profileOptions.find(
                    (opt) => opt.value === selectedProfile,
                  ) || profileOptions[0];

                  return {
                    text: {
                      type: 'plain_text',
                      text: option.text,
                    },
                    value: option.value,
                  };
                })(),
                options: [
                  {
                    text: {
                      type: 'plain_text',
                      text: 'Demo',
                    },
                    value: 'demo',
                  },
                  {
                    text: {
                      type: 'plain_text',
                      text: 'Default',
                    },
                    value: 'default',
                  },
                ],
              },
              label: {
                type: 'plain_text',
                text: 'Configuration Profile',
              },
            },
            {
              type: 'input',
              block_id: 'delivery_type_input',
              element: {
                type: 'static_select',
                action_id: 'delivery_type',
                placeholder: {
                  type: 'plain_text',
                  text: 'Auto-detect (recommended)',
                },
                options: [
                  {
                    text: {
                      type: 'plain_text',
                      text: 'Auto-detect (recommended)',
                    },
                    value: 'auto',
                  },
                  {
                    text: {
                      type: 'plain_text',
                      text: 'AEM Edge Delivery',
                    },
                    value: 'aem_edge',
                  },
                  {
                    text: {
                      type: 'plain_text',
                      text: 'AEM Cloud Service',
                    },
                    value: 'aem_cs',
                  },
                  {
                    text: {
                      type: 'plain_text',
                      text: 'Adobe Managed Services',
                    },
                    value: 'aem_ams',
                  },
                  {
                    text: {
                      type: 'plain_text',
                      text: 'Other',
                    },
                    value: 'other',
                  },
                ],
              },
              label: {
                type: 'plain_text',
                text: 'Delivery Type',
              },
              optional: true,
            },
            {
              type: 'input',
              block_id: 'authoring_type_input',
              element: {
                type: 'static_select',
                action_id: 'authoring_type',
                placeholder: {
                  type: 'plain_text',
                  text: 'Select authoring type (required if preview URL is provided)',
                },
                options: [
                  {
                    text: {
                      type: 'plain_text',
                      text: 'Document Authoring (EDS or DA)',
                    },
                    value: 'documentauthoring',
                  },
                  {
                    text: {
                      type: 'plain_text',
                      text: 'AEM Cloud Service',
                    },
                    value: 'cs',
                  },
                  {
                    text: {
                      type: 'plain_text',
                      text: 'Crosswalk (Universal Editor & EDS)',
                    },
                    value: 'cs/crosswalk',
                  },
                ],
              },
              label: {
                type: 'plain_text',
                text: 'Authoring Type',
              },
              optional: true,
            },
            {
              type: 'input',
              block_id: 'wait_time_input',
              element: {
                type: 'number_input',
                action_id: 'wait_time',
                is_decimal_allowed: false,
                min_value: '0',
                max_value: '3600',
                placeholder: {
                  type: 'plain_text',
                  text: '300 (default)',
                },
                ...(initialValues.workflowWaitTime
                  && { initial_value: initialValues.workflowWaitTime.toString() }),
              },
              label: {
                type: 'plain_text',
                text: 'Workflow Wait Time (seconds)',
              },
              optional: true,
            },
            {
              type: 'divider',
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: '*Preview Environment Configuration* _(Optional)_\nConfigure preview environment for preflight and auto-optimize. Only needed for AEM Cloud Service URLs.',
              },
            },
            {
              type: 'input',
              block_id: 'preview_url_input',
              element: {
                type: 'url_text_input',
                action_id: 'preview_url',
                placeholder: {
                  type: 'plain_text',
                  text: 'https://author-p12345-e67890.adobeaemcloud.com',
                },
              },
              label: {
                type: 'plain_text',
                text: 'Preview URL (AEM Cloud Service)',
              },
              optional: true,
            },
          ],
        },
      });

      log.debug(`User ${user.id} started onboarding process`);
    } catch (error) {
      log.error('Error handling start onboarding:', error);
      await respond({
        text: ':x: There was an error starting the onboarding process.',
        replace_original: false,
      });
    }
  };
}

/**
 * Handles onboard site modal submission.
 */
export function onboardSiteModal(lambdaContext) {
  const { log, dataAccess, env } = lambdaContext;
  const { Site, Configuration } = dataAccess;

  return async ({ ack, body, client }) => {
    try {
      const { view, user } = body;
      const { values } = view.state;

      // Extract original channel and thread context from private metadata
      let originalChannel;
      let originalThreadTs;
      try {
        const metadata = JSON.parse(view.private_metadata || '{}');
        originalChannel = metadata.originalChannel;
        originalThreadTs = metadata.originalThreadTs;
      } catch (error) {
        log.warn('Failed to parse private metadata:', error);
      }

      const siteUrl = values.site_url_input.site_url.value;
      const imsOrgId = values.ims_org_input.ims_org_id.value || env.DEMO_IMS_ORG;
      const profile = values.profile_input.profile.selected_option?.value || 'default';
      const deliveryType = values.delivery_type_input.delivery_type.selected_option?.value;
      const authoringType = values.authoring_type_input.authoring_type.selected_option?.value;
      const waitTime = values.wait_time_input.wait_time.value;
      const previewUrl = values.preview_url_input.preview_url.value;

      // Validation
      if (!siteUrl) {
        await ack({
          response_action: 'errors',
          errors: {
            site_url_input: 'Please provide a site URL',
          },
        });
        return;
      }

      // Validate preview URL if provided
      let deliveryConfigFromPreview = null;
      if (previewUrl) {
        deliveryConfigFromPreview = extractDeliveryConfigFromPreviewUrl(previewUrl);
        if (!deliveryConfigFromPreview) {
          await ack({
            response_action: 'errors',
            errors: {
              preview_url_input: 'Could not extract program/environment ID from this URL. Please provide a valid AEM CS preview URL.',
            },
          });
          return;
        }

        // Require authoring type when preview URL is provided
        if (!authoringType) {
          await ack({
            response_action: 'errors',
            errors: {
              authoring_type_input: 'Authoring type is required when a preview URL is provided.',
            },
          });
          return;
        }
      }

      await ack();

      // Create a slack context for the onboarding process
      // Use original channel/thread if available, otherwise fall back to DM
      const responseChannel = originalChannel || body.user.id;
      const responseThreadTs = originalChannel ? originalThreadTs : undefined;

      const slackContext = {
        say: async (message) => {
          await client.chat.postMessage({
            channel: responseChannel,
            text: message,
            thread_ts: responseThreadTs,
          });
        },
        client,
        channelId: responseChannel,
        threadTs: responseThreadTs,
      };

      const configuration = await Configuration.findLatest();
      const additionalParams = {};
      if (deliveryType && deliveryType !== 'auto') {
        additionalParams.deliveryType = deliveryType;
      }
      if (authoringType && authoringType !== 'default') {
        additionalParams.authoringType = authoringType;
      }
      if (deliveryConfigFromPreview) {
        additionalParams.deliveryConfig = deliveryConfigFromPreview;
      }

      const parsedWaitTime = waitTime ? parseInt(waitTime, 10) : undefined;

      await client.chat.postMessage({
        channel: responseChannel,
        text: `:gear: Starting onboarding for site ${siteUrl}...`,
        thread_ts: responseThreadTs,
      });

      const reportLine = await onboardSingleSiteFromModal(
        siteUrl,
        imsOrgId,
        configuration,
        profile,
        parsedWaitTime,
        slackContext,
        lambdaContext,
        additionalParams,
      );

      // Note: Configuration is already saved by sharedOnboardSingleSite in utils.js
      // No need to call configuration.save() here as it would overwrite the changes

      if (reportLine.errors.length > 0) {
        await client.chat.postMessage({
          channel: responseChannel,
          text: `:warning: ${reportLine.errors}`,
          thread_ts: responseThreadTs,
        });
      } else {
        const site = reportLine.siteId ? await Site.findById(reportLine.siteId) : null;
        const deliveryConfig = site?.getDeliveryConfig();
        const deliveryConfigInfo = deliveryConfig
        && (deliveryConfig.programId || deliveryConfig.environmentId)
          ? `:gear: *Delivery Config:* Program ${deliveryConfig.programId}, Environment ${deliveryConfig.environmentId}`
          : '';

        const previewConfigInfo = deliveryConfigFromPreview
          ? `\n:globe_with_meridians: *Preview Environment:* Configured with Program ${deliveryConfigFromPreview.programId}, Environment ${deliveryConfigFromPreview.environmentId}`
          : '';

        const message = `:white_check_mark: *Onboarding completed successfully by ${user.name}!*

:ims: *IMS Org ID:* ${reportLine.imsOrgId || 'n/a'}
:space-cat: *Spacecat Org ID:* ${reportLine.spacecatOrgId || 'n/a'}
:identification_card: *Site ID:* ${reportLine.siteId || 'n/a'}
:cat-egory-white: *Delivery Type:* ${reportLine.deliveryType || 'n/a'}
${reportLine.authoringType ? `:writing_hand: *Authoring Type:* ${reportLine.authoringType}` : ''}
${deliveryConfigInfo}${previewConfigInfo}
:question: *Already existing:* ${reportLine.existingSite}
:gear: *Profile:* ${reportLine.profile}
:hourglass_flowing_sand: *Wait Time:* ${parsedWaitTime || env.WORKFLOW_WAIT_TIME_IN_SECONDS} seconds
:clipboard: *Audits:* ${reportLine.audits || 'None'}
:inbox_tray: *Imports:* ${reportLine.imports || 'None'}
        `;

        await client.chat.postMessage({
          channel: responseChannel,
          text: message,
          thread_ts: responseThreadTs,
        });
      }

      log.debug(`Onboard site modal processed for user ${user.id}, site ${siteUrl}`);
    } catch (error) {
      log.error('Error handling onboard site modal:', error);
      await ack({
        response_action: 'errors',
        errors: {
          site_url_input: 'There was an error processing the onboarding request.',
        },
      });
    }
  };
}
