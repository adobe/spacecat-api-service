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

import { expect } from 'chai';

import * as aiCrEnums from '@quazar/ai-seo-ts/ai-cr/enums_pb.js';
import * as aiCrMessages from '@quazar/ai-seo-ts/ai-cr/messages_pb.js';
import * as aiCrService from '@quazar/ai-seo-ts/ai-cr/service_pb.js';
import * as aiPrEnums from '@quazar/ai-seo-ts/ai-pr/enums_pb.js';
import * as aiPrMessages from '@quazar/ai-seo-ts/ai-pr/messages_pb.js';
import * as aiPrService from '@quazar/ai-seo-ts/ai-pr/service_pb.js';
import * as aiVoEnums from '@quazar/ai-seo-ts/ai-vo/enums_pb.js';
import * as aiVoMessages from '@quazar/ai-seo-ts/ai-vo/messages_pb.js';
import * as aiVoService from '@quazar/ai-seo-ts/ai-vo/service_pb.js';
import * as commonMethods from '@quazar/ai-seo-ts/common/methods_pb.js';
import * as commonTypes from '@quazar/ai-seo-ts/common/types_pb.js';
import * as commonValidation from '@quazar/ai-seo-ts/common/validation_pb.js';
import * as bufValidate from '@quazar/ai-seo-ts/deps/buf/validate/validate_pb.js';
import * as googleApiAnnotations from '@quazar/ai-seo-ts/deps/google/api/annotations_pb.js';
import * as googleApiHttp from '@quazar/ai-seo-ts/deps/google/api/http_pb.js';
import * as openapiAnnotations from '@quazar/ai-seo-ts/deps/protoc-gen-openapiv2/options/annotations_pb.js';
import * as openapiV2 from '@quazar/ai-seo-ts/deps/protoc-gen-openapiv2/options/openapiv2_pb.js';
import * as v2BrandEnums from '@quazar/ai-seo-ts/v2/brand/enums_pb.js';
import * as v2BrandMessages from '@quazar/ai-seo-ts/v2/brand/messages_pb.js';
import * as v2BrandService from '@quazar/ai-seo-ts/v2/brand/service_pb.js';
import * as v2CommonMessages from '@quazar/ai-seo-ts/v2/common/messages_pb.js';
import * as v2CompetitorEnums from '@quazar/ai-seo-ts/v2/competitor/enums_pb.js';
import * as v2CompetitorMessages from '@quazar/ai-seo-ts/v2/competitor/messages_pb.js';
import * as v2CompetitorService from '@quazar/ai-seo-ts/v2/competitor/service_pb.js';
import * as v2MetaEnums from '@quazar/ai-seo-ts/v2/meta/enums_pb.js';
import * as v2MetaMessages from '@quazar/ai-seo-ts/v2/meta/messages_pb.js';
import * as v2MetaService from '@quazar/ai-seo-ts/v2/meta/service_pb.js';
import * as v2PromptEnums from '@quazar/ai-seo-ts/v2/prompt/enums_pb.js';
import * as v2PromptMessages from '@quazar/ai-seo-ts/v2/prompt/messages_pb.js';
import * as v2PromptService from '@quazar/ai-seo-ts/v2/prompt/service_pb.js';
import * as v2SourceEnums from '@quazar/ai-seo-ts/v2/source/enums_pb.js';
import * as v2SourceMessages from '@quazar/ai-seo-ts/v2/source/messages_pb.js';
import * as v2SourceService from '@quazar/ai-seo-ts/v2/source/service_pb.js';
import * as v2TopicEnums from '@quazar/ai-seo-ts/v2/topic/enums_pb.js';
import * as v2TopicMessages from '@quazar/ai-seo-ts/v2/topic/messages_pb.js';
import * as v2TopicService from '@quazar/ai-seo-ts/v2/topic/service_pb.js';

