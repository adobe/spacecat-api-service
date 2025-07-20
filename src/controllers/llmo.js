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

import { ok } from '@adobe/spacecat-shared-http-utils';
import { Config } from '@adobe/spacecat-shared-data-access/src/models/site/config.js';

function LlmoController() {
  // TODO: remove the dataFolder from the params and use the site.getLlmoConfig().dataFolder instead
  // Handles requests to the LLMO sheet data endpoint
  const getLlmoSheetData = async (context) => {
    const { siteId, dataFolder, dataSource } = context.params;
    const { log } = context;
    const { env } = context;

    // for the given siteId, get the config
    const site = await context.siteCollection.findBySiteId(siteId);
    const config = site.getConfig();
    const llmoConfig = config.getLlmoConfig();

    // if the dataFolder is not in the llmoConfig, throw an error
    if (!llmoConfig.dataFolder) {
      throw new Error('LLM Optimizer is not enabled for this site, add llmo config to the site');
    }

    // if the dataFolder is not the same as the llmoConfig.dataFolder, throw an error
    if (dataFolder !== llmoConfig.dataFolder) {
      throw new Error('invalid data folder for the site, please use the correct data folder');
    }

    try {
      // Fetch data from the external endpoint
      const response = await fetch(`https://main--project-elmo-ui-data--adobe.aem.live/${dataFolder}/${dataSource}.json`, {
        headers: {
          Authorization: `token ${env.LLMO_HLX_API_KEY || 'hlx_api_key_missing'}`,
          'User-Agent': 'SpaceCat-API-Service/1.0',
        },
      });

      if (!response.ok) {
        log.error(`Failed to fetch data from external endpoint: ${response.status} ${response.statusText}`);
        throw new Error(`External API returned ${response.status}: ${response.statusText}`);
      }

      // Get the response data
      const data = await response.json();

      log.info(`Successfully proxied data for siteId: ${siteId}, dataSource: ${dataSource}`);

      // Return the response as-is
      return ok(data);
    } catch (error) {
      log.error(`Error proxying data for siteId: ${siteId}, dataSource: ${dataSource}`, error);
      throw error;
    }
  };

  // Handles requests to the LLMO config endpoint
  const getLlmoConfig = async (context) => {
    const { siteId } = context.params;

    // for the given siteId, get the config
    const site = await context.siteCollection.findBySiteId(siteId);
    const config = site.getConfig();
    const llmoConfig = config.getLlmoConfig();

    // if the llmoConfig is not enabled, throw an error
    if (!llmoConfig) {
      throw new Error('LLM Optimizer is not enabled for this site, add llmo config to the site');
    }

    return ok(llmoConfig);
  };

  // Handles requests to the LLMO questions endpoint, returns both human and ai questions
  const getLlmoQuestions = async (context) => {
    const { siteId } = context.params;

    // for the given siteId, get the config
    const site = await context.siteCollection.findBySiteId(siteId);
    const config = site.getConfig();
    const llmoConfig = config.getLlmoConfig();

    // if the llmoConfig is not enabled, throw an error
    if (!llmoConfig) {
      throw new Error('LLM Optimizer is not enabled for this site, add llmo config to the site');
    }

    // return the questions, incase there are no questions, return an empty object
    return ok(llmoConfig.questions || {});
  };

  // Handles requests to the LLMO questions endpoint, adds a new question
  // the body format is { Human: [question1, question2], AI: [question3, question4] }
  const addLlmoQuestion = async (context) => {
    const { log } = context;
    const { siteId } = context.params;

    // for the given siteId, get the config
    const site = await context.siteCollection.findBySiteId(siteId);
    const config = site.getConfig();
    const llmoConfig = config.getLlmoConfig();

    // if the llmoConfig is not enabled, throw an error
    if (!llmoConfig) {
      throw new Error('LLM Optimizer is not enabled for this site, add llmo config to the site');
    }

    // add the question to the llmoConfig
    const newQuestions = context.body;
    let updated = false;

    if (newQuestions.Human) {
      newQuestions.Human.forEach((question) => {
        updated = true;
        const uniqueKey = crypto.randomUUID();
        llmoConfig.questions.Human.push({ ...question, key: uniqueKey });
      });
    }
    if (newQuestions.AI) {
      newQuestions.AI.forEach((question) => {
        updated = true;
        const uniqueKey = crypto.randomUUID();
        llmoConfig.questions.AI.push({ ...question, key: uniqueKey });
      });
    }

    if (updated) {
      // update the llmoConfig in the config
      config.updateLlmoConfig(llmoConfig.dataFolder, llmoConfig.brand, llmoConfig.questions);
      site.setConfig(Config.toDynamoItem(config));
      try {
        await site.save();
      } catch (error) {
        log.error(`Error adding new questions for site's llmo config ${site.getId()}: ${error.message}`);
      }
    }

    // return the updated llmoConfig
    return ok(llmoConfig.questions);
  };

  // Handles requests to the LLMO questions endpoint, removes a question
  const removeLlmoQuestion = async (context) => {
    const { log } = context;
    const { siteId, questionKey } = context.params;

    // for the given siteId, get the config
    const site = await context.siteCollection.findBySiteId(siteId);
    const config = site.getConfig();
    const llmoConfig = config.getLlmoConfig();

    // if the llmoConfig is not enabled, throw an error
    if (!llmoConfig) {
      throw new Error('LLM Optimizer is not enabled for this site, add llmo config to the site');
    }

    let updated = false;
    // check if the questionKey is valid
    if (llmoConfig.questions.Human.some((question) => question.key === questionKey)
      || llmoConfig.questions.AI.some((question) => question.key === questionKey)
    ) {
      updated = true;
    } else {
      throw new Error('Invalid question key, please provide a valid question key');
    }

    // remove the question from the llmoConfig
    llmoConfig.questions.Human = llmoConfig.questions.Human.filter(
      (question) => question.key !== questionKey,
    );
    llmoConfig.questions.AI = llmoConfig.questions.AI.filter(
      (question) => question.key !== questionKey,
    );

    // update the llmoConfig in the config
    if (updated) {
      config.updateLlmoConfig(llmoConfig.dataFolder, llmoConfig.brand, llmoConfig.questions);
      site.setConfig(Config.toDynamoItem(config));
      try {
        await site.save();
      } catch (error) {
        log.error(`Error removing question for site's llmo config ${site.getId()}: ${error.message}`);
      }
    }

    // return the updated llmoConfig
    return ok(llmoConfig.questions);
  };

  // Handles requests to the LLMO questions endpoint, updates a question
  const patchLlmoQuestion = async (context) => {
    const { siteId, questionKey } = context.params;
    const { log } = context;
    const { body } = context;

    // for the given siteId, get the config
    const site = await context.siteCollection.findBySiteId(siteId);
    const config = site.getConfig();
    const llmoConfig = config.getLlmoConfig();

    // if the llmoConfig is not enabled, throw an error
    if (!llmoConfig) {
      throw new Error('LLM Optimizer is not enabled for this site, add llmo config to the site');
    }

    let updated = false;
    // check if the questionKey is valid
    if (llmoConfig.questions.Human.some((question) => question.key === questionKey)
      || llmoConfig.questions.AI.some((question) => question.key === questionKey)
    ) {
      updated = true;
    } else {
      throw new Error('Invalid question key, please provide a valid question key');
    }

    // update the question in the llmoConfig
    llmoConfig.questions.Human = llmoConfig.questions.Human.map((question) => {
      if (question.key === questionKey) {
        return { ...question, ...body };
      }
      return question;
    });
    llmoConfig.questions.AI = llmoConfig.questions.AI.map((question) => {
      if (question.key === questionKey) {
        return { ...question, ...body };
      }
      return question;
    });

    // update the llmoConfig in the config
    if (updated) {
      config.updateLlmoConfig(llmoConfig.dataFolder, llmoConfig.brand, llmoConfig.questions);
      site.setConfig(Config.toDynamoItem(config));
      try {
        await site.save();
      } catch (error) {
        log.error(`Error updating question for site's llmo config ${site.getId()}: ${error.message}`);
      }
    }

    // return the updated llmoConfig
    return ok(llmoConfig.questions);
  };

  return {
    getLlmoSheetData,
    getLlmoConfig,
    getLlmoQuestions,
    addLlmoQuestion,
    removeLlmoQuestion,
    patchLlmoQuestion,
  };
}

export default LlmoController;
