# Consumers API – Outstanding Work

The Consumers API (`/consumers/*`) was implemented without the following repo requirement. This can be addressed in a follow-up PR.

## OpenAPI Specification

- **Status:** Missing
- **Requirement:** OpenAPI-first API contract (see [.cursor/rules/openapi-api-specification-implementation.mdc](../.cursor/rules/openapi-api-specification-implementation.mdc))
- **Action:** Add `docs/openapi/consumers-api.yaml` and register paths in `docs/openapi/api.yaml`
- **Endpoints to document:**
  - `GET /consumers` – list all consumers
  - `GET /consumers/:consumerId` – get consumer by ID
  - `GET /consumers/by-client-id/:clientId` – get consumer by client ID
  - `POST /consumers/register` – register new consumer (body: `consumerName`, `capabilities`; Technical Account token via `x-ta-access-token` header)
  - `PATCH /consumers/:consumerId` – update consumer
  - `POST /consumers/:consumerId/revoke` – revoke consumer
