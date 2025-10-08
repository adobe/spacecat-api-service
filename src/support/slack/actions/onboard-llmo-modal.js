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

import { Config } from '@adobe/spacecat-shared-data-access/src/models/site/config.js';
import {
  postErrorMessage,
} from '../../../utils/slack/base.js';
import {
  createEntitlementAndEnrollment,
  copyFilesToSharepoint,
  updateIndexConfig,
  enableAudits,
  removeEnrollment,
} from '../../../controllers/llmo/llmo-onboarding.js';

const REFERRAL_TRAFFIC_AUDIT = 'llmo-referral-traffic';
const REFERRAL_TRAFFIC_IMPORT = 'traffic-analysis';
const AGENTIC_TRAFFIC_ANALYSIS_AUDIT = 'cdn-analysis';
const AGENTIC_TRAFFIC_REPORT_AUDIT = 'cdn-logs-report';

// site isn't on spacecat yet
async function fullOnboardingModal(body, client, respond, brandURL) {
  const { user } = body;

  // Update the original message to show user's choice
  await respond({
    text: `:gear: ${user.name} started the onboarding process...`,
    replace_original: true,
  });

  // Capture original channel and thread context
  const originalChannel = body.channel?.id;
  const originalThreadTs = body.message?.thread_ts || body.message?.ts;

  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal',
      callback_id: 'onboard_llmo_modal',
      private_metadata: JSON.stringify({
        originalChannel,
        originalThreadTs,
        brandURL,
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
            text: ':rocket: *LLMO Site Onboarding*\n\nProvide the details to onboard a new site to LLMO.',
          },
        },
        {
          type: 'input',
          block_id: 'brand_name_input',
          element: {
            type: 'plain_text_input',
            action_id: 'brand_name',
            placeholder: {
              type: 'plain_text',
              text: 'Brand Name',
            },
          },
          label: {
            type: 'plain_text',
            text: 'Brand Name',
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
              text: 'ABC123@AdobeOrg',
            },
          },
          label: {
            type: 'plain_text',
            text: 'IMS Organization ID',
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
              text: 'Please Select Value',
            },
            options: [
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
        },
      ],
    },
  });
}

// site is already on spacecat
async function elmoOnboardingModal(body, client, respond, brandURL) {
  const { user } = body;

  // Update the original message to show user's choice
  await respond({
    text: `:gear: ${user.name} started the onboarding process...`,
    replace_original: true,
  });

  // Capture original channel and thread context
  const originalChannel = body.channel?.id;
  const originalThreadTs = body.message?.thread_ts || body.message?.ts;

  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal',
      callback_id: 'onboard_llmo_modal',
      private_metadata: JSON.stringify({
        originalChannel,
        originalThreadTs,
        brandURL,
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
          block_id: 'brand_name_input',
          element: {
            type: 'plain_text_input',
            action_id: 'brand_name',
            placeholder: {
              type: 'plain_text',
              text: 'Brand Name',
            },
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
              text: 'ABC123@AdobeOrg',
            },
          },
          label: {
            type: 'plain_text',
            text: 'IMS Organization ID',
          },
        },
      ],
    },
  });
}

async function createOrg(imsOrgId, lambdaCtx, slackCtx) {
  const { log, imsClient, dataAccess } = lambdaCtx;
  const { say } = slackCtx;
  const { Organization } = dataAccess;

  let imsOrgDetails;
  try {
    imsOrgDetails = await imsClient.getImsOrganizationDetails(imsOrgId);
  } catch (error) {
    log.error(`Error retrieving IMS Org details: ${error.message}`);
    await say(`:x: Could not find an IMS org with the ID *${imsOrgId}*.`);
    throw error;
  }

  if (!imsOrgDetails) {
    await say(`:x: Could not find an IMS org with the ID *${imsOrgId}*.`);
    throw new Error('Failed crating organization.');
  }

  // create a new spacecat org
  const newImsOrg = await Organization.create({
    name: imsOrgDetails.orgName,
    imsOrgId,
  });
  await newImsOrg.save();
  return newImsOrg;
}

