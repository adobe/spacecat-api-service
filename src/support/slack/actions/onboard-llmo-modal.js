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

/* c8 ignore start */

import { Config } from '@adobe/spacecat-shared-data-access/src/models/site/config.js';
import { createFrom } from '@adobe/spacecat-helix-content-sdk';
import { getLastNumberOfWeeks } from '@adobe/spacecat-shared-utils';
import { Octokit } from '@octokit/rest';
import {
  postErrorMessage,
} from '../../../utils/slack/base.js';

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
              text: 'ABC123@AdobeOrg (default: AEM Sites Engineering)',
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
          optional: true,
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
              text: 'ABC123@AdobeOrg (default: AEM Sites Engineering)',
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
    log.info(`IMS Org Details: ${imsOrgDetails}`);
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
        log.info(`User ${user.id} started full onboarding process for ${brandURL}.`);
        return;
      }

      const config = await site.getConfig();
      const brand = config.getLlmoBrand();

      if (brand) {
        await respond({
          text: `:cdbot-error: It looks like ${brandURL} is already configured for LLMO with brand ${brand}`,
          replace_original: true,
        });
        log.info(`Aborted ${brandURL} onboarding: Already onboarded with brand ${brand}`);
        return;
      }

      await elmoOnboardingModal(body, client, respond, brandURL);

      log.info(`User ${user.id} started LLMO onboarding process for ${brandURL} with existing site ${site.getId()}.`);
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
  const folder = sharepointClient.getDocument(`/sites/elmo-ui-data/${dataFolder}/`);
  const queryIndex = sharepointClient.getDocument('/sites/elmo-ui-data/template/query-index.xlsx');

  await folder.createFolder(dataFolder, '/');
  await queryIndex.copy(`/${dataFolder}/query-index.xlsx`);

  await publishToAdminHlx('query-index', dataFolder, log);
}

// update https://github.com/adobe/project-elmo-ui-data/blob/main/helix-query.yaml
async function updateIndexConfig(dataFolder, lambdaCtx) {
  const { log } = lambdaCtx;

  log.info('Starting Git modification of helix query config');

  const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN,
  });

  const owner = 'hannessolo'; // TODO change to adobe instead of fork
  const repo = 'project-elmo-ui-data';
  const ref = 'main';
  const path = 'helix-query.yaml';

  const { data: file } = await octokit.repos.getContent({
    owner, repo, ref, path,
  });
  const content = Buffer.from(file.content, 'base64').toString('utf-8');

  // add new config to end of file
  const modifiedContent = `${content}${content.endsWith('\n') ? '' : '\n'}
  ${dataFolder}:
    <<: *default
    include:
      - '/${dataFolder}/**'
    target: /${dataFolder}/query-index.xlsx
`;

  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    ref,
    path,
    message: `Automation: Onboard ${dataFolder}`,
    content: Buffer.from(modifiedContent).toString('base64'),
    sha: file.sha,
  });

  log.info('Done with Git modification of helix query config');
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
    const newOrg = createOrg(imsOrgId, lambda, slackContext);
    orgId = newOrg.getId();
  }

  const site = await Site.create({
    baseURL, deliveryType, organizationId: orgId,
  });
  site.save();
  return site.getId();
}

export async function onboardSite(input, lambdaCtx, slackCtx) {
  const { log, dataAccess } = lambdaCtx;
  const { say } = slackCtx;
  const {
    baseURL, brandName, imsOrgId,
  } = input;
  const { hostname } = new URL(baseURL);
  const dataFolder = hostname.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();

  const { Site, Configuration } = dataAccess;

  say(`:gear: ${brandName} onboarding started...`);

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

    // upload and publish the query index file
    await copyFilesToSharepoint(dataFolder, lambdaCtx);

    // update indexing config in helix
    await updateIndexConfig(dataFolder, lambdaCtx);

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
    const orgId = site.getOrganizationId();
    const sitesInOrg = await Site.allByOrganizationId(orgId);

    const hasAgenticTrafficEnabled = sitesInOrg.some(
      (orgSite) => configuration.isHandlerEnabledForSite(AGENTIC_TRAFFIC_ANALYSIS_AUDIT, orgSite),
    );

    if (!hasAgenticTrafficEnabled) {
      log.info(`Enabling agentic traffic audits for organization ${orgId} (first site in org)`);
      configuration.enableHandlerForSite(AGENTIC_TRAFFIC_ANALYSIS_AUDIT, site);
    } else {
      log.info(`Agentic traffic audits already enabled for organization ${orgId}, skipping`);
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

      log.info('Onboard site modal starting to process...');

      // Extract original channel and thread context from private metadata
      let originalChannel;
      let originalThreadTs;
      let brandURL;
      try {
        const metadata = JSON.parse(view.private_metadata || '{}');
        originalChannel = metadata.originalChannel;
        originalThreadTs = metadata.originalThreadTs;
        brandURL = metadata.brandURL;
      } catch (error) {
        log.warn('Failed to parse private metadata:', error);
      }

      const brandName = values.brand_name_input.brand_name.value;
      const imsOrgId = values.ims_org_input.ims_org_id.value;
      const deliveryType = values.delivery_type_input.delivery_type.selected_option?.value;

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
        brandName, brandURL, imsOrgId, deliveryType,
      }, lambdaContext, slackContext);

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

/* c8 ignore stop */
