# Opportunity/Suggest/Fix Data Model
https://jira.corp.adobe.com/browse/SITES-26550

## Context

The identify-suggest-fix cycle is a core process in our application, designed to enhance websites by identifying issues that may impact critical experience success metrics such as click-through-rate, organic traffic, conversions, performance metrics (e.g., Core Web Vitals), and search engine ranking.

Our application subjects websites to automated monitoring to detect these issues, which are then presented to users via the Experience Success Studio UI (ESS-UI) as opportunities for improvement. Users can either approve or skip suggestions associated with each opportunity. Once a suggestion is approved, it is implemented in the real world via Fixes, which may involve modifying code, updating content, or making configuration changes to the website.

The current data model has been expanded to incorporate three new entities: Opportunity, Suggestion, and Fix, in addition to existing auditing models. These entities together reflect the identify-suggest-fix cycle by representing issues, proposed solutions, and the actions taken to apply these solutions.

## Rationale for Data Model Expansion

The current auditing models were not sufficient to support the full improvement cycle of websites, particularly the execution and tracking of applied changes. Hence, this data model was expanded to include entities that represent not just identified issues, but also suggestions for addressing them and the real-world execution of those suggestions.

The primary objectives of this expanded data model are to:

1. Represent Opportunities: Capture identified issues that may negatively affect experience success metrics.
2. Detail Suggestions: Offer multiple actionable suggestions to mitigate the underlying issues of an opportunity.
3. Track Real-World Changes: Log how suggestions are implemented through Fixes, tracking modifications across different target systems.

The following sections provide a detailed breakdown of the Opportunity, Suggestion, and Fix entities.

## Entity Descriptions

### Opportunity Entity

Opportunities represent specific issues identified during the auditing process that may negatively impact experience success metrics. An opportunity is created when a potential issue is found on an audited site. The entity is based on an "experience success runbook" that provides general hypotheses and mitigation guidance, and the specific instance is enriched with concrete details about the issue at hand.

| Attribute      | Type                  | Description                                               |
|----------------|-----------------------|-----------------------------------------------------------|
| id             | string, required      | UUID of this opportunity                                  |
| siteId         | string, required      | UUID of the site this opportunity is for                  |
| auditId        | string, required      | UUID of the audit result that triggered this opportunity  |
| runbook        | string, required      | URL to the runbook for this opportunity                   |
| type           | string [ENUM], required | Type of opportunity (commands handler)                   |
| data           | map, optional         | Optional map of type-specific data relevant to this opportunity |
| origin         | string [ENUM], required | Origin of opportunity, e.g., ESS_OPS, AI, etc.        |
| title          | string, required      | Title of this opportunity                                 |
| description    | string, optional      | Description of this opportunity                           |
| status         | string [ENUM], required | Status of this opportunity: NEW, IN_PROGRESS, RESOLVED |
| hypothesis     | string, required      | Hypothesis text specific to this opportunity              |
| guidance       | string, optional      | Guidance text specific to this opportunity                |
| tags           | list [string], optional | Optional list of tags, e.g. "[acquisition:seo]"   |
| createdAt      | string, required      | UTC timestamp of when the opportunity was created         |
| createdBy      | string, required      | IMS or other user ID of who created this opportunity      |
| updatedAt      | string, required      | UTC timestamp of when the opportunity was last updated    |
| updatedBy      | string, required      | IMS or other user ID of who updated this opportunity      |

### Suggestion Entity

Suggestions provide concrete actions that could resolve the issues represented by an opportunity. Suggestions may be viewed as "sub-opportunities" because they break down the main issue into more specific actions. In some cases, executing a single suggestion may resolve the entire opportunity, while in other cases multiple suggestions may need to be implemented.

| Attribute        | Type                  | Description                                               |
|------------------|-----------------------|-----------------------------------------------------------|
| id               | string, required      | UUID of this suggestion                                   |
| opportunityId    | string, required      | UUID of the opportunity this suggestion belongs to        |
| type             | string [ENUM], required | Type of suggestion                                        |
| rank             | numeric, required     | Type-specific numeric rank value (e.g., "domainTraffic" for a broken-backlink) helps sorting |
| data             | map, required         | Map containing type-specific details of what fix is suggested (e.g., { "from": "some-broken-backlink", "fromTitle": "Some Page Title", "to": "some-redirect-target", "toOverride": "human-chosen-target"x }) |
| successMetricDeltas | map, optional      | Map containing metrics estimated to experience lifts or losses due to the issue (e.g., { "clickThroughRate": -1400, "conversionRate": 0, "organicTraffic": -25, "revenue": -40154 }) |
| status           | string [ENUM], required | Status of this suggestion: NEW, APPROVED, SKIPPED, FIXED, ERROR (status reflects overall fix execution, flagged here for optimization) |
| createdAt        | string, required      | UTC timestamp of when the suggestion was created          |
| updatedAt        | string, required      | UTC timestamp of when the suggestion was updated          |