// ensures that the site has the provided imsOrgId set
async function checkOrg(imsOrgId, site, lambdaCtx, slackCtx) {
  const { dataAccess } = lambdaCtx;
  const { Organization } = dataAccess;

  // fetch both existing site's org id and newly provided org id
  const existingOrgId = site.getOrganizationId();
  const providedImsOrg = await Organization.findByImsOrgId(imsOrgId);
  const providedImsOrgId = providedImsOrg?.getId();

  // if the org is already set, do nothing
  if (existingOrgId === providedImsOrgId) {
    return;
  }

  // if the provided ims org id exists, update the site to use this one
  if (providedImsOrgId) {
    site.setOrganizationId(providedImsOrgId);
    await site.save();
    return;
  }

  // the provided ims doesn't have a spacecat org, create it and add to site
  const newImsOrg = await createOrg(imsOrgId, lambdaCtx, slackCtx);

  site.setOrganizationId(newImsOrg.getId());
  await site.save();
}

/* displays modal */
export function startLLMOOnboarding(lambdaContext) {
  const { log, dataAccess } = lambdaContext;

  return async ({
    ack, body, client, respond,
  }) => {
    try {
      await ack();

      const { user, actions } = body;
      const { Site } = dataAccess;

      // check current onboarding status
      const brandURL = actions?.[0]?.value;
      const site = await Site.findByBaseURL(brandURL);

      if (!site) {
        await fullOnboardingModal(body, client, respond, brandURL);
        log.debug(`User ${user.id} started full onboarding process for ${brandURL}.`);
        return;
      }

      await elmoOnboardingModal(body, client, respond, brandURL);
      log.debug(`User ${user.id} started LLMO onboarding process for ${brandURL} with existing site ${site.getId()}.`);
    } catch (e) {
      log.error('Error handling start onboarding:', e);
      await respond({
        text: ':x: There was an error starting the onboarding process.',
        replace_original: false,
      });
    }
  };
}

async function createSiteAndOrganization(input, lambda, slackContext) {
  const { dataAccess } = lambda;
  const {
    baseURL, imsOrgId, deliveryType,
  } = input;
  const { Organization, Site } = dataAccess;

  const org = await Organization.findByImsOrgId(imsOrgId);
  let orgId = org?.getId();
  if (!orgId) {
    const newOrg = await createOrg(imsOrgId, lambda, slackContext);
    orgId = newOrg.getId();
  }

  const site = await Site.create({
    baseURL, deliveryType, organizationId: orgId,
  });
  await site.save();
  return site.getId();
}

