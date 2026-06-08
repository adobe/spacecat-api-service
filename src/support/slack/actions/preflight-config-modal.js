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

import { hasText, isValidUrl } from '@adobe/spacecat-shared-utils';
import { extractDeliveryConfigFromPreviewUrl } from './onboard-modal.js';
import {
  enablePreflightAuditForSite,
  extractHelixConfigFromPreviewUrl,
  isContentSourcePathRequired,
  isCSAuthoringType,
} from '../preflight/preflight-config.js';

/**
 * Handles preflight configuration modal submission
 */
export function preflightConfigModal(lambdaContext) {
  const { dataAccess, log } = lambdaContext;
  const { Site } = dataAccess;

  return async ({ ack, body, client }) => {
    try {
      let metadata = {};
      try {
        metadata = JSON.parse(body.view.private_metadata);
      } catch (error) {
        log.warn('Failed to parse private metadata:', error);
      }

      const {
        siteId, auditType, channelId, threadTs,
      } = metadata;

      const { values } = body.view.state;

      const authoringType = values.authoring_type_input?.authoring_type?.selected_option?.value;
      const previewUrl = values.preview_url_input?.preview_url?.value?.trim();
      const contentSourcePath = values.content_source_path_input?.content_source_path?.value
        ?.trim();

      if (!authoringType) {
        await ack({
          response_action: 'errors',
          errors: {
            authoring_type_input: 'Authoring type is required.',
          },
        });
        return;
      }

      if (!previewUrl) {
        await ack({
          response_action: 'errors',
          errors: {
            preview_url_input: 'Preview URL is required.',
          },
        });
        return;
      }

      let deliveryConfigFromPreview = null;
      let helixConfigFromPreview = null;
      let amsAuthorUrl;

      if (isCSAuthoringType(authoringType)) {
        deliveryConfigFromPreview = extractDeliveryConfigFromPreviewUrl(previewUrl, null);
        if (!deliveryConfigFromPreview) {
          await ack({
            response_action: 'errors',
            errors: {
              preview_url_input: 'Could not extract program/environment ID from this URL. Please provide a valid AEM CS preview URL (e.g., https://author-p12345-e67890.adobeaemcloud.com).',
            },
          });
          return;
        }
      } else if (authoringType === 'documentauthoring') {
        helixConfigFromPreview = extractHelixConfigFromPreviewUrl(previewUrl);
        if (!helixConfigFromPreview) {
          await ack({
            response_action: 'errors',
            errors: {
              preview_url_input: 'Could not extract RSO information from this URL. Please provide a valid Helix preview URL (e.g., https://main--site--owner.hlx.live).',
            },
          });
          return;
        }
      } else if (authoringType === 'ams') {
        if (!isValidUrl(previewUrl)) {
          await ack({
            response_action: 'errors',
            errors: {
              preview_url_input:
                'Please provide a valid AMS author URL.',
            },
          });
          return;
        }

        amsAuthorUrl = previewUrl;
      } else {
        await ack({
          response_action: 'errors',
          errors: {
            authoring_type_input: 'Unsupported authoring type for preflight audit.',
          },
        });
        return;
      }

      const site = await Site.findById(siteId);
      if (!site) {
        await ack();
        await client.chat.postMessage({
          channel: channelId,
          text: ':x: Error: Site not found. Please try again.',
          thread_ts: threadTs,
        });
        return;
      }

      if (deliveryConfigFromPreview) {
        const contentSourcePathRequired = await isContentSourcePathRequired(
          dataAccess,
          site,
          deliveryConfigFromPreview.programId,
          deliveryConfigFromPreview.environmentId,
          authoringType,
          log,
        );

        if (contentSourcePathRequired && !hasText(contentSourcePath)) {
          await ack({
            response_action: 'errors',
            errors: {
              content_source_path_input: 'Content source path is required when multiple sites in this organization share the same AEM CS program and environment.',
            },
          });
          return;
        }
      }

      await ack();

      site.setAuthoringType(authoringType);

      let configDetails = '';
      if (deliveryConfigFromPreview) {
        const deliveryConfig = {
          ...deliveryConfigFromPreview,
        };
        if (hasText(contentSourcePath)) {
          deliveryConfig.contentSourcePath = contentSourcePath;
        }
        site.setDeliveryConfig(deliveryConfig);
        configDetails = `:gear: *Delivery Config:* Program ${deliveryConfigFromPreview.programId}, Environment ${deliveryConfigFromPreview.environmentId}\n`
                       + `:link: *Preview URL:* ${previewUrl}`;
        if (hasText(contentSourcePath)) {
          configDetails += `\n:file_folder: *Content Source Path:* ${contentSourcePath}`;
        }
      } else if (helixConfigFromPreview) {
        site.setHlxConfig(helixConfigFromPreview);
        configDetails = `:gear: *Helix Config:* ${helixConfigFromPreview.rso.ref}--${helixConfigFromPreview.rso.site}--${helixConfigFromPreview.rso.owner}.${helixConfigFromPreview.rso.tld}\n`
                       + `:link: *Preview URL:* ${previewUrl}`;
      } else if (amsAuthorUrl) {
        site.setDeliveryConfig({
          authorURL: amsAuthorUrl,
        });
        configDetails = `:gear: *Authoring URL:* ${amsAuthorUrl}`;
      }

      await site.save();
      await enablePreflightAuditForSite(site, dataAccess);

      await client.chat.postMessage({
        channel: channelId,
        text: `:white_check_mark: Successfully configured and enabled ${auditType} audit for \`${site.getBaseURL()}\`\n`
              + `:writing_hand: *Authoring Type:* ${authoringType}\n${
                configDetails}`,
        thread_ts: threadTs,
      });
    } catch (error) {
      log.error('Error handling preflight config modal:', error);
      await ack({
        response_action: 'errors',
        errors: {
          authoring_type_input: 'There was an error processing the configuration. Please try again.',
        },
      });
    }
  };
}
