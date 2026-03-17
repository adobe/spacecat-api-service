/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import BaseCommand from './base.js';
import identifyRedirectsCommand from './identify-redirects.js';

const PHRASES = ['update-redirects'];

/*
* Act as a wrapper around identify-redirects command to update the site's delivery config.
*/
export default function IdentifyAndUpdateRedirectsCommand(context) {
  const innerContext = { ...context, updateRedirects: true };
  const innerCommand = identifyRedirectsCommand(innerContext);

  const baseCommand = BaseCommand({
    id: 'identify-and-update-redirects',
    name: 'Identify and Update Redirects',
    description: 'Detects common redirect-manager patterns using Splunk logs (AEM CS/CW only) and updates the site\'s delivery config.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {baseURL}`,
  });

  baseCommand.init(context);
  return {
    ...baseCommand,
    handleExecution: innerCommand.handleExecution,
  };
}