export async function onboardSite(input, lambdaCtx, slackCtx) {
  const {
    log, dataAccess, sqs, env,
  } = lambdaCtx;
  const { say } = slackCtx;
  const {
    baseURL, brandName, imsOrgId,
  } = input;
  const { hostname } = new URL(baseURL);
  const dataFolderName = hostname.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
  /* c8 ignore next */
  const dataFolder = env.ENV === 'prod' ? dataFolderName : `dev/${dataFolderName}`;

  const {
    Site, Configuration,
  } = dataAccess;

  await say(`:gear: ${brandName} onboarding started...`);

  try {
    // Find the site
    let site = await Site.findByBaseURL(baseURL);
    if (!site) {
      // create a new site
      const configuration = await Configuration.findLatest();
      // onboard the site
      const siteId = await createSiteAndOrganization(input, lambdaCtx, slackCtx);

      await configuration.save();
      site = await Site.findById(siteId);
    } else {
      // check that the existing site matches the provided IMS org id
      await checkOrg(imsOrgId, site, lambdaCtx, slackCtx);
    }

    // create entitlement
    await createEntitlementAndEnrollment(site, lambdaCtx, slackCtx.say);

    // upload and publish the query index file
    await copyFilesToSharepoint(dataFolder, lambdaCtx, slackCtx.say);

    // update indexing config in helix
    await updateIndexConfig(dataFolder, lambdaCtx, slackCtx.say);

    const siteId = site.getId();

    // Get current site config
    const siteConfig = site.getConfig();

    // Update brand and data directory
    siteConfig.updateLlmoBrand(brandName.trim());
    siteConfig.updateLlmoDataFolder(dataFolder.trim());

    // enable the traffic-analysis import for referral-traffic
    siteConfig.enableImport(REFERRAL_TRAFFIC_IMPORT);

    // enable the llmo-prompts-ahrefs import
    siteConfig.enableImport('llmo-prompts-ahrefs', { limit: 25 });

    // update the site config object
    site.setConfig(Config.toDynamoItem(siteConfig));

    // enable all necessary handlers
    const configuration = await Configuration.findLatest();

    // enable the cdn-analysis only if no other site in this organization already has it enabled
    const orgId = site.getOrganizationId();
    const sitesInOrg = await Site.allByOrganizationId(orgId);

    const hasAgenticTrafficEnabled = sitesInOrg.some(
      (orgSite) => configuration.isHandlerEnabledForSite(AGENTIC_TRAFFIC_ANALYSIS_AUDIT, orgSite),
    );

    if (!hasAgenticTrafficEnabled) {
      log.info(`Enabling agentic traffic audits for organization ${orgId} (first site in org)`);
      configuration.enableHandlerForSite(AGENTIC_TRAFFIC_ANALYSIS_AUDIT, site);
    } else {
      log.debug(`Agentic traffic audits already enabled for organization ${orgId}, skipping`);
    }

    try {
      await configuration.save();

      await enableAudits(site, lambdaCtx, [
        AGENTIC_TRAFFIC_REPORT_AUDIT, // enable the cdn-logs-report audits for agentic traffic
        'llmo-customer-analysis', // this generates LLMO excel sheets and triggers audits
        REFERRAL_TRAFFIC_AUDIT,
        'geo-brand-presence',
        'headings',
        'llm-blocked',
      ]);

      await site.save();
      log.debug(`Successfully updated LLMO config for site ${siteId}`);

      // trigger the llmo-customer-analysis handler
      const sqsTriggerMessage = {
        type: 'llmo-customer-analysis',
        siteId,
        auditContext: {
          auditType: 'llmo-customer-analysis',
        },
      };
      await sqs.sendMessage(configuration.getQueues().audits, sqsTriggerMessage);

      const message = `:white_check_mark: *LLMO onboarding completed successfully!*
        
:link: *Site:* ${baseURL}
:identification_card: *Site ID:* ${siteId}
:file_folder: *Data Folder:* ${dataFolder}
:label: *Brand:* ${brandName}
:identification_card: *IMS Org ID:* ${imsOrgId}

The LLMO Customer Analysis handler has been triggered. It will take a few minutes to complete.`;

      await say(message);
    } catch (error) {
      log.error(`Error saving LLMO config for site ${siteId}: ${error.message}`);
      await say(`:x: Failed to save LLMO configuration: ${error.message}`);
    }
  } catch (error) {
    log.error('Error in LLMO onboarding:', error);
    await postErrorMessage(say, error);
  }
}

/* Handles submission */
export function onboardLLMOModal(lambdaContext) {
  const { log } = lambdaContext;

  return async ({ ack, body, client }) => {
    try {
      log.debug('Starting onboarding process...');
      const { view, user } = body;
      const { values } = view.state;

      // Extract original channel and thread context from private metadata
      let originalChannel;
      let originalThreadTs;
      let brandURL;
      try {
        /* c8 ignore next */
        const metadata = JSON.parse(view.private_metadata || '{}');
        originalChannel = metadata.originalChannel;
        originalThreadTs = metadata.originalThreadTs;
        brandURL = metadata.brandURL;
      } catch (error) {
        log.warn('Failed to parse private metadata:', error);
      }

      const brandName = values.brand_name_input.brand_name.value;
      const imsOrgId = values.ims_org_input.ims_org_id.value;
      const deliveryType = values.delivery_type_input?.delivery_type?.selected_option?.value;

      if (!brandName || !imsOrgId) {
        await ack({
          response_action: 'errors',
          errors: {
            brand_name_input: !brandName ? 'Brand name is required' : undefined,
            ims_org_input: !imsOrgId ? 'IMS Org ID is required' : undefined,
          },
        });
        return;
      }

      log.info('Onboarding request with parameters:', {
        brandName,
        imsOrgId,
        deliveryType: deliveryType ?? 'not set',
        brandURL,
        originalChannel,
        originalThreadTs,
      });

      // eslint-disable-next-line max-statements-per-line
      await new Promise((resolve) => { setTimeout(resolve, 500); });
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

      await onboardSite({
        brandName, baseURL: brandURL, imsOrgId, deliveryType,
      }, lambdaContext, slackContext);

      log.debug(`Onboard LLMO modal processed for user ${user.id}, site ${brandURL}`);
    } catch (e) {
      log.error('Error handling onboard site modal:', e);
      await ack({
        response_action: 'errors',
        errors: {
          brand_name_input: 'There was an error processing the onboarding request.',
        },
      });
    }
  };
}

