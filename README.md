# Personal Homepage

Personal homepage for the yak9ce3teeh GitHub account. It links to Paper Library and includes a YakBot placeholder, a BanG Dream! section, and a monthly anime log. The BanG Dream! section links to our unofficial [millsage fan site](https://millsage-website.onrender.com/).

- Homepage: https://yak9ce3teeh.github.io/
- Paper library: https://yak9ce3teeh.github.io/papers/
- Repository: https://github.com/yak9ce3teeh/yak9ce3teeh.github.io

## Develop Paper Library

Start with the [developer README](tools/paper_library/README.md) for the source map, local preview, tests, and deployment instructions. The repo includes the React frontend, Cloudflare Worker and database migrations, browser reader, and Zotero add-on source.

[GitHub Actions](.github/workflows/pages.yml) packages and deploys the static site from `main`. Cloudflare Workers serves the library API, with D1 for records and R2 for uploaded files.
