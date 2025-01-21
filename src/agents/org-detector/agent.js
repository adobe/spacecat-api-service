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
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { AzureChatOpenAI } from '@langchain/openai';
import {
  StateGraph,
  MemorySaver,
  Annotation,
  messagesStateReducer,
  START,
  END,
} from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { ConsoleCallbackHandler } from '@langchain/core/tracers/console';
import { isObject } from '@adobe/spacecat-shared-utils';

import { retrieveFooter } from './tools/footer-retriever.js';
import { matchCompanies } from './tools/company-matcher.js';
import { getGithubOrgName } from './tools/github-org-retriever.js';
import { retrieveMainContent } from './tools/main-content-retriever.js';
import { extractLinks } from './tools/link-extractor.js';
import { getInstructions } from './instructions.js';

/**
 * Tool #1: Footer Retriever
 * Returns html content of the <footer> element:
 */
const footerRetrieverTool = (apiKey, apiUrl, log) => tool(
  async ({ domain }) => {
    const footerText = await retrieveFooter(domain, apiKey, apiUrl, log);
    return footerText || '';
  },
  {
    name: 'footer_retriever',
    description:
      "Use this to retrieve footer text from a website's domain. Input is { domain: string }",
    schema: z.object({
      domain: z.string().describe('The domain we want to retrieve the footer from'),
    }),
  },
);

/**
 * Tool #2: Company Matcher
 * Matches potential company names in text and returns an array of recognized matches
 * Returns JSON array of objects:
 * [
 *   {
 *     "id": string,
 *     "name": string,
 *     "imsOrgId": string
 *   },
 *   ...
 * ]
 */
const companyMatcherTool = (dataAccess) => tool(
  async ({ text }) => {
    const matches = await matchCompanies(dataAccess, text);
    return JSON.stringify(matches);
  },
  {
    name: 'company_matcher',
    description:
      'Given text that might contain a company name, return an array of recognized matches. Each item has {id, name, imsOrgId}.',
    schema: z.object({
      text: z.string().describe('Text to search for recognized company name objects'),
    }),
  },
);

/**
 * Tool #3: GitHub Org Name Retriever
 * Retrieves the GitHub organization name for a given login
 */
const githubOrgNameRetrieverTool = (ignoredGithubOrgs, log) => tool(
  async ({ githubLogin }) => {
    const orgName = await getGithubOrgName(githubLogin, ignoredGithubOrgs, log);
    return orgName || '';
  },
  {
    name: 'github_org_name_retriever',
    description:
      'Use this to retrieve the GitHub organization name given its login. Input is { githubLogin: string }.',
    schema: z.object({
      githubLogin: z.string().describe('GitHub org login'),
    }),
  },
);

/**
 * Tool #4: Main Content Retriever
 * Retrieves the text content found in the `<main>` element of a webpage given its URL
 */
const mainContentRetrieverTool = (apiKey, apiUrl, log) => tool(
  async ({ url }) => {
    const mainContent = await retrieveMainContent(url, apiKey, apiUrl, log);
    return mainContent || '';
  },
  {
    name: 'main_content_retriever',
    description:
      'Given a URL, returns the text content found in the <main> element of that page. Input is { url: string }',
    schema: z.object({
      url: z.string(),
    }),
  },
);

/**
 * Tool #5: Link extractor
 * Extracts all links from raw HTML and converts them to absolute URLs
 */
const linkExtractorTool = (log) => tool(
  async ({ html, domain }) => {
    const links = await extractLinks(html, domain, log);
    // Return as a JSON array string
    return JSON.stringify(links);
  },
  {
    name: 'link_extractor',
    description:
      'Given raw HTML and a domain, extracts <a> links as absolute URLs in a JSON array. Input is { html: string, domain: string }',
    schema: z.object({
      html: z.string(),
      domain: z.string(),
    }),
  },
);

export default class OrgDetectorAgent {
  /**
   * Creates an instance of OrgDetectorAgent from a Helix Universal context object.
   * @param {UniversalContext} context - The context of the universal serverless function.
   * @returns {OrgDetectorAgent} A new OrgDetectorAgent instance.
   */
  static fromContext(context) {
    if (context.orgDetectorAgent) return context.orgDetectorAgent;

    const {
      dataAccess,
      env,
      log,
    } = context;

    return new OrgDetectorAgent(dataAccess, env, log);
  }