/* Handles "Add Entitlements" button click */
export function addEntitlementsAction(lambdaContext) {
  const { log, dataAccess } = lambdaContext;

  return async ({ ack, body, client }) => {
    const metadata = JSON.parse(body.actions[0].value);
    const originalChannel = body.channel?.id;

    const {
      brandURL,
      siteId,
      originalThreadTs,
      existingBrand,
    } = metadata;

    try {
      await ack();
      const { user } = body;

      await client.chat.update({
        channel: originalChannel,
        ts: body.message.ts,
        text: `:gear: ${user.name} is adding LLMO entitlements...`,
        blocks: [],
      });

      const { Site } = dataAccess;
      const site = await Site.findById(siteId);

      if (!site) {
        await client.chat.postMessage({
          channel: originalChannel,
          text: ':x: Site not found. Please try again.',
          thread_ts: originalThreadTs,
        });
        return;
      }

      /* c8 ignore start */
      const slackContext = {
        say: async (message) => {
          await client.chat.postMessage({
            channel: originalChannel,
            text: message,
            thread_ts: originalThreadTs,
          });
        },
      };
      /* c8 ignore end */

      await createEntitlementAndEnrollment(site, lambdaContext, slackContext.say);
      await client.chat.postMessage({
        channel: originalChannel,
        text: `:white_check_mark: Successfully ensured LLMO entitlements and enrollments for *${brandURL}* (brand: *${existingBrand}*).`,
        thread_ts: originalThreadTs,
      });

      log.debug(`Added entitlements for site ${siteId} (${brandURL}) for user ${user.id}`);
    } catch (error) {
      log.error('Error adding entitlements:', error);
    }
  };
}

/* Handles "Update IMS Organization" button click */
export function updateOrgAction(lambdaContext) {
  const { log, dataAccess } = lambdaContext;

  return async ({ ack, body, client }) => {
    try {
      await ack();
      const { user } = body;
      const metadata = JSON.parse(body.actions[0].value);
      const originalChannel = body.channel?.id;

      await client.chat.update({
        channel: originalChannel,
        ts: body.message.ts,
        text: `:gear: ${user.name} is updating IMS organization...`,
        blocks: [],
      });

      const {
        brandURL,
        siteId,
        existingBrand,
        currentOrgId,
        originalThreadTs,
      } = metadata;

      let currentImsOrgId = 'ABC123@AdobeOrg';
      if (currentOrgId) {
        try {
          const { Organization } = dataAccess;
          const currentOrg = await Organization.findById(currentOrgId);
          if (currentOrg && currentOrg.getImsOrgId()) {
            currentImsOrgId = currentOrg.getImsOrgId();
          }
        } catch (error) {
          log.warn(`Could not fetch current IMS org ID for organization ${currentOrgId}: ${error.message}`);
        }
      }

      await client.views.open({
        trigger_id: body.trigger_id,
        view: {
          type: 'modal',
          callback_id: 'update_ims_org_modal',
          private_metadata: JSON.stringify({
            originalChannel,
            originalThreadTs,
            brandURL,
            siteId,
            existingBrand,
          }),
          title: {
            type: 'plain_text',
            text: 'Update IMS Organization',
          },
          submit: {
            type: 'plain_text',
            text: 'Update & Apply',
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
                text: `:arrows_counterclockwise: *Update IMS Organization*\n\nUpdating IMS organization for site *${brandURL}* (brand: *${existingBrand}*)\n\nProvide the new IMS Organization ID:`,
              },
            },
            {
              type: 'input',
              block_id: 'new_ims_org_input',
              element: {
                type: 'plain_text_input',
                action_id: 'new_ims_org_id',
                placeholder: {
                  type: 'plain_text',
                  text: currentImsOrgId,
                },
              },
              label: {
                type: 'plain_text',
                text: 'New IMS Organization ID',
              },
            },
          ],
        },
      });

      log.debug(`User ${user.id} started org update process for site ${siteId} (${brandURL})`);
    } catch (error) {
      log.error('Error starting org update:', error);
    }
  };
}

