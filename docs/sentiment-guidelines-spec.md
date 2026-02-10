# Brand Sentiment Guidelines Store

## Overview

The Brand Sentiment Guidelines Store allows customers to define and configure topics and guidelines for sentiment analysis. Topics represent subjects of interest (e.g., "2026 Corvette Stingray", "BMW XM Latest") with associated sub-prompts, while Guidelines define analysis focus areas with specific audit type associations.

**Key Design Decision**: Topics and Guidelines are **independent entities**. Guidelines define which audit types they apply to, not topics.

---

## Data Models

### SentimentTopic

Represents a subject/topic for sentiment analysis with optional sub-prompts.

```typescript
interface SentimentTopic {
  siteId: string;           // Parent site identifier (partition key)
  topicId: string;          // Unique topic identifier (sort key, auto-generated UUID)
  name: string;             // Topic name/subject to analyze (required, e.g., "2026 Corvette Stingray")
  description?: string;     // Optional description for context
  subPrompts: string[];     // Additional prompts/questions for deeper analysis
  enabled: boolean;         // Whether topic is active (default: true)
  createdAt: string;        // ISO 8601 timestamp
  updatedAt: string;        // ISO 8601 timestamp
  createdBy: string;        // User/service who created
  updatedBy: string;        // Last user/service to modify
}
```

**Example:**
```json
{
  "siteId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "topicId": "topic-001",
  "name": "2026 Corvette Stingray",
  "description": "Track sentiment about the latest Corvette model",
  "subPrompts": [
    "What do people say about performance?",
    "How is the design being received?",
    "Price sentiment?"
  ],
  "enabled": true,
  "createdAt": "2026-01-15T10:00:00Z",
  "updatedAt": "2026-01-20T14:30:00Z",
  "createdBy": "user-alice",
  "updatedBy": "user-bob"
}
```

**Primary Key**: `siteId` (partition) + `topicId` (sort)

---

### SentimentGuideline

Represents an analysis guideline/instruction for sentiment analysis, with specific audit type associations.

```typescript
interface SentimentGuideline {
  siteId: string;           // Parent site identifier (partition key)
  guidelineId: string;      // Unique guideline identifier (sort key, auto-generated UUID)
  name: string;             // Display name (required)
  instruction: string;      // The actual guideline instruction (required)
  audits: string[];         // Enabled audit types (e.g., ['wikipedia-analysis', 'reddit-analysis'])
  enabled: boolean;         // Whether guideline is active (default: true)
  createdAt: string;        // ISO 8601 timestamp
  updatedAt: string;        // ISO 8601 timestamp
  createdBy: string;        // User/service who created
  updatedBy: string;        // Last user/service to modify
}
```

**Example:**
```json
{
  "siteId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "guidelineId": "guideline-001",
  "name": "Product Quality Focus",
  "instruction": "Focus on sentiment related to product quality, durability, and craftsmanship. Highlight mentions of build quality, materials, and reliability.",
  "audits": ["wikipedia-analysis", "reddit-analysis"],
  "enabled": true,
  "createdAt": "2026-01-10T08:00:00Z",
  "updatedAt": "2026-01-10T08:00:00Z",
  "createdBy": "user-alice",
  "updatedBy": "user-alice"
}
```

**Primary Key**: `siteId` (partition) + `guidelineId` (sort)

---

## API Endpoints

### Topics (7 endpoints)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/sites/:siteId/sentiment/topics` | List all topics for a site |
| `GET` | `/sites/:siteId/sentiment/topics/:topicId` | Get a specific topic |
| `POST` | `/sites/:siteId/sentiment/topics` | Create topics (bulk) |
| `PATCH` | `/sites/:siteId/sentiment/topics/:topicId` | Update a topic |
| `DELETE` | `/sites/:siteId/sentiment/topics/:topicId` | Delete a topic |
| `POST` | `/sites/:siteId/sentiment/topics/:topicId/prompts` | Add sub-prompts to a topic |
| `DELETE` | `/sites/:siteId/sentiment/topics/:topicId/prompts` | Remove sub-prompts from a topic |

### Guidelines (7 endpoints)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/sites/:siteId/sentiment/guidelines` | List all guidelines for a site |
| `GET` | `/sites/:siteId/sentiment/guidelines/:guidelineId` | Get a specific guideline |
| `POST` | `/sites/:siteId/sentiment/guidelines` | Create guidelines (bulk) |
| `PATCH` | `/sites/:siteId/sentiment/guidelines/:guidelineId` | Update a guideline |
| `DELETE` | `/sites/:siteId/sentiment/guidelines/:guidelineId` | Delete a guideline |
| `POST` | `/sites/:siteId/sentiment/guidelines/:guidelineId/audits` | Link audit types to a guideline |
| `DELETE` | `/sites/:siteId/sentiment/guidelines/:guidelineId/audits` | Unlink audit types from a guideline |

### Combined (1 endpoint)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/sites/:siteId/sentiment/config` | Get full config (topics + guidelines) |