  /**
   * Constructs an OrgDetectorAgent.
   *
   * @param {object} dataAccess - Spacecat DataAccess object, providing access to data layer.
   * @param {object} env - Environment variables required for configuration.
   * @param {string} env.USER_API_KEY - API key for Spacecat user authentication.
   * @param {string} env.SPACECAT_API_BASE_URL - Base URL for the Spacecat API.
   * @param {string} env.AZURE_OPEN_AI_API_KEY - Azure OpenAI API key.
   * @param {string} env.AZURE_OPEN_AI_API_INSTANCE_NAME - Azure OpenAI API instance name.
   * @param {string} env.AZURE_OPEN_AI_API_DEPLOYMENT_NAME - Azure OpenAI API deployment name.
   * @param {function} log - Logging function to record application activity.
   */
  constructor(dataAccess, env, log) {
    const {
      USER_API_KEY: spacecatApiKey,
      SPACECAT_API_BASE_URL: spacecatApiBaseUrl,
      AZURE_OPEN_AI_API_KEY: azureOpenAIApiKey,
      AZURE_OPEN_AI_API_INSTANCE_NAME: azureOpenAIApiInstanceName,
      AZURE_OPEN_AI_API_DEPLOYMENT_NAME: azureOpenAIApiDeploymentName,
      IGNORED_GITHUB_ORGS: ignoredGithubOrgsRaw,
    } = env;

    this.log = log;

    const ignoredGithubOrgs = ignoredGithubOrgsRaw.split(',').map((i) => i.trim());

    // gather the tools
    const tools = [
      footerRetrieverTool(spacecatApiKey, spacecatApiBaseUrl, this.log),
      companyMatcherTool(dataAccess),
      githubOrgNameRetrieverTool(ignoredGithubOrgs, this.log),
      mainContentRetrieverTool(spacecatApiKey, spacecatApiBaseUrl, this.log),
      linkExtractorTool(this.log),
    ];
    const toolsNode = new ToolNode(tools);

    // define state & graph
    const StateAnnotation = Annotation.Root({
      messages: Annotation({
        reducer: messagesStateReducer,
      }),
    });

    // the "model"
    this.model = new AzureChatOpenAI({
      azureOpenAIApiKey,
      azureOpenAIApiInstanceName,
      azureOpenAIApiDeploymentName,
      azureOpenAIApiVersion: '2024-08-01-preview',
      temperature: 0,
      callbacks: [new ConsoleCallbackHandler()],
    }).bindTools(tools);

    // nodes
    const callModelNode = async (state) => this.#callModel(state);
    const shouldContinueNode = (state) => this.#shouldContinue(state);

    // the agent workflow
    const workflow = new StateGraph(StateAnnotation)
      .addNode('agent', callModelNode)
      .addNode('tools', toolsNode)
      .addEdge(START, 'agent')
      .addConditionalEdges('agent', shouldContinueNode)
      .addEdge('tools', 'agent');

    // internal states are saved in memory
    const memorySaver = new MemorySaver();

    // the "agent"
    this.app = workflow.compile({ checkpointer: memorySaver });
  }

  /**
   * Determines whether the workflow should continue or end.
   * @param {object} state - The current state of the workflow.
   * @returns {string} The next node to execute or END.
   * @private
   */
  #shouldContinue(state) {
    const msgs = state.messages;
    if (msgs.length === 0) return END;

    const lastMessage = msgs[msgs.length - 1];
    // if the agent just requested a tool call, go to "tools"
    if (lastMessage instanceof AIMessage && lastMessage.tool_calls?.length) {
      return 'tools';
    }

    this.log.info('Agent reached to conclusion. Finishing the process');
    return END;
  }

  /**
   * Calls the language model with the conversation messages.
   * @param {object} state - The current state of the workflow.
   * @returns {Promise<object>} The response messages.
   * @private
   */
  async #callModel(state) {
    const msgs = state.messages;
    const response = await this.model.invoke(msgs);
    return { messages: [response] };
  }

  /**
   * Identifies a matched IMS organization based on the given a domain and a GitHub login.
   *
   * @param {string} domain - The domain of a site.
   * @param {string} githubLogin - The GitHub login of the organization.
   * @returns {Promise<{
   *   matchedCompany: {
   *     id: string,
   *     name: string,
   *     imsOrgId: string
   *   } | null
   * }>} resolves to an object containing the matched company or `null` if no match is found.
   *
   * The returned object has the following structure:
   * {
   *   matchedCompany: {
   *     id: string, // The unique identifier for the company.
   *     name: string, // The name of the company.
   *     imsOrgId: string // The IMS organization ID of the company.
   *   } | null
   * }
   *
   * If no company match is found, the `matchedCompany` field will be `null`.
   */
  async detect(domain, githubLogin) {
    const instructions = getInstructions(domain, githubLogin);
    const noFoundFallback = { org: null };

    const initialState = {
      messages: [new HumanMessage(instructions)],
    };

    // run the agent
    const finalState = await this.app.invoke(initialState, {
      configurable: { thread_id: `domain:${domain}-gh:${githubLogin}` },
    });

    // ihe final LLM message should be JSON
    const finalMessages = finalState.messages;
    const lastMsg = finalMessages[finalMessages.length - 1];

    if (!lastMsg || !(lastMsg instanceof AIMessage)) {
      // if no final AI response, we consider no match found
      return noFoundFallback;
    }

    let finalText = lastMsg.content.trim();
    finalText = finalText.startsWith('```json') ? finalText.slice(7, -3) : finalText;

    try {
      const parsed = JSON.parse(finalText);
      if (isObject(parsed?.matchedCompany)) {
        return parsed.matchedCompany;
      } else {
        return noFoundFallback;
      }
    } catch (err) {
      // fallback
      return noFoundFallback;
    }
  }
}