/* Handles "Update IMS Organization" modal submission */
export function updateIMSOrgModal(lambdaContext) {
  const { log, dataAccess } = lambdaContext;

  return async ({ ack, body, client }) => {
    try {
      const { view, user } = body;
      const { values } = view.state;

      /* c8 ignore next */
      const metadata = JSON.parse(view.private_metadata || '{}');
      const {
        originalChannel, originalThreadTs, brandURL, siteId, existingBrand,
      } = metadata;

      const newImsOrgId = values.new_ims_org_input.new_ims_org_id.value;

      if (!newImsOrgId) {
        await ack({
          response_action: 'errors',
          errors: {
            new_ims_org_input: 'IMS Organization ID is required',
          },
        });
        return;
      }

      await ack();
      const responseChannel = originalChannel;
      const responseThreadTs = originalThreadTs;
      const { Site } = dataAccess;
      const site = await Site.findById(siteId);

      if (!site) {
        await client.chat.postMessage({
          channel: responseChannel,
          text: ':x: Site not found. Please try again.',
          thread_ts: responseThreadTs,
        });
        return;
      }

      /* c8 ignore start */
      const slackContext = {
        say: async (message) => {
          await client.chat.postMessage({
            channel: responseChannel,
            text: message,
            thread_ts: responseThreadTs,
          });
        },
      };
      /* c8 ignore end */

      await checkOrg(newImsOrgId, site, lambdaContext, slackContext);
      await createEntitlementAndEnrollment(site, lambdaContext, slackContext.say);

      await client.chat.postMessage({
        channel: responseChannel,
        text: `:white_check_mark: Successfully updated organization and applied LLMO entitlements for *${brandURL}* (brand: *${existingBrand}*)`,
        thread_ts: responseThreadTs,
      });

      log.debug(`Updated org and applied entitlements for site ${siteId} (${brandURL}) for user ${user.id}`);
    } catch (error) {
      log.error('Error updating organization:', error);
    }
  };
}

export function removeLlmoEnrollment(lambdaContext) {
  const { log } = lambdaContext;

  return async ({ ack, body, client }) => {
    try {
      await ack();

      const metadata = JSON.parse(body.actions[0].value);
      const {
        brandURL,
        siteId,
        existingBrand,
        originalThreadTs,
      } = metadata;

      const originalChannel = body.channel?.id;
      const { user } = body;

      log.info(`User ${user.id} initiated LLMO enrollment removal for site ${siteId} (${brandURL})`);

      // Update the original message to show user's action
      await client.chat.update({
        channel: originalChannel,
        ts: body.message.ts,
        text: `:warning: ${user.name} is removing LLMO enrollment for ${brandURL}...`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `:warning: ${user.name} is removing LLMO enrollment for ${brandURL}...`,
            },
          },
        ],
      });

      // Show confirmation modal
      await client.views.open({
        trigger_id: body.trigger_id,
        view: {
          type: 'modal',
          callback_id: 'confirm_remove_llmo_enrollment',
          private_metadata: JSON.stringify({
            brandURL,
            siteId,
            existingBrand,
            originalChannel,
            originalThreadTs,
            originalMessageTs: body.message.ts,
          }),
          title: {
            type: 'plain_text',
            text: 'Confirm Removal',
          },
          submit: {
            type: 'plain_text',
            text: 'Remove Enrollment',
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
                text: `:warning: *Are you sure you want to remove LLMO enrollment?*\n\n*Site:* ${brandURL}\n*Brand:* ${existingBrand}\n\nThis action will:\n• Revoke the site's LLMO enrollment\n• Remove access to LLMO features for this site\n\n*This action cannot be undone.*`,
              },
            },
          ],
        },
      });
    } catch (error) {
      log.error('Error handling remove LLMO enrollment action:', error);
      const metadata = JSON.parse(body.actions[0].value);
      await client.chat.postMessage({
        channel: body.channel?.id,
        text: `:x: Failed to initiate enrollment removal: ${error.message}`,
        thread_ts: metadata.originalThreadTs,
      });
    }
  };
}

