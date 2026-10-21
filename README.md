# prerender-audit

Check that a static site's `sitemap.xml` and its prerendered HTML describe the
same set of pages — before you promote the artifact.

Zero dependencies. Node's standard library only.

```
node prerender-audit.mjs dist --origin https://example.com
```

**Released as [v1.0.0](https://github.com/RupamDotInfo/prerender-audit/releases/tag/v1.0.0).**
Not published to npm — see [Install](#install) for the supported routes.

---

## Why this exists

Static site generators produce two independent outputs: the HTML that gets
served, and the sitemap that tells the world those URLs exist. **Nothing forces
them to agree.**

When a route is advertised but never prerendered, the page returns 404. This is
invisible in local development — the dev server resolves routes from the router,
so the page appears to work. It shows up after deploy, on real URLs, as a broken
link or a crawl error.

### A real instance

A content-management change added a new top-level collection to the public API
payload. The sitemap generator read the raw payload. The router read the *same*
data through a sanitising function that rebuilt the object key by key.

A key had been added to the payload and to the type definition — but not to the
sanitiser, which silently dropped it.

- The sitemap advertised **two** new URLs.
- The build prerendered **zero** of them.
- The deploy's post-promotion check refused to promote the artifact and
  restored the previous release. The site was never broken.

Without that check, the same defect ships a 404 into a sitemap.

`prerender-audit` is the same idea as a pre-promotion gate you can run on your
own machine, in CI, or as part of a build — where a rollback is free, because
nothing has shipped yet.

---

## Install

**This package is not published to npm.** It is distributed from GitHub. The
`npm install prerender-audit` form will fail with a 404 until that changes, so
use one of the two routes below.

Requires Node 18 or newer.

### Run it without installing anything

```bash
git clone https://github.com/RupamDotInfo/prerender-audit.git
node prerender-audit/prerender-audit.mjs dist --origin https://example.com
```

### Install it as a dependency

npm can install straight from the GitHub URL, which gives you the same
`prerender-audit` command a registry package would:

```bash
npm install --save-dev github:RupamDotInfo/prerender-audit
npx prerender-audit dist --origin https://example.com
```

Or pinned to the [v1.0.0 release](https://github.com/RupamDotInfo/prerender-audit/releases/tag/v1.0.0):

```bash
npm install --save-dev https://github.com/RupamDotInfo/prerender-audit/archive/refs/tags/v1.0.0.tar.gz
```

If you would rather not install anything, clone-and-run above is the whole
story — there are no dependencies to resolve.

## Usage

```bash
prerender-audit <dist-dir> [options]
```

| Option | Default | Meaning |
|---|---|---|
| `--sitemap <file>` | `<dist-dir>/sitemap.xml` | Sitemap to read |
| `--origin <url>` | none | Expected origin; any URL on another origin is reported |
| `--extra <file>` | `404.html` | Extra prerendered file to ignore, in addition to the defaults (repeatable) |
| `--json` | off | Machine-readable output |
| `--help` | | Usage |

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Sitemap and prerendered output agree |
| `1` | Mismatch, **or the inputs were unusable** |
| `2` | Bad invocation (missing directory, unreadable sitemap, unknown flag) |

## What it checks

**`advertised but NOT prerendered`** — the sitemap promises a URL and the build
has no file behind it. This is the case that 404s.

```
2 advertised but NOT prerendered (these would 404)
    https://example.com/updates
      expected file: updates.html
    https://example.com/updates/first-entry
      expected file: updates/first-entry.html
```

**`prerendered but not advertised`** — a built page nobody can reach. Often a
forgotten route, occasionally a page that should not have shipped.

**`offsite or malformed URL`** — a sitemap entry pointing at another host or
one that is not a valid URL. A common result of a build-time origin variable
picking up the wrong value.

**`duplicate sitemap entries`** — the same URL listed twice.

### Empty input is not agreement

Zero advertised URLs, or zero prerendered files, is reported as
`INPUT UNUSABLE` and exits non-zero.

This is deliberate, and it came from a bug found during development of this
tool. It was first run against a site whose origin was down; the fetch returned
an HTTP error page, the parser found no `<loc>` elements, and the tool reported
**OK** — because zero URLs trivially match zero files.

A safety check that passes on garbage is worse than no check, because it gets
read as an all-clear.

```
INPUT UNUSABLE - this is not evidence of agreement
    the sitemap contains no URLs - was the file fetched correctly?
    no prerendered .html files were found - is this the right directory?
```

## URL to file mapping

| URL | Prerendered file |
|---|---|
| `/` | `index.html` |
| `/index.html` | `index.html` |
| `/about` | `about.html` |
| `/products/lanfy` | `products/lanfy.html` |
| `/products/lanfy/downloads` | `products/lanfy/downloads.html` |

A trailing slash is ignored. This is the flat-output convention used by
vite-ssg, Nuxt, Astro and `next export`, which is what makes the check possible
at all.

A URL that already names an index file maps to that file, so `/index.html` and
`/` are both served by the `index.html` at the site root and both agree with
it. A URL that names an index file *below* the root — `/products/lanfy/index.html`
— maps to `products/lanfy/index.html`, which a flat build does not produce, so
it is still reported as missing. That is correct: a flat build really does
404 on that URL.

## Limitations

Honest about what this does **not** do:

- **It reads files, not URLs.** It cannot tell you that a page exists but
  returns 500, that a page has broken internal links, or that an asset 404s.
  For that, check the deployed site with real requests.
- **Flat output directories only.** An SSG configured to emit
  `about/index.html` rather than `about.html` will report every route as
  missing. Such a build is not currently supported; the mapping is one table in
  `urlToPrerenderPath()` if you need it.
- **Query strings are ignored** when mapping a URL to a file. A sitemap
  containing `?page=2` will map to the same file as `/page/2`, which is usually
  right and occasionally wrong.
- **A sitemapindex is treated as a sitemap.** Nested sitemaps are not fetched.
  Point `--sitemap` at the index file only if it lists `<loc>` entries directly.
- **It does not validate HTML.** It checks that a file exists, not that it is
  well-formed or renders anything.
- **Redirects are not modelled.** A prerendered redirect stub is treated as an
  ordinary page.

## Development

```bash
node --test                    # 36 unit tests, no install required
node scripts/package-smoke.mjs # 15 checks against the packed, installed package
```

Unit tests use Node's built-in runner, so a clean checkout can be tested with no
`npm install` at all — which matters for a check people are meant to run during
a build.

The package smoke test exists because unit tests cannot see packaging. They
import the source module and call its functions, and would keep passing if the
`bin` entry were misspelled, the shebang were dropped, or the CLI were missing
from the published file list — defects that only appear once someone installs
the package. That test runs `npm pack`, installs the tarball into a throwaway
project, and invokes the installed command. It is proven load-bearing: pointing
`bin` at a non-existent file makes it fail.

## Licence

MIT. See [LICENSE](LICENSE).