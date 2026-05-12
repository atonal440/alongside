# worker/vitest.config.ts

Vitest configuration for worker tests.

Runs `worker/test/**/*.test.ts` in a Node environment for the current parser/scaffold unit tests and maps `@shared` to the repository's `shared/` directory. Cloudflare Worker pool usage is deferred until endpoint/e2e tests need real Worker bindings.
