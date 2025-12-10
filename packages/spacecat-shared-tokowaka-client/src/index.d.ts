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

import { S3Client } from '@aws-sdk/client-s3';

export interface TokawakaPatch {
  op: 'replace' | 'insertAfter' | 'insertBefore' | 'appendChild';
  selector: string;
  value: string | object;
  valueFormat: 'text' | 'hast';
  tag?: string;
  currValue?: string;
  target: 'ai-bots' | 'bots' | 'all';
  opportunityId: string;
  suggestionId?: string;
  prerenderRequired: boolean;
  lastUpdated: number;
}

export const TARGET_USER_AGENTS_CATEGORIES: {
  AI_BOTS: 'ai-bots';
  BOTS: 'bots';
  ALL: 'all';
};

export interface TokowakaMetaconfig {
  siteId: string;
  prerender: boolean;
}

export interface TokowakaConfig {
  url: string;
  version: string;
  forceFail: boolean;
  prerender: boolean;
  patches: TokawakaPatch[];
}

export interface CdnInvalidationResult {
  status: string;
  provider?: string;
  purgeId?: string;
  estimatedSeconds?: number;
  paths?: number;
  message?: string;
}

export interface DeploymentResult {
  s3Paths: string[];
  cdnInvalidations: (CdnInvalidationResult | null)[];
  succeededSuggestions: Array<any>;
  failedSuggestions: Array<{ suggestion: any; reason: string }>;
}

export interface RollbackResult {
  s3Paths: string[];
  cdnInvalidations: (CdnInvalidationResult | null)[];
  succeededSuggestions: Array<any>;
  failedSuggestions: Array<{ suggestion: any; reason: string }>;
  removedPatchesCount: number;
}

export interface PreviewResult {
  s3Path: string;
  config: TokowakaConfig;
  cdnInvalidation: CdnInvalidationResult | null;
  succeededSuggestions: Array<any>;
  failedSuggestions: Array<{ suggestion: any; reason: string }>;
  html: {
    url: string;
    originalHtml: string;
    optimizedHtml: string;
  };
}

export interface SiteConfig {
  getTokowakaConfig(): {
    apiKey?: string;
    forwardedHost?: string;
  };
  getFetchConfig?(): {
    overrideBaseURL?: string;
  };
}

export interface Site {
  getId(): string;
  getBaseURL(): string;
  getConfig(): SiteConfig;
}

export interface Opportunity {
  getId(): string;
  getType(): string;
}

export interface Suggestion {
  getId(): string;
  getData(): Record<string, any>;
  getUpdatedAt(): string;
}

/**
 * Base class for opportunity mappers
 * Extend this class to create custom mappers for new opportunity types
 */
export abstract class BaseOpportunityMapper {
  protected log: any;
  
  constructor(log: any);
  
  /**
   * Returns the opportunity type this mapper handles
   */
  abstract getOpportunityType(): string;
  
  /**
   * Determines if prerendering is required for this opportunity type
   */
  abstract requiresPrerender(): boolean;
  
  /**
   * Converts suggestions to Tokowaka patches
   */
  abstract suggestionsToPatches(
    urlPath: string,
    suggestions: Suggestion[],
    opportunityId: string,
    existingConfig: TokowakaConfig | null
  ): TokawakaPatch[];
  
  /**
   * Checks if a suggestion can be deployed for this opportunity type
   * This method should validate all eligibility and data requirements
   */
  abstract canDeploy(suggestion: Suggestion): {
    eligible: boolean;
    reason?: string;
  };
  
  /**
   * Helper method to create base patch structure
   */
  protected createBasePatch(
    suggestion: Suggestion,
    opportunityId: string
  ): Partial<TokawakaPatch>;
}

/**
 * Headings opportunity mapper
 * Handles conversion of heading suggestions (heading-empty, heading-missing-h1, heading-h1-length) to Tokowaka patches
 */
export class HeadingsMapper extends BaseOpportunityMapper {
  constructor(log: any);
  
  getOpportunityType(): string;
  requiresPrerender(): boolean;
  suggestionsToPatches(
    urlPath: string,
    suggestions: Suggestion[],
    opportunityId: string
  ): TokawakaPatch[];
  canDeploy(suggestion: Suggestion): { eligible: boolean; reason?: string };
}

/**
 * Readability opportunity mapper
 * Handles conversion of readability suggestions to Tokowaka patches
 */
export class ReadabilityMapper extends BaseOpportunityMapper {
  constructor(log: any);
  
  getOpportunityType(): string;
  requiresPrerender(): boolean;
  suggestionsToPatches(
    urlPath: string,
    suggestions: Suggestion[],
    opportunityId: string
  ): TokawakaPatch[];
  canDeploy(suggestion: Suggestion): { eligible: boolean; reason?: string };
}

/**
 * Content summarization opportunity mapper
 * Handles conversion of content summarization suggestions to Tokowaka patches with HAST format
 */
export class ContentSummarizationMapper extends BaseOpportunityMapper {
  constructor(log: any);
  
  getOpportunityType(): string;
  requiresPrerender(): boolean;
  suggestionsToPatches(
    urlPath: string,
    suggestions: Suggestion[],
    opportunityId: string
  ): TokawakaPatch[];
  canDeploy(suggestion: Suggestion): { eligible: boolean; reason?: string };
}

/**
 * FAQ opportunity mapper
 * Handles conversion of FAQ suggestions to Tokowaka patches
 */
export class FaqMapper extends BaseOpportunityMapper {
  constructor(log: any);
  
  getOpportunityType(): string;
  requiresPrerender(): boolean;
  canDeploy(suggestion: Suggestion): { eligible: boolean; reason?: string };
  
