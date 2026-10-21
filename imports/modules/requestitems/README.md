# Request items: public domain contract

Architecture: core-v1, domain-only. Public entrypoint: `contracts/index.ts`.
Request items have bounded quantity and an integer price in BRL cents. They are embedded in the Requests aggregate so changes, submission and history use the same atomic version CAS. This module owns no collection or remote method. Consumers import only its public contract.