export function confirmRemoveLlmoEnrollment(lambdaContext) {
  const { log, dataAccess } = lambdaContext;

  return async ({ ack, body, client }) => {
    try {
      log.debug('Processing LLMO enrollment removal confirmation...');

      const { view, user } = body;
      const metadata = JSON.parse(view.private_metadata);
      const {
        brandURL,
        siteId,
        existingBrand,
        originalChannel,
        originalThreadTs,
        originalMessageTs,
      } = metadata;

      // Acknowledge the modal submission
      await ack();

      // Post initial message to the thread
      const responseChannel = originalChannel || body.user.id;
      const responseThreadTs = originalChannel ? originalThreadTs : undefined;

      await client.chat.postMessage({
        channel: responseChannel,
        text: `:gear: Removing LLMO enrollment for ${brandURL}...`,
        thread_ts: responseThreadTs,
      });

      try {
        // Find the site
        const { Site } = dataAccess;
        const site = await Site.findById(siteId);

        if (!site) {
          throw new Error(`Site not found: ${siteId}`);
        }

        // Use the reusable removeEnrollment function from the LLMO controller
        await removeEnrollment(site, lambdaContext);

        log.info(`Successfully revoked LLMO enrollment for site ${siteId} (${brandURL})`);

        // Update the original message to show completion
        if (originalMessageTs) {
          await client.chat.update({
            channel: responseChannel,
            ts: originalMessageTs,
            text: `:white_check_mark: LLMO enrollment removed for ${brandURL}`,
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: `:white_check_mark: *LLMO Enrollment Removed*\n\nThe LLMO enrollment for *${brandURL}* (brand: *${existingBrand}*) has been successfully removed by ${user.name}.`,
                },
              },
            ],
          });
        }

        // Post success message to the thread
        const successMessage = `:white_check_mark: *LLMO enrollment removed successfully!*

:link: *Site:* ${brandURL}
:identification_card: *Site ID:* ${siteId}
:label: *Brand:* ${existingBrand}
:bust_in_silhouette: *Removed by:* ${user.name}

The site enrollment has been revoked. The site can be re-onboarded at any time using the \`onboard-llmo\` command.`;

        await client.chat.postMessage({
          channel: responseChannel,
          text: successMessage,
          thread_ts: responseThreadTs,
        });
      } catch (error) {
        log.error(`Error removing LLMO enrollment for site ${siteId}:`, error);

        // Update the original message to show error
        if (originalMessageTs) {
          await client.chat.update({
            channel: responseChannel,
            ts: originalMessageTs,
            text: `:x: Failed to remove LLMO enrollment for ${brandURL}`,
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: `:x: *Failed to remove LLMO enrollment*\n\nThere was an error removing the enrollment for *${brandURL}*.`,
                },
              },
            ],
          });
        }

        // Post error message to the thread
        await client.chat.postMessage({
          channel: responseChannel,
          text: `:x: Failed to remove LLMO enrollment: ${error.message}`,
          thread_ts: responseThreadTs,
        });
      }

      log.debug(`LLMO enrollment removal processed for user ${user.id}, site ${brandURL}`);
    } catch (error) {
      log.error('Error handling confirm remove LLMO enrollment modal:', error);
      await ack({
        response_action: 'errors',
        errors: {
          general: 'There was an error processing the removal request.',
        },
      });
    }
  };
}
