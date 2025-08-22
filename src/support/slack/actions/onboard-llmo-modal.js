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
import { createFrom } from '@adobe/spacecat-helix-content-sdk';
import { getLastNumberOfWeeks } from '@adobe/spacecat-shared-utils';
import { postErrorMessage } from '../../../utils/slack/base.js';

const REFERRAL_TRAFFIC_AUDIT = 'llmo-referral-traffic';
const REFERRAL_TRAFFIC_IMPORT = 'traffic-analysis';
const AGENTIC_TRAFFIC_ANALYSIS_AUDIT = 'cdn-analysis';
const AGENTIC_TRAFFIC_REPORT_AUDIT = 'cdn-logs-report';

/* displays modal */
export function startLLMOOnboarding(lambdaContext) {
  const { log } = lambdaContext;

  return async ({
    ack, body, client, respond,
  }) => {
    try {
      await ack();

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
              },
              label: {
                type: 'plain_text',
                text: 'Site URL',
              },
            },
          ],
        },
      });

      log.info(`User ${user.id} started onboarding process`);
    } catch (e) {
      log.error('Error handling start onboarding:', e);
      await respond({
        text: ':x: There was an error starting the onboarding process.',
        replace_original: false,
      });
    }
  };
}

async function triggerReferralTrafficBackfill(context, configuration, siteId) {
  const { log, sqs } = context;

  const last4Weeks = getLastNumberOfWeeks(4);

  for (const last4Week of last4Weeks) {
    const { week, year } = last4Week;
    const message = {
      type: REFERRAL_TRAFFIC_IMPORT,
      siteId,
      auditContext: {
        auditType: REFERRAL_TRAFFIC_AUDIT,
        week,
        year,
      },
    };
    sqs.sendMessage(configuration.getQueues().imports, message);
    log.info(`Successfully triggered import ${REFERRAL_TRAFFIC_IMPORT} with message: ${JSON.stringify(message)}`);
  }
}

async function checkOrg(imsOrgId, site, lambdaCtx, slackCtx) {
  const { log, dataAccess, imsClient } = lambdaCtx;
  const { say } = slackCtx;
  const { Organization } = dataAccess;

  const existingOrgId = site.getOrganizationId();
  if (existingOrgId && existingOrgId !== imsOrgId) {
    throw new Error(`Expected provided IMS org id ${imsOrgId} to match IMS org id set on site: ${existingOrgId}`);
  }

  let spaceCatOrg = await Organization.findByImsOrgId(imsOrgId);

  // if not found, try retrieving from IMS, then create a new spacecat org
  if (!spaceCatOrg) {
    let imsOrgDetails;
    try {
      imsOrgDetails = await imsClient.getImsOrganizationDetails(imsOrgId);
      log.info(`IMS Org Details: ${imsOrgDetails}`);
    } catch (error) {
      log.error(`Error retrieving IMS Org details: ${error.message}`);
      await say(`:x: Could not find an IMS org with the ID *${imsOrgId}*.`);
      return;
    }

    if (!imsOrgDetails) {
      await say(`:x: Could not find an IMS org with the ID *${imsOrgId}*.`);
      return;
    }

    // create a new spacecat org
    spaceCatOrg = await Organization.create({
      name: imsOrgDetails.orgName,
      imsOrgId,
    });
    await spaceCatOrg.save();

    site.setOrganizationId(spaceCatOrg.getId());
    await site.save();
  }
}

async function publishToAdminHlx(filename, outputLocation, log) {
  try {
    const org = 'adobe';
    const site = 'project-elmo-ui-data';
    const ref = 'main';
    const jsonFilename = `${filename.replace(/\.[^/.]+$/, '')}.json`;
    const path = `${outputLocation}/${jsonFilename}`;
    const headers = { Cookie: `auth_token=${process.env.ADMIN_HLX_API_KEY}` };

    const baseUrl = 'https://admin.hlx.page';
    const endpoints = [
      { name: 'preview', url: `${baseUrl}/preview/${org}/${site}/${ref}/${path}` },
      { name: 'live', url: `${baseUrl}/live/${org}/${site}/${ref}/${path}` },
    ];

    for (const [index, endpoint] of endpoints.entries()) {
      log.info(`Publishing Excel report via admin API (${endpoint.name}): ${endpoint.url}`);

      // eslint-disable-next-line no-await-in-loop
      const response = await fetch(endpoint.url, { method: 'POST', headers });

      if (!response.ok) {
        throw new Error(`${endpoint.name} failed: ${response.status} ${response.statusText}`);
      }

      log.info(`Excel report successfully published to ${endpoint.name}`);

      if (index === 0) {
        log.info('Waiting 2 seconds before publishing to live...');
        // eslint-disable-next-line no-await-in-loop,max-statements-per-line
        await new Promise((resolve) => { setTimeout(resolve, 2000); });
      }
    }
  } catch (publishError) {
    log.error(`Failed to publish via admin.hlx.page: ${publishError.message}`);
  }
}

