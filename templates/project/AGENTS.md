## Repos

- **app** (TypeScript monorepo): `npm workspaces` across `packages/*`. `npm test` runs every workspace's tests.
- **infra** (Terraform): root modules under `environments/*`.
  - Validate: `terraform init -backend=false && terraform validate`
  - Do NOT run Terraform `plan` or `apply`. The PR pipeline runs `plan`, and the reviewer checks its output.
  - There are no unit tests. "Tests" for Terraform tickets = `validate` passes.
  - Instead of the TDD steps: write or modify the `.tf` resources, make `validate` pass, and list in `notes` the resource changes you expect the PR pipeline's `plan` to show. `terraform fmt -check` must pass (use `terraform fmt <files you changed>` to fix) instead of lint and format.

## Services in this environment

- A throwaway Postgres is running and `TEST_DATABASE_URL` points at it, so database-backed tests run here. Run them.

## Missing here

- `pdftotext` is not installed, so tests that read PDFs can't run.
