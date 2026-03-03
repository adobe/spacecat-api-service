# ADR-001: Bulk Delete Operations Use POST Instead of DELETE

## Status
Accepted

## Context
The `@adobe/helix-shared-body-data` middleware, which parses request bodies into `context.data`,
only processes bodies for POST, PUT, and PATCH requests. DELETE request bodies are ignored per
the middleware's `BODY_METHODS` constant.

Bulk deletion endpoints require a request body to identify which resources to remove (e.g., an
array of URLs or audit types). Since DELETE bodies are not parsed, these endpoints receive empty
`context.data` and cannot function.

Single-resource DELETE endpoints (e.g., `DELETE /sites/:siteId/opportunities/:opportunityId`)
are unaffected because they identify the target resource via path parameters.

## Decision
Bulk deletion endpoints that require a request body use POST with an action suffix:
- `POST /sites/:siteId/url-store/delete`
- `POST /sites/:siteId/sentiment/topics/:topicId/prompts/remove`
- `POST /sites/:siteId/sentiment/guidelines/:guidelineId/audits/unlink`

## Consequences
- Bulk delete operations work correctly with the existing middleware
- Single-resource DELETEs remain unchanged (path params, no body needed)
- API consumers must use POST for bulk deletions
- If the middleware is updated to support DELETE bodies in the future, migration back to
  DELETE would be a breaking API change and is not recommended
