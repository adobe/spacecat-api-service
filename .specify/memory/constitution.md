<!--
Sync Impact Report - Constitution v1.0.0
Version Change: [NEW] → 1.0.0 (Initial Constitution)
Ratification Date: 2026-01-22

Core Principles Established:
- I. API-First Design
- II. Use Case-Driven Data Modeling
- III. Test Coverage and Quality
- IV. Security and Access Control
- V. Performance Standards
- VI. Code Organization Patterns

Additional Sections:
- Observability & Monitoring

Templates Status:
- ✅ plan-template.md: Reviewed - Constitution Check section compatible
- ✅ spec-template.md: Reviewed - Requirements and test focus aligned
- ✅ tasks-template.md: Reviewed - Task categorization compatible

Follow-up Actions:
- None - initial constitution complete

-->

# SpaceCat API Service Constitution

## Core Principles

### I. API-First Design

All API endpoints MUST be defined in OpenAPI specifications before implementation begins. The OpenAPI contract serves as the source of truth for API behavior, request/response schemas, and validation rules.

**Rationale**: API-first design ensures contracts are explicit, enables parallel development of consumers and providers, supports automatic validation and documentation generation, and prevents implementation details from leaking into the API surface.

### II. Use Case-Driven Data Modeling

API design and data modeling MUST start with understanding business use cases and non-functional requirements, not implementation details. Data access patterns MUST be derived from business use cases. Data models, storage implementation, and API endpoints MUST be informed by required data access patterns and non-functional requirements.

**Key Requirements**:
- Clarify data access patterns: where data surfaces, query patterns, read/write frequency
- Clarify data model needs: simple vs complex structures, size, access control, update patterns
- Clarify scale and performance: record counts, payload sizes, projection needs, progressive loading
- Always ask for clarification when requirements are vague or imply design anti-patterns
- Evaluate approaches against relevant criteria: list/query performance, concurrent updates, access control granularity, filtering/sorting support, bandwidth optimization
- Follow existing patterns in the codebase; reuse established utilities and helpers
- Match solution complexity to actual requirements; don't over-engineer
- Implement incrementally

**Rationale**: Starting with use cases prevents premature optimization and over-engineering. Understanding access patterns ensures the data model supports required queries efficiently. Incremental implementation allows validation at each step and adaptation based on real usage.

### III. Test Coverage and Quality

Test coverage MUST be maintained at acceptable levels. Tests MUST be written to validate behavior, not implementation. Integration tests MUST verify cross-component interactions. Contract tests MUST validate API compliance with OpenAPI specifications.

**Key Requirements**:
- Unit tests for business logic and utilities
- Integration tests for cross-component workflows
- Contract tests for API endpoints against OpenAPI specs
- Test names MUST describe behavior being validated
- Tests MUST be maintainable and provide clear failure messages
- Never modify or delete tests to make them pass

**Rationale**: Comprehensive testing enables confident refactoring, prevents regressions, serves as executable documentation, and ensures API contracts are honored.

### IV. Security and Access Control

Security MUST be designed into features from the start, not added afterward. Access control MUST be entity-level. Sensitive data MUST be separated into distinct entities when different access rules apply.

**Key Requirements**:
- Plan entity-level permissions from the start
- Separate sensitive data to separate entities if needed
- Never commit secrets, API keys, tokens, passwords, or credentials
- Never hardcode sensitive values; use environment variables
- Flag potential PII in code; do not use real user data in tests

**Rationale**: Entity-level access control provides clear security boundaries. Early security design prevents costly retrofits. Proper secret management prevents credential leaks and security incidents.

### V. Performance Standards

API endpoints MUST meet performance requirements defined by business use cases. Avoid read-modify-write patterns; use atomic operations. Optimize for common query patterns using appropriate indexes. Use projection to exclude heavy fields when bandwidth is a concern.

**Key Requirements**:
- Identify performance requirements during use case clarification
- Design data models and indexes for common query patterns
- Use atomic operations for concurrent updates
- Document pagination behavior and bandwidth optimization strategies
- Avoid premature optimization; measure before optimizing

**Rationale**: Performance requirements differ by use case. Designing for common patterns ensures efficiency. Atomic operations prevent race conditions. Bandwidth optimization is critical for mobile and high-volume scenarios.

### VI. Code Organization Patterns

Code MUST follow established organizational patterns in the codebase. Controllers handle HTTP concerns. Services contain business logic. DTOs define data transfer shapes. Routes define API structure. Utilities provide reusable helpers.

**Key Requirements**:
- Examine similar features in the codebase first
- Reuse established patterns (e.g., Site/Audit, Opportunity/Suggestion)
- Controllers: HTTP request/response handling, validation delegation
- Services: business logic, data access, cross-entity operations
- DTOs: request/response shape validation and transformation
- Routes: API endpoint registration and middleware configuration
- Keep related code together; avoid premature abstraction

**Rationale**: Consistent organization improves navigability and maintainability. Examining existing patterns reduces learning curve and ensures consistency. Clear separation of concerns enables independent testing and evolution of each layer.

## Observability & Monitoring

All significant operations MUST be observable. Logging, metrics, and tracing MUST provide insight into system behavior in production.

**Key Requirements**:
- Log all security events (authentication, authorization, access control violations)
- Log errors with sufficient context for debugging (request context, operation details)
- Use structured logging for machine-parseable output
- Include timing information for performance-critical operations
- Avoid logging sensitive data (credentials, tokens, PII)
- Document monitoring and alerting requirements for new features

**Rationale**: Production issues cannot be debugged without observability. Structured logging enables automated analysis and alerting. Security event logging is essential for audit and incident response.

## Governance

This constitution is the highest authority for development practices in SpaceCat API Service. All pull requests MUST comply with these principles. Complexity that violates principles MUST be justified with specific technical reasoning.

**Amendment Process**: Constitution changes occur via feature PRs that surface learnings requiring principle updates. PR reviewers evaluate proposed amendments for consistency with project goals. Approved amendments update this document with incremented version number.

**Version Policy**:
- MAJOR: Backward-incompatible governance changes or principle removals
- MINOR: New principles added or existing principles materially expanded
- PATCH: Clarifications, wording improvements, non-semantic refinements

**Compliance Review**: PR reviewers verify that proposed changes align with constitutional principles. When principles conflict with practical needs, discuss amendment rather than violating the constitution.

**Version**: 1.0.0 | **Ratified**: 2026-01-22 | **Last Amended**: 2026-01-22