  /**
   * Creates patches for FAQ suggestions
   * First patch is heading (h2) if it doesn't exist, then individual FAQ divs
   * @throws {Error} if suggestionToPatch is called directly
   */
  suggestionsToPatches(
    urlPath: string,
    suggestions: Suggestion[],
    opportunityId: string,
    existingConfig: TokowakaConfig | null
  ): TokawakaPatch[];
}

/**
 * Table of Contents (TOC) opportunity mapper
 * Handles conversion of TOC suggestions to Tokowaka patches with HAST format
 */
export class TocMapper extends BaseOpportunityMapper {
  constructor(log: any);
  
  getOpportunityType(): string;
  requiresPrerender(): boolean;
  suggestionsToPatches(
    urlPath: string,
    suggestions: Suggestion[],
    opportunityId: string
  ): TokawakaPatch[];
  canDeploy(suggestion: Suggestion): { eligible: boolean; reason?: string };
}

/**
 * Registry for opportunity mappers
 */
export class MapperRegistry {
  constructor(log: any);
  
  registerMapper(MapperClass: typeof BaseOpportunityMapper): void;
  getMapper(opportunityType: string): BaseOpportunityMapper | null;
  getSupportedOpportunityTypes(): string[];
}

/**
 * Base class for CDN clients
 * Extend this class to create custom CDN clients for different providers
 */
export abstract class BaseCdnClient {
  protected env: any;
  protected log: any;
  
  constructor(env: any, log: any);
  
  /**
   * Returns the CDN provider name
   */
  abstract getProviderName(): string;
  
  /**
   * Validates the CDN configuration
   */
  abstract validateConfig(): boolean;
  
  /**
   * Invalidates the CDN cache for the given paths
   */
  abstract invalidateCache(paths: string[]): Promise<CdnInvalidationResult>;
}

/**
 * CloudFront CDN client implementation
 */
export class CloudFrontCdnClient extends BaseCdnClient {
  constructor(env: {
    TOKOWAKA_CDN_CONFIG: string; // JSON string with cloudfront config
  }, log: any);
  
  getProviderName(): string;
  validateConfig(): boolean;
  invalidateCache(paths: string[]): Promise<CdnInvalidationResult>;
}

/**
 * Registry for CDN clients
 */
export class CdnClientRegistry {
  constructor(log: any);
  
  registerClient(provider: string, ClientClass: typeof BaseCdnClient): void;
  getClient(provider: string, config: Record<string, any>): BaseCdnClient | null;
  getSupportedProviders(): string[];
  isProviderSupported(provider: string): boolean;
}

/**
 * Main Tokowaka Client for managing edge optimization configurations
 */
export default class TokowakaClient {
  constructor(config: {
    bucketName: string;
    previewBucketName?: string;
    s3Client: S3Client;
    env?: Record<string, any>;
  }, log: any);
  
  static createFrom(context: {
    env: {
      TOKOWAKA_SITE_CONFIG_BUCKET: string;
      TOKOWAKA_PREVIEW_BUCKET?: string;
      TOKOWAKA_CDN_PROVIDER?: string;
      TOKOWAKA_CDN_CONFIG?: string;
      TOKOWAKA_EDGE_URL?: string;
    };
    log?: any;
    s3: { s3Client: S3Client };
    tokowakaClient?: TokowakaClient;
  }): TokowakaClient;

  /**
   * Generates Tokowaka configuration from suggestions for a specific URL
   */
  generateConfig(
    url: string,
    opportunity: Opportunity,
    suggestions: Suggestion[]
  ): TokowakaConfig | null;

  /**
   * Uploads configuration to S3 for a specific URL
   */
  uploadConfig(url: string, config: TokowakaConfig, isPreview?: boolean): Promise<string>;
  
  /**
   * Fetches existing Tokowaka configuration from S3 for a specific URL
   */
  fetchConfig(url: string, isPreview?: boolean): Promise<TokowakaConfig | null>;
  
  /**
   * Fetches domain-level metaconfig from S3
   */
  fetchMetaconfig(url: string, isPreview?: boolean): Promise<TokowakaMetaconfig | null>;
  
  /**
   * Uploads domain-level metaconfig to S3
   */
  uploadMetaconfig(url: string, metaconfig: TokowakaMetaconfig, isPreview?: boolean): Promise<string>;
  
  /**
   * Merges existing configuration with new configuration
   */
  mergeConfigs(existingConfig: TokowakaConfig, newConfig: TokowakaConfig): TokowakaConfig;
  
  /**
   * Invalidates CDN cache for a specific URL
   */
  invalidateCdnCache(url: string, provider?: string, isPreview?: boolean): Promise<CdnInvalidationResult | null>;

  /**
   * Deploys suggestions to Tokowaka edge
   */
  deploySuggestions(
    site: Site,
    opportunity: Opportunity,
    suggestions: Suggestion[]
  ): Promise<DeploymentResult>;
  
  /**
   * Rolls back deployed suggestions
   */
  rollbackSuggestions(
    site: Site,
    opportunity: Opportunity,
    suggestions: Suggestion[]
  ): Promise<RollbackResult>;
  
  /**
   * Previews suggestions (all must belong to same URL)
   */
  previewSuggestions(
    site: Site,
    opportunity: Opportunity,
    suggestions: Suggestion[],
    options?: {
      warmupDelayMs?: number;
      maxRetries?: number;
      retryDelayMs?: number;
    }
  ): Promise<PreviewResult>;
  
  /**
   * Registers a custom mapper for an opportunity type
   */
  registerMapper(mapper: BaseOpportunityMapper): void;
  
  /**
   * Gets list of supported opportunity types
   */
  getSupportedOpportunityTypes(): string[];
}

