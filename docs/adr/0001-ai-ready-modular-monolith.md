# ADR 0001: executable contracts inside a modular monolith

Status: accepted for this branch, 2026-10-21.

Keep Meteor/React/MUI/Mongo and existing applications. Introduce a small explicit contract/operation core and a minimal owner-scoped tasks module. The legacy Example remains an optional capabilities demonstration, not a template. Security fixes apply to exposed legacy surfaces immediately; migration is gradual, not a second hidden implementation of each business rule.

Separate four concerns:
1. Application runtime: authentication, policy, validation, persistence and UI.
2. AI Development Toolkit: local deterministic Node CLI, templates, context and diagnostics.
3. External harness: model selection, retries, budgets, isolation and protected evaluator. No harness daemon or model credentials in the application.
4. Optional AI product runtime: outside this reference profile; enable only with separate contracts/qualification.

A short-lived file capability is a bearer credential scoped to one file and operation. Issuance requires ownership; bearer sharing and short expiry are explicit. It is not equivalent to continuously rechecking membership. Tenant deployments must add live membership checks where their revocation policy requires them.

Tradeoff: compatibility adapters remain in legacy base classes. New code must use exact DTO contracts. No claim that all optional combinations, tenant products, distributed quotas, offline clients or arbitrary uploads are qualified by the owner-CRUD profile.
