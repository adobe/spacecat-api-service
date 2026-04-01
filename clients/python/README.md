# spacecat-api-types

Generated Pydantic v2 models for the SpaceCat API service.

## Installation

Install from a specific version tag:

```bash
uv add "spacecat-api-types @ git+https://github.com/adobe/spacecat-api-service.git@types-py-v1.0.0"
```

## Usage

```python
from spacecat_api_types import Site, Organization, V2Brand, LlmoConfig

# Parse an API response
site = Site.model_validate(response.json())
print(site.base_url)  # snake_case access, alias handles camelCase from API

# Serialize back to camelCase for API requests
payload = brand_input.model_dump(by_alias=True, exclude_none=True)
```

## Field Naming

Models use **snake_case** Python field names with **camelCase** aliases matching the API:

- `site.base_url` (Python) ← `baseURL` (API)
- `brand.social_accounts` (Python) ← `socialAccounts` (API)
- `config.ai_topics` (Python) ← `aiTopics` (API)

`model_validate()` accepts both forms. Use `model_dump(by_alias=True)` to serialize back to camelCase.
