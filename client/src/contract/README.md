# Temporary copy of `@epicenter/shared`

These files are an unmodified copy of `shared/src/` from Person A's task A1 (commit `98f1d3f`), which is
not on `main` yet. The client imports them as `@epicenter/shared` through an alias in `tsconfig.json` and
`vite.config.ts`, so no client import changes when the real package arrives.

Do not edit these files. When `shared/` is merged:

1. Delete this `client/src/contract/` directory.
2. Remove the `@epicenter/shared` alias from `client/tsconfig.json` and `client/vite.config.ts`.
3. In `client/package.json`, add `"@epicenter/shared": "*"` and remove `zod` (it comes from `shared`).
4. Run `npm run typecheck` — any difference between this copy and the merged contract shows up there.