---

## API Details

### List Topics
```
GET /sites/:siteId/sentiment/topics?limit=100&cursor=xxx&enabled=true
```

**Query Parameters:**
- `limit` (optional): Max items per page (default: 100, max: 500)
- `cursor` (optional): Pagination cursor
- `enabled` (optional): Filter by enabled status

### Create Topics (Bulk)
```
POST /sites/:siteId/sentiment/topics
```

**Request Body:**
```json
[
  {
    "name": "BMW XM 2026",
    "description": "Track sentiment about the latest BMW XM luxury SUV",
    "subPrompts": ["Performance feedback?", "Interior quality?", "Price perception?"],
    "enabled": true
  }
]
```

### Create Guidelines (Bulk)
```
POST /sites/:siteId/sentiment/guidelines
```

**Request Body:**
```json
[
  {
    "name": "Product Quality Focus",
    "instruction": "Focus on product quality and durability mentions",
    "audits": ["wikipedia-analysis", "reddit-analysis"],
    "enabled": true
  }
]
```

### Link Audits to Guideline
```
POST /sites/:siteId/sentiment/guidelines/:guidelineId/audits
```

**Request Body:**
```json
{
  "audits": ["wikipedia-analysis", "reddit-analysis"]
}
```

**Note:** Only valid audit types are accepted. Invalid types return 400 Bad Request.

### Get Config
```
GET /sites/:siteId/sentiment/config?audit=wikipedia-analysis
```

**Query Parameters:**
- `audit` (optional): Filter guidelines by audit type

**Response:**
```json
{
  "topics": [SentimentTopic],
  "guidelines": [SentimentGuideline]
}
```

When `audit` is specified, only guidelines with that audit type are returned. Topics are always returned (all enabled topics).

---

## Data Access Patterns

### SentimentTopicCollection

| Method | Description |
|--------|-------------|
| `findById(siteId, topicId)` | Get topic by composite key |
| `allBySiteIdPaginated(siteId, options)` | List all topics for site |
| `allBySiteIdEnabled(siteId, options)` | Get only enabled topics |
| `removeForSiteId(siteId)` | Remove all topics for a site |

### SentimentGuidelineCollection

| Method | Description |
|--------|-------------|
| `findById(siteId, guidelineId)` | Get guideline by composite key |
| `findByIds(siteId, guidelineIds)` | Batch get guidelines |
| `allBySiteIdPaginated(siteId, options)` | List all guidelines for site |
| `allBySiteIdEnabled(siteId, options)` | Get only enabled guidelines |
| `allBySiteIdAndAuditType(siteId, auditType, options)` | Filter guidelines by audit type |
| `removeForSiteId(siteId)` | Remove all guidelines for a site |

---

## Audit Type Validation

Guidelines can be associated with specific audit types. The following audit types are validated:

- `wikipedia-analysis`
- `reddit-analysis`
- `youtube-analysis`
- `twitter-analysis`
- `news-analysis`
- `forum-analysis`

Attempting to link an invalid audit type returns a 400 Bad Request error.

---

## Design Rationale

### Why audits are on Guidelines, not Topics

**Guidelines define HOW to analyze, Topics define WHAT to analyze.**

- A guideline like "Focus on product quality" makes sense to apply to specific audit platforms (e.g., apply this guideline when analyzing Wikipedia and Reddit, but not YouTube)
- Topics like "2026 Corvette Stingray" should be analyzed across all platforms where the guideline applies
- This separation allows:
  - Same topic to be analyzed differently on different platforms
  - Platform-specific guidelines (e.g., "Focus on video engagement" only for YouTube)
  - Flexible configuration without complex many-to-many relationships

### Independence of Topics and Guidelines

Topics and Guidelines are intentionally **not linked** at the data level. During sentiment analysis:

1. Fetch all enabled topics for the site
2. Fetch guidelines filtered by the current audit type
3. Apply all matching guidelines when analyzing each topic

This provides:
- **Flexibility**: Different guidelines apply to different platforms
- **Simplicity**: No complex relationships to manage
- **Performance**: Filter guidelines at query time, not at analysis time

---

## Example Usage Flow

1. **Setup Topics:**
   ```
   POST /sites/:siteId/sentiment/topics
   Body: [{ name: "2026 Corvette Stingray", subPrompts: ["Performance?", "Price?"] }]
   ```

2. **Setup Guidelines with Audit Associations:**
   ```
   POST /sites/:siteId/sentiment/guidelines
   Body: [{
     name: "Quality Focus",
     instruction: "Focus on product quality mentions",
     audits: ["wikipedia-analysis", "reddit-analysis"]
   }]
   ```

3. **Audit Worker Fetches Config for Wikipedia:**
   ```
   GET /sites/:siteId/sentiment/config?audit=wikipedia-analysis
   ```
   Returns: All enabled topics + only guidelines configured for wikipedia-analysis

4. **Analyze:** Worker uses topics and applies the filtered guidelines during analysis
