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
| `--extra <file>` | `404.html` | Prerendered file to ignore (repeatable) |
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
| `/about` | `about.html` |
| `/products/lanfy` | `products/lanfy.html` |
| `/products/lanfy/downloads` | `products/lanfy/downloads.html` |
| `/docs/getting%20started` | `docs/getting started.html` |

A trailing slash is ignored. This is the flat-output convention used by
vite-ssg, Nuxt, Astro and `next export`, which is what makes the check possible
at all.

## Percent-encoding

A URL path carries its percent-encoding on the wire; the file that backs it
may be written with the encoding or without it.
`https://example.com/docs/getting%20started` is served by
`docs/getting started.html` on some generators and by
`docs/getting%20started.html` on others, and the sitemap may spell it either
way too.

**The decision: neither file-name convention is authoritative.** The tool
compares the two sides by their *decoded* path, so a page is recognised
whichever way it was written. A fix that only decoded the URL would have
fixed half the sites and broken the other half — trading a false positive for
a false negative.

The decision affects only what is *reported*, never whether a page matches:

- A page that is genuinely missing is reported with the **decoded** file name
  (`docs/getting started.html`), because that is the name most generators
  write. On a site whose generator writes the encoded name instead, the name
  in that line will not be the name on disk.
- A prerendered file that is not advertised is reported with a **decoded**
  URL (`/docs/getting started`), for the same reason.

One exception: an encoded slash (`%2F`) is left encoded, because it is a
slash inside a path segment rather than a separator between segments.
Decoding it would turn one page into two.

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
- **Duplicate entries are compared as written.** A sitemap listing the same
  page twice in two different spellings (`/docs/a%20b` and `/docs/a b`) is not
  reported as a duplicate, because the two entries are not the same string.
  The page itself is matched against one file either way.

## Development

```bash
node --test                    # 23 unit tests, no install required
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