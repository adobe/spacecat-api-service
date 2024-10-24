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
import BaseCommand from './base.js';

const PHRASES = ['check-configuration-version'];

export default (context) => {
  const baseCommand = BaseCommand({
    id: 'sites-audits--enable-audit',
    name: 'Audit enabling test command',
    description: '',
    phrases: PHRASES,
    usageText: `${PHRASES[0]}`,
  });

  const { dataAccess } = context;

  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;

    const latestConfiguration = await dataAccess.getConfiguration();
    const specificVersionConfiguration = await dataAccess.getConfigurationByVersion('v10');

    await say(`Latest Configuration Version: ${latestConfiguration.getVersion()}, \n\n but we have : ${specificVersionConfiguration.getVersion()}`);
  };

  baseCommand.init(context);

  return {
    ...baseCommand,
    handleExecution,
  };
};
