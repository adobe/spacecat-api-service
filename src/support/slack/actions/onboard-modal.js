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
import { Entitlement as EntitlementModel } from '@adobe/spacecat-shared-data-access/src/models/entitlement/index.js';
import { onboardSingleSite as sharedOnboardSingleSite } from '../../utils.js';
import { triggerBrandProfileAgent } from '../../brand-profile-trigger.js';
import { loadProfileConfig } from '../../../utils/slack/base.js';
import { checkBotProtectionDuringOnboarding } from '../../utils/bot-protection-check.js';
import { formatBotProtectionSlackMessage } from './commons.js';

export const AEM_CS_HOST = /^author-p(\d+)-e(\d+)/i;

/**
 * Extracts program and environment ID from AEM Cloud Service preview URLs.
 * @param {string} previewUrl - The preview URL to parse
 * @param {string} imsOrgId - The IMS Organization ID to include in the delivery config
 * @returns {Object|null} Object with programId, environmentId, authorURL, preferContentApi,
 *                        and imsOrgId, or null if not extractable
 */
export function extractDeliveryConfigFromPreviewUrl(previewUrl, imsOrgId) {
  if (!isValidUrl(previewUrl)) {
    return null;
  }
  const url = new URL(previewUrl);
  const { hostname } = url;

  let programId = null;
  let environmentId = null;

  if (AEM_CS_HOST.test(hostname)) {
    [, programId, environmentId] = hostname.match(AEM_CS_HOST);
  }

  return {
    ...(programId && { programId }),
    ...(environmentId && { environmentId }),
    authorURL: previewUrl,
    preferContentApi: true,
    imsOrgId: imsOrgId || null,
  };
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
              block_id: 'project_id_input',
              element: {
                type: 'plain_text_input',
                action_id: 'project_id',
                placeholder: {
                  type: 'plain_text',
                  text: 'Project ID (leave empty to create a new project)',
                },
                ...(initialValues.projectId && { initial_value: initialValues.projectId }),
              },
              label: {
                type: 'plain_text',
                text: 'Project ID',
              },
              optional: true,
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
                    { text: 'Paid', value: 'paid' },
                    { text: 'PLG', value: 'plg' },
                    { text: 'Test', value: 'test' },
                    { text: 'Dummy', value: 'dummy' },
                  ];

                  // Use provided profile or default to 'demo'
                  const selectedProfile = initialValues.profile || 'demo';
                  const option = profileOptions.find(
                    (opt) => opt.value === selectedProfile,
                  );

                  if (option) {
                    return {
                      text: {
                        type: 'plain_text',
                        text: option.text,
                      },
                      value: option.value,
                    };
                  }

                  // Fallback to demo if somehow not found
                  return {
                    text: {
                      type: 'plain_text',
                      text: 'Demo',
                    },
                    value: 'demo',
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
                      text: 'Paid',
                    },
                    value: 'paid',
                  },
                  {
                    text: {
                      type: 'plain_text',
                      text: 'PLG',
                    },
                    value: 'plg',
                  },
                  {
                    text: {
                      type: 'plain_text',
                      text: 'Test',
                    },
                    value: 'test',
                  },
                  {
                    text: {
                      type: 'plain_text',
                      text: 'Dummy',
                    },
                    value: 'dummy',
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
              type: 'input',
              block_id: 'tier_input',
              element: {
                type: 'static_select',
                action_id: 'tier',
                placeholder: {
                  type: 'plain_text',
                  text: 'Select entitlement tier',
                },
                initial_option: {
                  text: {
                    type: 'plain_text',
                    text: 'Free Trial',
                  },
                  value: EntitlementModel.TIERS.FREE_TRIAL,
                },
                options: [
                  {
                    text: {
                      type: 'plain_text',
                      text: 'Free Trial',
                    },
                    value: EntitlementModel.TIERS.FREE_TRIAL,
                  },
                  {
                    text: {
                      type: 'plain_text',
                      text: 'Paid',
                    },
                    value: EntitlementModel.TIERS.PAID,
                  },
                ],
              },
              label: {
                type: 'plain_text',
                text: 'Entitlement Tier',
              },
              optional: true,
            },
            {
              type: 'input',
              block_id: 'scheduled_run_input',
              element: {
                type: 'static_select',
                action_id: 'scheduled_run',
                placeholder: {
                  type: 'plain_text',
                  text: 'Select scheduled run preference',
                },
                options: [
                  {
                    text: {
                      type: 'plain_text',
                      text: 'False (Disable imports and audits after onboarding)',
                    },
                    value: 'false',
                  },
                  {
                    text: {
                      type: 'plain_text',
                      text: 'True (Keep imports and audits enabled for scheduled runs)',
                    },
                    value: 'true',
                  },
                ],
              },
              label: {
                type: 'plain_text',
                text: 'Scheduled Run',
              },
              optional: true,
            },
            {
              type: 'input',
              block_id: 'language_input',
              element: {
                type: 'plain_text_input',
                action_id: 'language',
                max_length: 2,
                min_length: 2,
                placeholder: {
                  type: 'plain_text',
                  text: 'Language Code (leave empty for auto detection)',
                },
                ...(initialValues.language && { initial_value: initialValues.language }),
              },
              label: {
                type: 'plain_text',
                text: 'Language Code (ISO 639-1)',
              },
              optional: true,
            },
            {
              type: 'input',
              block_id: 'region_input',
              element: {
                type: 'plain_text_input',
                action_id: 'region',
                max_length: 2,
                min_length: 2,
                placeholder: {
                  type: 'plain_text',
                  text: 'Country Code (leave empty for auto detection)',
                },
                ...(initialValues.region && { initial_value: initialValues.region }),
              },
              label: {
                type: 'plain_text',
                text: 'Country Code (ISO 3166-1 alpha-2)',
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
                text: '*Preview Environment Configuration (Optional)*\nConfigure preview environment for preflight and auto-optimize.',
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
                text: 'Preview URL (AEM Cloud Service or AMS)',
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
                  {
                    text: {
                      type: 'plain_text',
                      text: 'Adobe Managed Services',
                    },
                    value: 'ams',
                  },
                ],
              },
              label: {
                type: 'plain_text',
                text: 'Authoring Type (Required with Preview URL)',
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
      const profile = values.profile_input.profile.selected_option?.value || 'demo';
      const deliveryType = values.delivery_type_input.delivery_type.selected_option?.value;
      const authoringType = values.authoring_type_input.authoring_type.selected_option?.value;
      const waitTime = values.wait_time_input.wait_time.value;
      const previewUrl = values.preview_url_input.preview_url.value;
      const tier = values.tier_input.tier.selected_option?.value
        || EntitlementModel.TIERS.FREE_TRIAL;
      const scheduledRun = values.scheduled_run_input?.scheduled_run?.selected_option?.value;
      const projectId = values.project_id_input.project_id.value;
      const language = values.language_input.language.value;
      const region = values.region_input.region.value;

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

      // Validate preview URL if provided
      let deliveryConfigFromPreview = null;
      if (previewUrl) {
        deliveryConfigFromPreview = extractDeliveryConfigFromPreviewUrl(previewUrl, imsOrgId);
        if (!deliveryConfigFromPreview) {
          await ack({
            response_action: 'errors',
            errors: {
              preview_url_input: 'Please provide a valid preview URL.',
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

      const configuration = await Configuration.findLatest();
      await ack();

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

      if (tier) {
        additionalParams.tier = tier;
      }

      if (scheduledRun !== undefined) {
        additionalParams.scheduledRun = scheduledRun === 'true';
      }
      if (projectId) {
        additionalParams.projectId = projectId;
      }
      if (language) {
        additionalParams.language = language;
      }
      if (region) {
        additionalParams.region = region;
      }

      const parsedWaitTime = waitTime ? parseInt(waitTime, 10) : undefined;

      await client.chat.postMessage({
        channel: responseChannel,
        text: `:gear: Starting onboarding for site ${siteUrl}...`,
        thread_ts: responseThreadTs,
      });

      const botProtectionResult = await checkBotProtectionDuringOnboarding(siteUrl, log);

      // Check if Cloudflare/bot protection infrastructure is present
      const hasProtectionInfrastructure = botProtectionResult.type
        && (botProtectionResult.type.includes('cloudflare')
          || botProtectionResult.type.includes('imperva')
          || botProtectionResult.type.includes('akamai'));

      if (botProtectionResult.blocked) {
        log.warn(`Bot protection detected for ${siteUrl} - stopping onboarding`, botProtectionResult);

        const environment = env.AWS_REGION?.includes('us-east') ? 'prod' : 'dev';
        const botProtectionMessage = formatBotProtectionSlackMessage({
          siteUrl,
          botProtection: botProtectionResult,
          environment,
        });

        await client.chat.postMessage({
          channel: responseChannel,
          text: `:warning: *Bot Protection Detected for ${siteUrl}*`,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: botProtectionMessage,
              },
            },
          ],
          thread_ts: responseThreadTs,
        });

        await client.chat.postMessage({
          channel: responseChannel,
          text: ':x: *Onboarding stopped.* Please allowlist SpaceCat IPs and User-Agent as shown above, then re-run the onboard command.',
          thread_ts: responseThreadTs,
        });

        return;
      }

      if (hasProtectionInfrastructure && !botProtectionResult.blocked) {
        log.info(`Bot protection infrastructure detected for ${siteUrl} but currently allowed`, botProtectionResult);

        const environment = env.AWS_REGION?.includes('us-east') ? 'prod' : 'dev';
        const botProtectionMessage = formatBotProtectionSlackMessage({
          siteUrl,
          botProtection: botProtectionResult,
          environment,
        });

        await client.chat.postMessage({
          channel: responseChannel,
          text: `:information_source: *Bot Protection Infrastructure Detected for ${siteUrl}*`,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: botProtectionMessage,
              },
            },
          ],
          thread_ts: responseThreadTs,
        });

        await client.chat.postMessage({
          channel: responseChannel,
          text: ':white_check_mark: SpaceCat can currently access the site, but if audits fail, please verify the allowlist configuration above.',
          thread_ts: responseThreadTs,
        });
      }

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

        const message = `:white_check_mark: *Onboarding triggered successfully by ${user.name}!*

:ims: *IMS Org ID:* ${reportLine.imsOrgId || 'n/a'}
:groups: *Project ID:* ${reportLine.projectId || 'n/a'}
:space-cat: *Spacecat Org ID:* ${reportLine.spacecatOrgId || 'n/a'}
:identification_card: *Site ID:* ${reportLine.siteId || 'n/a'}
:cat-egory-white: *Delivery Type:* ${reportLine.deliveryType || 'n/a'}
${reportLine.authoringType ? `:writing_hand: *Authoring Type:* ${reportLine.authoringType}` : ''}
${deliveryConfigInfo}${previewConfigInfo}
:paid: *Entitlement Tier:* ${reportLine.tier || 'n/a'}
:speaking_head_in_silhouette: *Language Code:* ${reportLine.language || 'n/a'}
:globe_with_meridians: *Country Code:* ${reportLine.region || 'n/a'}
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

        if (site) {
          await triggerBrandProfileAgent({
            context: lambdaContext,
            site,
            slackContext,
            reason: 'aso-slack',
          });
        }
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