### Fix Entity

Fixes are actions implemented in the real world to apply approved suggestions. These are created by automated processes when suggestions are approved and committed to practice. A single suggestion can lead to multiple fixes, depending on the nature of the change, such as modifying code or adding content and redirects.

| Attribute      | Type                  | Description                                               |
|----------------|-----------------------|-----------------------------------------------------------|
| id             | string, required      | UUID of this fix                                          |
| suggestionId   | string, required      | UUID of the suggestion this fix belongs to                |
| type           | string [ENUM], required | Type of fix (e.g., CODE_CHANGE, CONTENT_UPDATE, REDIRECT_UPDATE, etc.) |
| changeDetails  | map, required         | Details of the changes, including the actually resolved target system (e.g., { "repo": "repo-name", "branch": "branch-name", "filePath": "path/to/file", "targetSystem": "GitHub" }) |
| status         | string [ENUM], required | Current status: PENDING, IN_PROGRESS, COMPLETED, FAILED, ROLLED_BACK |
| createdAt      | string, required      | UTC timestamp for when the fix was created                |
| updatedAt      | string, required      | UTC timestamp for when the fix was last updated           |
| executedBy     | string, optional      | Identifier of the system or person who executed the fix   |

## Diagram

https://lucid.app/lucidchart/bbe8b163-9b48-4ab8-8f00-1942d5ceb79d/edit?viewport_loc=-1761%2C-805%2C7064%2C3801%2CKLckFCMWonda&invitationId=inv_380bf378-8a5e-48ce-a292-f704ad5bb0d7

## HTTP API Endpoints

The following table lists the potential HTTP API endpoints for interacting with the Opportunity and Suggestion entities:

| HTTP Method | Path                                                                         | Description                                                                |
|-------------|------------------------------------------------------------------------------|----------------------------------------------------------------------------|
| GET         | /sites/{siteId}/opportunities                                                | Retrieve a list of all opportunities for a specific site                   |
| GET         | /sites/{siteId}/opportunities/by-status/{status}                             | Retrieve opportunities for a specific site filtered by status              |
| GET         | /sites/{siteId}/opportunities/{opportunityId}                                | Retrieve details of a specific opportunity                                 |
| POST        | /sites/{siteId}/opportunities                                                | Create a new opportunity for a specific site                               |
| PATCH       | /sites/{siteId}/opportunities/{opportunityId}                                | Update specific attributes of an existing opportunity                      |
| DELETE      | /sites/{siteId}/opportunities/{opportunityId}                                | Delete an opportunity and associated suggestions + fixes                   |
| GET         | /sites/{siteId}/opportunities/{opportunityId}/suggestions                    | Retrieve a list of all suggestions for a specific opportunity              |
| GET         | /sites/{siteId}/opportunities/{opportunityId}/suggestions/by-status/{status} | Retrieve suggestions for a specific opportunity filtered by status         |
| GET         | /sites/{siteId}/opportunities/{opportunityId}/suggestions/{suggestionId}     | Retrieve details of a specific suggestion                                  |
| POST        | /sites/{siteId}/opportunities/{opportunityId}/suggestions                    | Add a list of one or more suggestions to an opportunity in one transaction |
| PATCH       | /sites/{siteId}/opportunities/{opportunityId}/suggestions/{suggestionId}     | Update specific attributes of an existing suggestion                       |
| PATCH       | /sites/{siteId}/opportunities/{opportunityId}/suggestions/status             | Update the status of one or multiple suggestions in one transaction        |

## Next Steps

* :spinner-spectrum: Review Phase of Data Model: We will petition for a thorough review of the data model with stakeholders, including engineering, product, and data teams with focus on alignment with business goals and technical feasibility.
* Apply Feedback: Based on the review, we will make any necessary revisions to improve the data model.
* Determine Access Patterns: We will determine how the entities will be accessed in real-world usage, including read and write scenarios. This analysis will be important to ensure that the data model implementation in DynamoDBis optimized for performance.
* Implement Dynamo DB Models: While the data model reflects our business entities, it is important to note that it does not necessarily map 1:1 with the future underlying DynamoDB tables or Global Secondary Indexes (GSIs). We will design DynamoDB models and indices that best suit our access patterns, attempting a balance between flexibility and scalability.
* :spinner-spectrum: Add HTTP API: Develop an HTTP API to expose these entities, allowing for interaction with the Opportunity, Suggestion, and Fix data. This API will facilitate CRUD operations, provide data to the front-end UI, and integrate with other parts of our system.
