# Paper Library development

[Paper Library](https://yak9ce3teeh.github.io/papers/) is the signed-in library under the personal homepage. GitHub Pages serves the website. A TypeScript Worker provides accounts, spaces, the catalogue, file upload, reading capture, and DeepSeek translation. D1 stores records and R2 stores uploaded documents. The browser reader uses PDF.js for PDFs and the Zotero add-on supports optional local synchronization.

## Source map

| Task | Start here |
| --- | --- |
| Account screens and library layout | [`frontend/index.tsx`](frontend/index.tsx), [`frontend/library.tsx`](frontend/library.tsx), [`frontend/style.css`](frontend/style.css) |
| Catalogue filters and Add Readings | [`frontend/catalogue.tsx`](frontend/catalogue.tsx), [`frontend/reading-dialog.tsx`](frontend/reading-dialog.tsx), [`frontend/reading-source.ts`](frontend/reading-source.ts) |
| PDF, DOCX, web views, notes, and translation UI | [`papers/reader/`](../../papers/reader) |
| API, D1 schema, and R2 integration | [`service/worker.ts`](service/worker.ts), [`service/app/api/`](service/app/api), [`service/lib/`](service/lib), [`service/migrations/`](service/migrations) |
| Zotero add-on and browser integration | [`zotero/zotero-addon/`](zotero/zotero-addon), [`papers/add/integrations/zotero.mjs`](../../papers/add/integrations/zotero.mjs) |
| Pages build and staging | [`package_site.py`](../paper_add/package_site.py), [Pages workflow](../../.github/workflows/pages.yml) |

Edit the React source in `frontend/` and regenerate its published assets with `npm run release`. The reader under `papers/reader/` is edited directly. For changes to keyword suggestions, keep [`frontend/public/keywords.mjs`](frontend/public/keywords.mjs) and [`service/public/keywords.mjs`](service/public/keywords.mjs) in sync. Live keyword vocabulary comes from the signed-in account's selected space. The scripts under [`tools/paper_add/`](../paper_add) support the earlier offline ingestion workflow.

## Build and test from a fresh clone

Use Git, Node.js 24, and Python 3.12. Run these commands from the repository root after cloning. Windows PowerShell users can use `npm.cmd` in place of `npm`.

```sh
git clone https://github.com/yak9ce3teeh/yak9ce3teeh.github.io.git
cd yak9ce3teeh.github.io
npm --prefix tools/paper_library/frontend ci
npm --prefix tools/paper_library/service ci
npm --prefix tools/paper_library/frontend test
npm --prefix tools/paper_library/service test
node tools/paper_library/zotero/test_addon.cjs
npm --prefix tools/paper_library/frontend run build
python tools/paper_library/zotero/package_addon.py
```

The frontend build writes to `frontend/dist/`. The add-on packager writes an XPI and matching update manifest to `zotero/dist/`. The test suites use synthetic data and service fixtures. A Cloudflare account, DeepSeek key, production library, and Zotero installation are optional for these checks. Test native Zotero behavior with a Zotero 10 profile when changing the add-on.

## Run the local website and API

From the repository root, build the frontend as above. In a terminal, apply the local D1 schema and start the Worker.

```sh
cd tools/paper_library/service
npm exec -- wrangler d1 migrations apply paper-library-local --local --config wrangler.dev.toml
npm exec -- wrangler dev --local --config wrangler.dev.toml
```

In another terminal at the repository root, run `python tools/paper_library/preview.py` and open [the local library](http://127.0.0.1:8000/papers/). The preview uses a fresh copy of the Pages files with the current frontend build and local Worker. Rebuild and restart the preview after frontend or reader edits.

To test uploads and the catalogue, sign up as `reader-dev` with a test password. Then run the following command from `tools/paper_library/service` and reload the library. The SQL attaches the local R2-backed test space to that account.

```sh
npm exec -- wrangler d1 execute paper-library-local --local --config wrangler.dev.toml --file test/attach-local-space.sql
```

Use disposable files and the local account when testing. Live DeepSeek translation is owner-only. The route tests cover translation with a mock provider.

## Submit and publish changes

1. Open a feature branch. Run the relevant tests and use the local preview for UI changes.
2. For React changes, run `npm --prefix tools/paper_library/frontend run release` to refresh `papers/index.html` and the corresponding `papers/add/` assets. Commit the source and its generated files together.
3. For Zotero add-on changes, bump the manifest version and run `python tools/paper_library/zotero/package_addon.py --release`. Commit the source, XPI, and update manifest together.
4. Open a pull request and describe the tests you ran. On merge to `main`, [GitHub Actions](../../.github/workflows/pages.yml) publishes the static files using the Pages allowlist. Verify the deployment in [Actions](https://github.com/yak9ce3teeh/yak9ce3teeh.github.io/actions).

Cloudflare deployment is a separate owner operation. From `service/`, use an owner-provided `wrangler.toml` based on [`wrangler.template.toml`](service/wrangler.template.toml). Confirm the Worker and D1/R2 targets. For a schema change, have the owner review and apply the new migration to the intended database, then deploy the Worker with `npm exec -- wrangler deploy --config wrangler.toml`. [Cloudflare D1 commands](https://developers.cloudflare.com/d1/wrangler-commands/)

The Worker reads production secrets from Cloudflare. `DEEPSEEK_API_KEY` enables translation, `SPACE_ENCRYPTION_KEY` protects external R2 credentials, and `LIBRARY_ACCESS_KEY` is for legacy owner access. Keep credentials, local state, production Wrangler bindings, account exports, PDF collections, and reading notes out of this public Git repository. [Cloudflare Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)

The hosted browser client pins the production Worker origin and the Worker allows the production site origin. A separately hosted fork needs its own pair of origins and Cloudflare bindings. The Zotero add-on also pins the hosted site origin and update URL.