describe('ai-seo-ts protobuf schemas', () => {
  it('ai-cr enums exports file descriptor and enum schemas', () => {
    expect(aiCrEnums.file_ai_cr_enums).to.exist;
    expect(aiCrEnums.GAP_KINDSchema).to.exist;
    expect(aiCrEnums.GAP_KIND_ENUMSchema).to.exist;
    expect(aiCrEnums.GAP_KIND_ENUM).to.exist;
    expect(aiCrEnums.TOPICS_REQUEST_ORDER_BYSchema).to.exist;
    expect(aiCrEnums.PROMPTS_REQUEST_ORDER_BYSchema).to.exist;
    expect(aiCrEnums.DOMAINS_REQUEST_ORDER_BYSchema).to.exist;
  });

  it('ai-cr messages exports file descriptor and message schemas', () => {
    expect(aiCrMessages.file_ai_cr_messages).to.exist;
    expect(aiCrMessages.MetaRequestSchema).to.exist;
    expect(aiCrMessages.MetaResponseSchema).to.exist;
  });

  it('ai-cr service exports file descriptor and service descriptors', () => {
    expect(aiCrService.file_ai_cr_service).to.exist;
    expect(aiCrService.Meta).to.exist;
    expect(aiCrService.CompetitorsMetrics).to.exist;
    expect(aiCrService.TopicsGap).to.exist;
    expect(aiCrService.SourcesGap).to.exist;
    expect(aiCrService.PromptsGap).to.exist;
  });

  it('ai-pr enums exports file descriptor and enum schemas', () => {
    expect(aiPrEnums.file_ai_pr_enums).to.exist;
  });

  it('ai-pr messages exports file descriptor and message schemas', () => {
    expect(aiPrMessages.file_ai_pr_messages).to.exist;
  });

  it('ai-pr service exports file descriptor and service descriptors', () => {
    expect(aiPrService.file_ai_pr_service).to.exist;
    expect(aiPrService.Fts).to.exist;
    expect(aiPrService.Overview).to.exist;
    expect(aiPrService.Relations).to.exist;
  });

  it('ai-vo enums exports file descriptor and enum schemas', () => {
    expect(aiVoEnums.file_ai_vo_enums).to.exist;
  });

  it('ai-vo messages exports file descriptor and message schemas', () => {
    expect(aiVoMessages.file_ai_vo_messages).to.exist;
  });

  it('ai-vo service exports file descriptor and service descriptors', () => {
    expect(aiVoService.file_ai_vo_service).to.exist;
    expect(aiVoService.BrandMetrics).to.exist;
    expect(aiVoService.Prompts).to.exist;
    expect(aiVoService.Sources).to.exist;
    expect(aiVoService.BrandDomains).to.exist;
  });

  it('common methods exports file descriptor', () => {
    expect(commonMethods.file_common_methods).to.exist;
  });

  it('common types exports file descriptor and type schemas', () => {
    expect(commonTypes.file_common_types).to.exist;
  });

  it('common validation exports file descriptor and validation constants', () => {
    expect(commonValidation.file_common_validation).to.exist;
    expect(commonValidation.is_non_blank).to.exist;
    expect(commonValidation.is_iso_date).to.exist;
  });

  it('deps buf/validate exports file descriptor and constraint schemas', () => {
    expect(bufValidate.file_deps_buf_validate_validate).to.exist;
    expect(bufValidate.ConstraintSchema).to.exist;
    expect(bufValidate.FieldConstraintsSchema).to.exist;
  });

  it('deps google/api/annotations exports file descriptor', () => {
    expect(googleApiAnnotations.file_deps_google_api_annotations).to.exist;
  });

  it('deps google/api/http exports file descriptor and http schemas', () => {
    expect(googleApiHttp.file_deps_google_api_http).to.exist;
    expect(googleApiHttp.HttpSchema).to.exist;
    expect(googleApiHttp.HttpRuleSchema).to.exist;
  });

  it('deps protoc-gen-openapiv2 annotations exports file descriptor and extension fields', () => {
    expect(openapiAnnotations.file_deps_protoc_gen_openapiv2_options_annotations).to.exist;
    expect(openapiAnnotations.openapiv2_swagger).to.exist;
    expect(openapiAnnotations.openapiv2_operation).to.exist;
  });

  it('deps protoc-gen-openapiv2 openapiv2 exports file descriptor and swagger schemas', () => {
    expect(openapiV2.file_deps_protoc_gen_openapiv2_options_openapiv2).to.exist;
    expect(openapiV2.SwaggerSchema).to.exist;
    expect(openapiV2.OperationSchema).to.exist;
  });

  it('v2/brand enums exports file descriptor and enum schemas', () => {
    expect(v2BrandEnums.file_v2_brand_enums).to.exist;
    expect(v2BrandEnums.BRANDS_BY_TOPIC_FTS_REQUEST_ORDER_BYSchema).to.exist;
  });

  it('v2/brand messages exports file descriptor and message schemas', () => {
    expect(v2BrandMessages.file_v2_brand_messages).to.exist;
  });

  it('v2/brand service exports file descriptor and service descriptor', () => {
    expect(v2BrandService.file_v2_brand_service).to.exist;
    expect(v2BrandService.BrandService).to.exist;
  });

  it('v2/common messages exports file descriptor and format schemas', () => {
    expect(v2CommonMessages.file_v2_common_messages).to.exist;
    expect(v2CommonMessages.EXPORT_FILE_FORMATSchema).to.exist;
  });

  it('v2/competitor enums exports file descriptor and enum schemas', () => {
    expect(v2CompetitorEnums.file_v2_competitor_enums).to.exist;
  });

  it('v2/competitor messages exports file descriptor and message schemas', () => {
    expect(v2CompetitorMessages.file_v2_competitor_messages).to.exist;
  });

  it('v2/competitor service exports file descriptor and service descriptor', () => {
    expect(v2CompetitorService.file_v2_competitor_service).to.exist;
    expect(v2CompetitorService.CompetitorService).to.exist;
  });

  it('v2/meta enums exports file descriptor and enum schemas', () => {
    expect(v2MetaEnums.file_v2_meta_enums).to.exist;
  });

  it('v2/meta messages exports file descriptor and message schemas', () => {
    expect(v2MetaMessages.file_v2_meta_messages).to.exist;
  });

  it('v2/meta service exports file descriptor and service descriptor', () => {
    expect(v2MetaService.file_v2_meta_service).to.exist;
    expect(v2MetaService.MetaService).to.exist;
  });

  it('v2/prompt enums exports file descriptor and enum schemas', () => {
    expect(v2PromptEnums.file_v2_prompt_enums).to.exist;
  });

  it('v2/prompt messages exports file descriptor and message schemas', () => {
    expect(v2PromptMessages.file_v2_prompt_messages).to.exist;
  });

  it('v2/prompt service exports file descriptor and service descriptor', () => {
    expect(v2PromptService.file_v2_prompt_service).to.exist;
    expect(v2PromptService.PromptService).to.exist;
  });

  it('v2/source enums exports file descriptor and enum schemas', () => {
    expect(v2SourceEnums.file_v2_source_enums).to.exist;
  });

  it('v2/source messages exports file descriptor and message schemas', () => {
    expect(v2SourceMessages.file_v2_source_messages).to.exist;
  });

  it('v2/source service exports file descriptor and service descriptor', () => {
    expect(v2SourceService.file_v2_source_service).to.exist;
    expect(v2SourceService.SourceService).to.exist;
  });

  it('v2/topic enums exports file descriptor and enum schemas', () => {
    expect(v2TopicEnums.file_v2_topic_enums).to.exist;
  });

  it('v2/topic messages exports file descriptor and message schemas', () => {
    expect(v2TopicMessages.file_v2_topic_messages).to.exist;
  });

  it('v2/topic service exports file descriptor and service descriptor', () => {
    expect(v2TopicService.file_v2_topic_service).to.exist;
    expect(v2TopicService.TopicService).to.exist;
  });
});
