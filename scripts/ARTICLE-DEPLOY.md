# Article deployment

The public article lives at https://myrakrusemark.com/watermark/.
The homepage card and published static snapshot are in
https://github.com/myrakrusemark/myrakrusemark.com (main branch).
GitHub Pages publishes that repository's root.

To build and publish an update in one command, supply a clean checkout of the
portfolio repository:

```sh
node scripts/publish-article.mjs /path/to/myrakrusemark.com --publish
```

This checks the destination repository, updates main with a fast-forward pull,
builds the article, replaces only `watermark/`, commits it, and pushes to main.
Omit `--publish` to prepare files for review without committing or pushing.
The homepage card is managed in the portfolio's `index.html`.
Do not use the standalone Pages deploy command for this article.

GitHub Pages does not apply `_headers`. The Cloudflare Worker configured
in `wrangler-article.json` supplies cross-origin isolation only on the
article routes. Deploy header changes with:

```
npx wrangler deploy --config scripts/wrangler-article.json
```

The selected thumbnail is `web/assets/watermark-thumbnail.png`.
The article's share metadata uses its permanent public URL.
