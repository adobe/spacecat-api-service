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

import { Site as SiteModel, Organization as OrganizationModel } from '@adobe/spacecat-shared-data-access';
import { Config } from '@adobe/spacecat-shared-data-access/src/models/site/config.js';
import {
  isValidUrl, isObject, resolveCanonicalUrl,
} from '@adobe/spacecat-shared-utils';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';

import { findDeliveryType, triggerImportRun, triggerAuditForSite } from '../../utils.js';
import { loadProfileConfig } from '../../../utils/slack/base.js';

/**
 * Extracts program and environment ID from AEM Cloud Service preview URLs.
 * @param {string} previewUrl - The preview URL to parse
 * @returns {Object|null} Object with programId and environmentId, or null if not extractable
 */
function extractDeliveryConfigFromPreviewUrl(previewUrl) {
  try {
    const url = new URL(previewUrl);
    const { hostname } = url;

    // Pattern for AEM Cloud Service URLs
    const aemcsPattern = /(?:(?:author|publish|preview)-)?p(\d+)-e(\d+)\.(?:live\.)?adobeaemcloud\.com$/i;
    const match = hostname.match(aemcsPattern);

    if (match) {
      const [, programId, environmentId] = match;
      return {
        programId,
        environmentId,
        authorURL: previewUrl,
      };
    }

    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Checks if a site is in the LA_CUSTOMERS list and returns appropriate response if it is.
 */
const checkLACustomerRestriction = async (
  baseURL,
  imsOrgID,
  profileName,
  slackContext,
  env,
  log,
) => {
  const { say } = slackContext;

  if (env.LA_CUSTOMERS) {
    const laCustomers = env.LA_CUSTOMERS.split(',').map((url) => url.trim());
    const isLACustomer = laCustomers.some(
      (url) => baseURL.toLowerCase().endsWith(url.toLowerCase()),
    );

    if (isLACustomer) {
      const message = `:warning: Cannot onboard site ${baseURL} - it's already onboarded and live!`;
      log.warn(message);
      await say(message);
      return {
        site: baseURL,
        imsOrgId: imsOrgID,
        profile: profileName,
        errors: 'Site is a Live customer',
        status: 'Failed',
        existingSite: 'Yes',
      };
    }
  }

  return null;
};

/**
 * Onboards a single site from modal input.
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
  const { say } = slackContext;
  const {
    dataAccess, log, imsClient, env,
  } = context;
  const { Site, Organization } = dataAccess;
  const sfnClient = new SFNClient();

  const baseURL = baseURLInput.trim();
  const imsOrgID = imsOrganizationID || env.DEMO_IMS_ORG;

  // Check if site is in LA_CUSTOMERS list
  const laCustomerCheck = await checkLACustomerRestriction(
    baseURL,
    imsOrgID,
    profileName,
    slackContext,
    env,
    log,
  );
  if (laCustomerCheck) {
    return laCustomerCheck;
  }

  log.info(`Starting ${profileName} environment setup for site ${baseURL}`);
  await say(`:gear: Starting ${profileName} environment setup for site ${baseURL}`);
  await say(':key: Please make sure you have access to the AEM Shared Production Demo environment. Request access here: https://demo.adobe.com/demos/internal/AemSharedProdEnv.html');

  const reportLine = {
    site: baseURL,
    imsOrgId: imsOrgID,
    spacecatOrgId: '',
    siteId: '',
    profile: profileName,
    deliveryType: '',
    authoringType: additionalParams.authoringType || '',
    imports: '',
    audits: '',
    errors: '',
    status: 'Success',
    existingSite: 'No',
  };

  try {
    if (!isValidUrl(baseURL)) {
      reportLine.errors = 'Invalid site base URL';
      reportLine.status = 'Failed';
      return reportLine;
    }

    if (!OrganizationModel.IMS_ORG_ID_REGEX.test(imsOrgID)) {
      reportLine.errors = 'Invalid IMS Org ID';
      reportLine.status = 'Failed';
      return reportLine;
    }

    // check if the organization with IMS Org ID already exists; create if it doesn't
    let organization = await Organization.findByImsOrgId(imsOrgID);
    if (!organization) {
      let imsOrgDetails;
      try {
        imsOrgDetails = await imsClient.getImsOrganizationDetails(imsOrgID);
        log.info(`IMS Org Details: ${imsOrgDetails}`);
      } catch (error) {
        log.error(`Error retrieving IMS Org details: ${error.message}`);
        reportLine.errors = `Error retrieving IMS org with the ID *${imsOrgID}*.`;
        reportLine.status = 'Failed';
        return reportLine;
      }

      if (!imsOrgDetails) {
        reportLine.errors = `Could not find details of IMS org with the ID *${imsOrgID}*.`;
        reportLine.status = 'Failed';
        return reportLine;
      }

      organization = await Organization.create({
        name: imsOrgDetails.orgName,
        imsOrgId: imsOrgID,
      });

      const message = `:white_check_mark: A new organization has been created. Organization ID: ${organization.getId()} Organization name: ${organization.getName()} IMS Org ID: ${imsOrgID}.`;
      await say(message);
      log.info(message);
    }

    const organizationId = organization.getId();
    log.info(`Organization ${organizationId} was successfully retrieved or created`);
    reportLine.spacecatOrgId = organizationId;

    let site = await Site.findByBaseURL(baseURL);
    if (site) {
      reportLine.existingSite = 'Yes';
      reportLine.deliveryType = site.getDeliveryType();
      log.info(`Site ${baseURL} already exists. Site ID: ${site.getId()}, Delivery Type: ${reportLine.deliveryType}`);

      const siteOrgId = site.getOrganizationId();
      if (siteOrgId !== organizationId) {
        log.info(`:warning: :alert: Site ${baseURL} organization ID mismatch. Run below slack command to update site organization to ${organizationId}`);
        log.info(`:fire: @spacecat set imsorg ${baseURL} ${organizationId}`);
      }
    } else {
      log.info(`Site ${baseURL} doesn't exist. Finding delivery type...`);

      // Use forced delivery type if provided, otherwise detect it
      let deliveryType;
      if (additionalParams.deliveryType
        && Object.values(SiteModel.DELIVERY_TYPES).includes(additionalParams.deliveryType)) {
        deliveryType = additionalParams.deliveryType;
        log.info(`Using forced delivery type for site ${baseURL}: ${deliveryType}`);
      } else {
        deliveryType = await findDeliveryType(baseURL);
        log.info(`Found delivery type for site ${baseURL}: ${deliveryType}`);
      }

      reportLine.deliveryType = deliveryType;
      const isLive = deliveryType === SiteModel.DELIVERY_TYPES.AEM_EDGE;

      const siteCreateParams = {
        baseURL,
        deliveryType,
        isLive,
        organizationId,
      };

      // Add authoring type if provided
      if (additionalParams.authoringType
        && Object.values(SiteModel.AUTHORING_TYPES || {})
          .includes(additionalParams.authoringType)) {
        siteCreateParams.authoringType = additionalParams.authoringType;
        log.info(`Setting authoring type for site ${baseURL}: ${additionalParams.authoringType}`);
      }

      try {
        site = await Site.create(siteCreateParams);
      } catch (error) {
        log.error(`Error creating site: ${error.message}`);
        reportLine.errors = error.message;
        reportLine.status = 'Failed';
        return reportLine;
      }
    }

    const siteID = site.getId();
    log.info(`Site ${baseURL} was successfully retrieved or created. Site ID: ${siteID}`);
    reportLine.siteId = siteID;

    const profile = await loadProfileConfig(profileName);
    log.info(`Profile ${profileName} was successfully loaded`);

    if (!isObject(profile)) {
      const error = `Profile "${profileName}" not found or invalid.`;
      log.error(error);
      reportLine.errors = error;
      reportLine.status = 'Failed';
      return reportLine;
    }

    if (!isObject(profile?.audits)) {
      const error = `Profile "${profileName}" does not have a valid audits section.`;
      log.error(error);
      reportLine.errors = error;
      reportLine.status = 'Failed';
      return reportLine;
    }

    if (!isObject(profile?.imports)) {
      const error = `Profile "${profileName}" does not have a valid imports section.`;
      log.error(error);
      reportLine.errors = error;
      reportLine.status = 'Failed';
      return reportLine;
    }

    const importTypes = Object.keys(profile.imports);
    reportLine.imports = importTypes.join(', ');
    const siteConfig = site.getConfig();
    for (const importType of importTypes) {
      siteConfig.enableImport(importType);
    }

    log.info(`Enabled the following imports for ${siteID}: ${reportLine.imports}`);

    // Resolve canonical URL for the site from the base URL
    const resolvedUrl = await resolveCanonicalUrl(baseURL);
    const { pathname: baseUrlPathName } = new URL(baseURL);
    const { pathname: resolvedUrlPathName, origin: resolvedUrlOrigin } = new URL(resolvedUrl);

    log.info(`Base url: ${baseURL} -> Resolved url: ${resolvedUrl} for site ${siteID}`);

    // Update the fetch configuration only if the pathname is different from the resolved URL
    if (baseUrlPathName !== resolvedUrlPathName) {
      siteConfig.updateFetchConfig({
        overrideBaseURL: resolvedUrlOrigin,
      });
    }

    site.setConfig(Config.toDynamoItem(siteConfig));
    try {
      await site.save();
    } catch (error) {
      log.error(error);
      reportLine.errors = error.message;
      reportLine.status = 'Failed';
      return reportLine;
    }

    log.info(`Site config successfully saved for site ${siteID}`);

    for (const importType of importTypes) {
      /* eslint-disable no-await-in-loop */
      await triggerImportRun(
        configuration,
        importType,
        siteID,
        profile.imports[importType].startDate,
        profile.imports[importType].endDate,
        slackContext,
        context,
      );
    }

    log.info(`Triggered the following imports for site ${siteID}: ${reportLine.imports}`);

    const auditTypes = Object.keys(profile.audits);

    auditTypes.forEach((auditType) => {
      configuration.enableHandlerForSite(auditType, site);
    });

    reportLine.audits = auditTypes.join(', ');
    log.info(`Enabled the following audits for site ${siteID}: ${reportLine.audits}`);

    await say(`:white_check_mark: *Enabled imports*: ${reportLine.imports} *and audits*: ${reportLine.audits}`);

    // trigger audit runs
    log.info(`Starting audits for site ${baseURL}. Audit list: ${auditTypes}`);
    await say(`:gear: Starting audits: ${auditTypes}`);
    for (const auditType of auditTypes) {
      /* eslint-disable no-await-in-loop */
      if (!configuration.isHandlerEnabledForSite(auditType, site)) {
        await say(`:x: Will not audit site '${baseURL}' because audits of type '${auditType}' are disabled for this site.`);
      } else {
        await triggerAuditForSite(
          site,
          auditType,
          slackContext,
          context,
        );
      }
    }

    // Opportunity status job
    const opportunityStatusJob = {
      type: 'opportunity-status-processor',
      siteId: siteID,
      siteUrl: baseURL,
      imsOrgId: imsOrgID,
      organizationId,
      taskContext: {
        auditTypes,
        slackContext: {
          channelId: slackContext.channelId,
          threadTs: slackContext.threadTs,
        },
      },
    };

    // Disable imports and audits job
    const disableImportAndAuditJob = {
      type: 'disable-import-audit-processor',
      siteId: siteID,
      siteUrl: baseURL,
      imsOrgId: imsOrgID,
      organizationId,
      taskContext: {
        importTypes,
        auditTypes,
        slackContext: {
          channelId: slackContext.channelId,
          threadTs: slackContext.threadTs,
        },
      },
    };

    // Demo URL job
    const demoURLJob = {
      type: 'demo-url-processor',
      siteId: siteID,
      siteUrl: baseURL,
      imsOrgId: imsOrgID,
      organizationId,
      taskContext: {
        experienceUrl: env.EXPERIENCE_URL || 'https://experience.adobe.com',
        slackContext: {
          channelId: slackContext.channelId,
          threadTs: slackContext.threadTs,
        },
      },
    };

    log.info(`Opportunity status job: ${JSON.stringify(opportunityStatusJob)}`);
    log.info(`Disable import and audit job: ${JSON.stringify(disableImportAndAuditJob)}`);
    log.info(`Demo URL job: ${JSON.stringify(demoURLJob)}`);

    // Prepare and start step function workflow with the necessary parameters
    const workflowInput = {
      opportunityStatusJob,
      disableImportAndAuditJob,
      demoURLJob,
      workflowWaitTime: workflowWaitTime || env.WORKFLOW_WAIT_TIME_IN_SECONDS,
    };

    const workflowName = `onboard-${baseURL.replace(/[^a-zA-Z0-9]/g, '-')}-${Date.now()}`;

    const startCommand = new StartExecutionCommand({
      stateMachineArn: env.ONBOARD_WORKFLOW_STATE_MACHINE_ARN,
      input: JSON.stringify(workflowInput),
      name: workflowName,
    });
    await sfnClient.send(startCommand);
  } catch (error) {
    log.error(error);
    reportLine.errors = error.message;
    reportLine.status = 'Failed';
    throw error;
  }

  return reportLine;
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

      // Update the original message to show user's choice
      await respond({
        text: `:gear: ${user.name} started the onboarding process...`,
        replace_original: true,
      });

      // Open the onboarding modal
      await client.views.open({
        trigger_id: body.trigger_id,
        view: {
          type: 'modal',
          callback_id: 'onboard_site_modal',
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
            {
              type: 'input',
              block_id: 'ims_org_input',
              element: {
                type: 'plain_text_input',
                action_id: 'ims_org_id',
                placeholder: {
                  type: 'plain_text',
                  text: 'ABC123@AdobeOrg (optional)',
                },
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
                  text: 'Select profile',
                },
                initial_option: {
                  text: {
                    type: 'plain_text',
                    text: 'Default',
                  },
                  value: 'default',
                },
                options: [
                  {
                    text: {
                      type: 'plain_text',
                      text: 'Default',
                    },
                    value: 'default',
                  },
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
                      text: 'Summit',
                    },
                    value: 'summit',
                  },
                  {
                    text: {
                      type: 'plain_text',
                      text: 'Summit – Lower Quality',
                    },
                    value: 'summit-lower-quality',
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
                      text: 'AEM Cloud Service',
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
                  text: 'Select authoring type (optional)',
                },
                options: [
                  {
                    text: {
                      type: 'plain_text',
                      text: 'Document Authoring',
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
                      text: 'Crosswalk',
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
                text: '*Preview Environment Configuration* _(Optional)_\nConfigure preview environment for preflight and auto-fix.',
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

      log.info(`User ${user.id} started onboarding process`);
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

      const siteUrl = values.site_url_input.site_url.value;
      const imsOrgId = values.ims_org_input.ims_org_id.value || env.DEMO_IMS_ORG;
      const profile = values.profile_input.profile.selected_option?.value || 'demo';
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
      }

      await ack();

      // Create a slack context for the onboarding process
      const slackContext = {
        say: async (message) => {
          await client.chat.postMessage({
            channel: body.user.id, // Send as DM
            text: message,
          });
        },
        client,
        channelId: body.user.id,
        threadTs: undefined,
      };

      const configuration = await Configuration.findLatest();

      const additionalParams = {};
      if (deliveryType && deliveryType !== 'auto') {
        additionalParams.deliveryType = deliveryType;
      }
      if (authoringType && authoringType !== 'default') {
        additionalParams.authoringType = authoringType;
      }

      const parsedWaitTime = waitTime ? parseInt(waitTime, 10) : undefined;

      await client.chat.postMessage({
        channel: body.user.id,
        text: `:gear: Starting onboarding for site ${siteUrl}...`,
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

      await configuration.save();

      // Apply preview configuration if provided
      if (deliveryConfigFromPreview && reportLine.siteId) {
        const site = await Site.findById(reportLine.siteId);
        if (site) {
          const currentDeliveryConfig = site.getDeliveryConfig() || {};
          const updatedDeliveryConfig = {
            ...currentDeliveryConfig,
            ...deliveryConfigFromPreview,
          };
          site.setDeliveryConfig(updatedDeliveryConfig);

          // Update authoring type if crosswalk was selected
          if (authoringType === 'crosswalk') {
            site.setAuthoringType('crosswalk');
          }

          await site.save();
          log.info(`Applied preview configuration for site ${reportLine.siteId}:`, { deliveryConfig: deliveryConfigFromPreview, authoringType });
        }
      }

      if (reportLine.errors) {
        await client.chat.postMessage({
          channel: body.user.id,
          text: `:warning: ${reportLine.errors}`,
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

        const message = `
:white_check_mark: *Onboarding completed successfully by ${user.name}!*

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
          channel: body.user.id,
          text: message,
        });
      }

      log.info(`Onboard site modal processed for user ${user.id}, site ${siteUrl}`);
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
