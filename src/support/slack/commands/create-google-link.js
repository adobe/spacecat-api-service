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

import { hasText } from '@adobe/spacecat-shared-utils';
import BaseCommand from './base.js';
import {
  extractURLFromSlackInput,
  postErrorMessage,
  postSiteNotFoundMessage,
} from '../../../utils/slack/base.js';

const PHRASES = ['get google auth link'];

/**
 * Creates a Google authentication link for the specified site.
 * @param context
 * @returns {CreateGoogleLinkCommand}
 * @constructor
 */
function CreateGoogleLinkCommand(context) {
  const baseCommand = BaseCommand({
    id: 'create-google-link',
    name: 'Create Google Authentication Link',
    description: 'Creates a Google authentication link for the specified site.'
    + '\n This link can be sent to a customer to obtain Google Search Console API access.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {baseURL}`,
  });

  const { dataAccess, log } = context;
  const { Site } = dataAccess;

  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;

    try {
      const [baseURLInput] = args;
      const baseURL = extractURLFromSlackInput(baseURLInput);
      if (!hasText(baseURL)) {
        await say(baseCommand.usage());
        return;
      }

      const site = await Site.findByBaseURL(baseURL);
      if (!site) {
        await postSiteNotFoundMessage(say, baseURL);
        return;
      }

      const siteId = site.getId();
      const funcVersion = context.func?.version;
      const isDev = /^ci\d*$/i.test(funcVersion);
      const message = `https://spacecat.experiencecloud.live/api/${isDev ? 'ci' : 'v1'}/auth/google/${siteId}`;
      await say(message);
    } catch (error) {
      log.error(error);
      await postErrorMessage(say, error);
    }
  };

  baseCommand.init(context);

  return {
    ...baseCommand,
    handleExecution,
  };
}

export default CreateGoogleLinkCommand;
