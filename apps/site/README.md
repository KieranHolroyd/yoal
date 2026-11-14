# Yoal front page

Yoal's public landing page: one static HTML page, a stylesheet and two fonts. There's no client
framework, and the only script is a few lines for the copy buttons.

```sh
bun run site:dev      # http://localhost:4322, rebuilds on every change (SITE_PORT)
bun run site:build    # → apps/site/dist
```

## Deploying

On Yoal, from the repository root:

```sh
bun run site:build -- --site-url https://yoal.example --docs-url https://docs.yoal.example
yoal deploy apps/site/dist --project yoal-site
```

| Flag | Env | Purpose |
| --- | --- | --- |
| `--out <dir>` | | Output directory (default `dist`) |
| `--site-url <url>` | `SITE_URL` | Public origin, adds a canonical link, `sitemap.xml` and `robots.txt` |
| `--docs-url <url>` | `SITE_DOCS_URL` | Where the "Docs" links go (default: the docs Markdown on GitHub) |

## Keeping it honest

The copy in `src/page.ts` restates the root README. When a feature ships, leaves preview or goes
behind a flag, update both. The MCP tool count is read from the README's tool table at build time,
and the version comes from `VERSION`.
