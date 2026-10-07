## Repos

- **app** (TypeScript monorepo): `npm workspaces` across `packages/*`. `npm test` runs every workspace's tests.

## Services in this environment

- A throwaway Postgres is running and `TEST_DATABASE_URL` points at it, so database-backed tests run here. Run them.

## Missing here

- `pdftotext` is not installed, so tests that read PDFs can't run.
