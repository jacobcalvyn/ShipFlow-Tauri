# Security review — 2026-09-29

This folder holds the read-only review of ShipFlow Desktop and the follow-up
notes that come from it: the remediation plan, patches, and validation records.

`docs/audit/` is a separate directory and is not the home for these notes.

## Contents

- [findings.md](./findings.md) — the original 26 review items, reassessed on
  2026-09-30 with evidence status, factual corrections, and separate security,
  correctness, and hardening classifications
- [remediation-plan.md](./remediation-plan.md) — patch boundaries, implementation
  order, regression scenarios, and acceptance criteria
- [patch-validation-2026-09-30.md](./patch-validation-2026-09-30.md) — four implemented
  patches, reproductions, native/UI validation, and remaining release limits

The reassessment covers source revision
`8bb5c4cb87d29ce14ffe06de8307522d4bc181bf`. The initial reassessment was static.
The subsequent user-authorized implementation and runtime evidence are recorded
separately in the patch validation report. Priority labels describe work order, not a count of
confirmed security vulnerabilities.

The July 2026 remediation record stays at `docs/security-remediation-2026-07-18.md`.
This folder does not reopen a closed finding unless the current code no longer
matches that record.
