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

import { ok, badRequest } from '@adobe/spacecat-shared-http-utils';
import { SPACECAT_USER_AGENT, tracingFetch as fetch } from '@adobe/spacecat-shared-utils';
import { Config } from '@adobe/spacecat-shared-data-access/src/models/site/config.js';
import crypto from 'crypto';

const LLMO_SHEETDATA_SOURCE_URL = 'https://main--project-elmo-ui-data--adobe.aem.live';

function LlmoController() {
  // Helper function to get site and validate LLMO config
  const getSiteAndValidateLlmo = async (context) => {
    const { siteId } = context.params;
    const { dataAccess } = context;
    const { Site } = dataAccess;

    const site = await Site.findById(siteId);
    const config = site.getConfig();
    const llmoConfig = config.getLlmoConfig();

    if (!llmoConfig?.dataFolder) {
      throw new Error('LLM Optimizer is not enabled for this site, add llmo config to the site');
    }

    return { site, config, llmoConfig };
  };

  // Helper function to save site config with error handling
  const saveSiteConfig = async (site, config, log, operation) => {
    site.setConfig(Config.toDynamoItem(config));
    try {
      await site.save();
    } catch (error) {
      log.error(`Error ${operation} for site's llmo config ${site.getId()}: ${error.message}`);
    }
  };

  // Helper function to validate question key
  const validateQuestionKey = (config, questionKey) => {
    const humanQuestions = config.getLlmoHumanQuestions() || [];
    const aiQuestions = config.getLlmoAIQuestions() || [];

    if (!humanQuestions.some((question) => question.key === questionKey)
        && !aiQuestions.some((question) => question.key === questionKey)) {
      throw new Error('Invalid question key, please provide a valid question key');
    }
  };

  // Handles requests to the LLMO sheet data endpoint
  const getLlmoSheetData = async (context) => {
    const { log } = context;
    const { siteId, dataSource, sheetType } = context.params;
    const { env } = context;

    const { llmoConfig } = await getSiteAndValidateLlmo(context);
    const sheetURL = sheetType ? `${llmoConfig.dataFolder}/${sheetType}/${dataSource}.json` : `${llmoConfig.dataFolder}/${dataSource}.json`;

    try {
      // Fetch data from the external endpoint using the dataFolder from config
      const response = await fetch(`${LLMO_SHEETDATA_SOURCE_URL}/${sheetURL}`, {
        headers: {
          Authorization: `token ${env.LLMO_HLX_API_KEY || 'hlx_api_key_missing'}`,
          'User-Agent': SPACECAT_USER_AGENT,
        },
      });

      if (!response.ok) {
        log.error(`Failed to fetch data from external endpoint: ${response.status} ${response.statusText}`);
        throw new Error(`External API returned ${response.status}: ${response.statusText}`);
      }

      // Get the response data
      const data = await response.json();

      log.info(`Successfully proxied data for siteId: ${siteId}, sheetURL: ${sheetURL}`);

      // Return the response as-is
      return ok(data);
    } catch (error) {
      log.error(`Error proxying data for siteId: ${siteId}, sheetURL: ${sheetURL}`, error);
      throw error;
    }
  };

  // Handles requests to the LLMO config endpoint
  const getLlmoConfig = async (context) => {
    const { llmoConfig } = await getSiteAndValidateLlmo(context);
    return ok(llmoConfig);
  };

  // Handles requests to the LLMO questions endpoint, returns both human and ai questions
  const getLlmoQuestions = async (context) => {
    const { llmoConfig } = await getSiteAndValidateLlmo(context);
    return ok(llmoConfig.questions || {});
  };

  // Handles requests to the LLMO questions endpoint, adds a new question
  // the body format is { Human: [question1, question2], AI: [question3, question4] }
  const addLlmoQuestion = async (context) => {
    const { log } = context;
    const { site, config } = await getSiteAndValidateLlmo(context);

    // add the question to the llmoConfig
    const newQuestions = context.data;
    if (!newQuestions) {
      return badRequest('No questions provided in the request body');
    }
    let updated = false;

    // Prepare human questions with unique keys
    if (newQuestions.Human && newQuestions.Human.length > 0) {
      const humanQuestionsWithKeys = newQuestions.Human.map((question) => ({
        ...question,
        key: crypto.randomUUID(),
      }));
      config.addLlmoHumanQuestions(humanQuestionsWithKeys);
      updated = true;
    }

    // Prepare AI questions with unique keys
    if (newQuestions.AI && newQuestions.AI.length > 0) {
      const aiQuestionsWithKeys = newQuestions.AI.map((question) => ({
        ...question,
        key: crypto.randomUUID(),
      }));
      config.addLlmoAIQuestions(aiQuestionsWithKeys);
      updated = true;
    }

    if (updated) {
      await saveSiteConfig(site, config, log, 'adding new questions');
    }

    // return the updated llmoConfig questions
    return ok(config.getLlmoConfig().questions);
  };

  // Handles requests to the LLMO questions endpoint, removes a question
  const removeLlmoQuestion = async (context) => {
    const { log } = context;
    const { questionKey } = context.params;
    const { site, config } = await getSiteAndValidateLlmo(context);

    validateQuestionKey(config, questionKey);

    // remove the question using the config method
    config.removeLlmoQuestion(questionKey);

    await saveSiteConfig(site, config, log, 'removing question');

    // return the updated llmoConfig questions
    return ok(config.getLlmoConfig().questions);
  };

  // Handles requests to the LLMO questions endpoint, updates a question
  const patchLlmoQuestion = async (context) => {
    const { log } = context;
    const { questionKey } = context.params;
    const { data } = context;
    const { site, config } = await getSiteAndValidateLlmo(context);

    validateQuestionKey(config, questionKey);

    // update the question using the config method
    config.updateLlmoQuestion(questionKey, data);

    await saveSiteConfig(site, config, log, 'updating question');

    // return the updated llmoConfig questions
    return ok(config.getLlmoConfig().questions);
  };

  // Handles requests to get the LLMO customer intent
  const getCustomerIntent = async (context) => {
    const { config } = await getSiteAndValidateLlmo(context);
    const customerIntent = config.getLlmoCustomerIntent();
    return ok(customerIntent || null);
  };

  // Handles requests to add/set the LLMO customer intent
  const addCustomerIntent = async (context) => {
    const { log } = context;
    const { data } = context;
    const { site, config } = await getSiteAndValidateLlmo(context);

    if (!data) {
      return badRequest('No customer intent data provided in the request body');
    }

    // Validate the customer intent schema
    // all fields are optional but must have correct types when provided
    if (data.adobeProduct && typeof data.adobeProduct !== 'string') {
      return badRequest('adobeProduct must be a string');
    }
    if (data.cdnProvider && !Array.isArray(data.cdnProvider)) {
      return badRequest('cdnProvider must be an array');
    }
    if (data.referralProvider && typeof data.referralProvider !== 'string') {
      return badRequest('referralProvider must be a string');
    }

    // Build customer intent object with only provided fields
    const customerIntent = {};
    if (data.adobeProduct !== undefined) {
      customerIntent.adobeProduct = data.adobeProduct;
    }
    if (data.cdnProvider !== undefined) {
      customerIntent.cdnProvider = data.cdnProvider;
    }
    if (data.referralProvider !== undefined) {
      customerIntent.referralProvider = data.referralProvider;
    }

    // set the customer intent using the config method
    config.setLlmoCustomerIntent(customerIntent);

    await saveSiteConfig(site, config, log, 'setting customer intent');

    // return the updated customer intent
    return ok(config.getLlmoCustomerIntent());
  };

  // Handles requests to remove the LLMO customer intent
  const removeCustomerIntent = async (context) => {
    const { log } = context;
    const { site, config } = await getSiteAndValidateLlmo(context);

    // remove the customer intent using the config method
    config.removeLlmoCustomerIntent();

    await saveSiteConfig(site, config, log, 'removing customer intent');

    // return success
    return ok(null);
  };

  // Handles requests to patch/update the LLMO customer intent
  const patchCustomerIntent = async (context) => {
    const { log } = context;
    const { data } = context;
    const { site, config } = await getSiteAndValidateLlmo(context);

    const currentIntent = config.getLlmoCustomerIntent();
    if (!currentIntent) {
      return badRequest('No customer intent exists to patch. Use POST to create one first.');
    }

    // Merge the updates with existing data
    const updatedIntent = {
      ...currentIntent,
      ...data,
    };

    // Validate the merged result
    if (data.adobeProduct && typeof data.adobeProduct !== 'string') {
      return badRequest('adobeProduct must be a string');
    }
    if (data.cdnProvider && !Array.isArray(data.cdnProvider)) {
      return badRequest('cdnProvider must be an array');
    }
    if (data.referralProvider && typeof data.referralProvider !== 'string') {
      return badRequest('referralProvider must be a string');
    }

    // update the customer intent using the config method
    config.updateLlmoCustomerIntent(updatedIntent);

    await saveSiteConfig(site, config, log, 'updating customer intent');

    // return the updated customer intent
    return ok(config.getLlmoCustomerIntent());
  };

  return {
    getLlmoSheetData,
    getLlmoConfig,
    getLlmoQuestions,
    addLlmoQuestion,
    removeLlmoQuestion,
    patchLlmoQuestion,
    getCustomerIntent,
    addCustomerIntent,
    removeCustomerIntent,
    patchCustomerIntent,
  };
}

export default LlmoController;