async function copyFilesToSharepoint(dataFolder, lambdaCtx) {
  const { log } = lambdaCtx;

  const SHAREPOINT_URL = 'https://adobe.sharepoint.com/:x:/r/sites/HelixProjects/Shared%20Documents/sites/elmo-ui-data';

  const sharepointClient = await createFrom({
    clientId: process.env.SHAREPOINT_CLIENT_ID,
    clientSecret: process.env.SHAREPOINT_CLIENT_SECRET,
    authority: process.env.SHAREPOINT_AUTHORITY,
    domainId: process.env.SHAREPOINT_DOMAIN_ID,
  }, { url: SHAREPOINT_URL, type: 'onedrive' });

  log.info(`Copying query-index to ${dataFolder}`);
  const doc = await sharepointClient.getDocument('/sites/elmo-ui-data/template/query-index.xlsx');
  await doc.copy(`/sites/elmo-ui-data/${dataFolder}/query-index.xlsx`);

  await publishToAdminHlx('query-index', dataFolder, log);
}

async function onboardSite(input, lambdaCtx, slackCtx) {
  const { log, dataAccess } = lambdaCtx;
  const { say } = slackCtx;
  const { baseURL, brandName, imsOrgId } = input;
  const dataFolder = `${brandName.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()}-content`;

  const { Site, Configuration } = dataAccess;

  try {
    // Find the site
    const site = await Site.findByBaseURL(baseURL);
    if (!site) {
      await say(`:x: Site '${baseURL}' not found. Please add the site first using the regular onboard command.`);
      return;
    }

    // upload and publish the query index file
    await copyFilesToSharepoint(dataFolder, lambdaCtx);

    const siteId = site.getId();
    log.info(`Found site ${baseURL} with ID: ${siteId}`);

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
    configuration.enableHandlerForSite(REFERRAL_TRAFFIC_AUDIT, site);
    configuration.enableHandlerForSite('geo-brand-presence', site);

    // enable the cdn-analysis only if no other site in this organization already has it enabled
    await checkOrg(imsOrgId, site, lambdaCtx, slackCtx);
    const sitesInOrg = await Site.allByOrganizationId(imsOrgId);

    const hasAgenticTrafficEnabled = sitesInOrg.some(
      (orgSite) => configuration.isHandlerEnabledForSite(AGENTIC_TRAFFIC_ANALYSIS_AUDIT, orgSite),
    );

    if (!hasAgenticTrafficEnabled) {
      log.info(`Enabling agentic traffic audits for organization ${imsOrgId} (first site in org)`);
      configuration.enableHandlerForSite(AGENTIC_TRAFFIC_ANALYSIS_AUDIT, site);
    } else {
      log.info(`Agentic traffic audits already enabled for organization ${imsOrgId}, skipping`);
    }

    // enable the cdn-logs-report audits for agentic traffic
    configuration.enableHandlerForSite(AGENTIC_TRAFFIC_REPORT_AUDIT, site);

    try {
      await configuration.save();
      await site.save();
      log.info(`Successfully updated LLMO config for site ${siteId}`);

      await triggerReferralTrafficBackfill(lambdaCtx, configuration, siteId);

      const message = `:white_check_mark: *LLMO onboarding completed successfully!*
        
:link: *Site:* ${baseURL}
:identification_card: *Site ID:* ${siteId}
:file_folder: *Data Folder:* ${dataFolder}
:label: *Brand:* ${brandName}

The site is now ready for LLMO operations. You can access the configuration at the LLMO API endpoints.`;

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

      const brandName = values.brand_name_input.brand_name.value;
      const brandURL = values.brand_url_input.brand_url.value;
      const imsOrgId = values.ims_org_input.ims_org_id.value;

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

      await onboardSite({ brandName, brandURL, imsOrgId }, lambdaContext, slackContext);

      const message = `:white_check_mark: *Onboarding completed successfully by ${user.name}!*

:ims: *IMS Org ID:* ${imsOrgId || 'n/a'}
        `;

      await client.chat.postMessage({
        channel: responseChannel,
        text: message,
        thread_ts: responseThreadTs,
      });

      log.info(`Onboard site modal processed for user ${user.id}, site ${brandURL}`);
    } catch (e) {
      log.error('Error handling onboard site modal:', e);
      await ack({
        response_action: 'errors',
        errors: {
          site_url_input: 'There was an error processing the onboarding request.',
        },
      });
    }
  };
}
