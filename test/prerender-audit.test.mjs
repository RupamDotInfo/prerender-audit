import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

import {
    parseSitemap,
    decodePath,
    urlToPrerenderPath,
    prerenderPathToUrl,
    audit,
    formatReport,
} from '../prerender-audit.mjs'

/**
 * Tests use node:test, which ships with Node. There is no test dependency to
 * install, so `node --test` works on a bare checkout with no npm install. For a
 * safety check that people are meant to run during a build, that matters.
 */

const ORIGIN = 'https://example.test'

/** Build a throwaway dist directory from a {file: contents} map. */
async function fixture(files) {
    const dir = await mkdtemp(path.join(tmpdir(), 'prerender-audit-'))
    for (const [relative, contents] of Object.entries(files)) {
        const full = path.join(dir, relative)
        await mkdir(path.dirname(full), { recursive: true })
        await writeFile(full, contents)
    }
    return {
        dir,
        cleanup: () => rm(dir, { recursive: true, force: true }),
    }
}

const sitemap = (...urls) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
        .map((u) => `  <url><loc>${u}</loc></url>`)
        .join('\n')}\n</urlset>\n`

const page = (title) => `<!doctype html><title>${title}</title>`

// ---------------------------------------------------------------- parsing

test('parseSitemap reads every loc in a urlset', () => {
    const xml = sitemap(`${ORIGIN}/`, `${ORIGIN}/about`)
    assert.deepEqual(parseSitemap(xml), [`${ORIGIN}/`, `${ORIGIN}/about`])
})

test('parseSitemap returns an empty list for an empty urlset', () => {
    assert.deepEqual(parseSitemap('<urlset></urlset>'), [])
})

test('parseSitemap decodes XML entities in loc values', () => {
    const xml = sitemap(`${ORIGIN}/search?a=1&amp;b=2`)
    assert.deepEqual(parseSitemap(xml), [`${ORIGIN}/search?a=1&b=2`])
})

test('parseSitemap tolerates whitespace and a newline format', () => {
    const xml = '<urlset>\n <url>\n  <loc>\n   ' + `${ORIGIN}/x` + '\n  </loc>\n </url>\n</urlset>'
    assert.deepEqual(parseSitemap(xml), [`${ORIGIN}/x`])
})

// ---------------------------------------------------------------- mapping

test('urlToPrerenderPath maps the root to index.html', () => {
    assert.equal(urlToPrerenderPath('/'), 'index.html')
})

test('urlToPrerenderPath maps a flat route to <route>.html', () => {
    assert.equal(urlToPrerenderPath('/about'), 'about.html')
    assert.equal(urlToPrerenderPath('/products/lanfy/downloads'), 'products/lanfy/downloads.html')
})

test('urlToPrerenderPath ignores a trailing slash', () => {
    assert.equal(urlToPrerenderPath('/about/'), 'about.html')
})

test('prerenderPathToUrl is the inverse for ordinary pages', () => {
    assert.equal(prerenderPathToUrl('about.html'), '/about')
    assert.equal(prerenderPathToUrl('products/lanfy.html'), '/products/lanfy')
    assert.equal(prerenderPathToUrl('index.html'), '/')
})

test('prerenderPathToUrl excludes known extras', () => {
    assert.equal(prerenderPathToUrl('404.html'), null)
})

// ---------------------------------------------------------------- encoding

/*
 * A URL carries its percent-encoding; the file that backs it may be written
 * with the encoding or without it. The convention is not universal, so the
 * comparison is done on the decoded path and neither side gets to decide.
 */

test('decodePath decodes a percent-encoded segment', () => {
    assert.equal(decodePath('/docs/getting%20started'), '/docs/getting started')
})

test('decodePath decodes a multi-byte sequence as one character', () => {
    // `%E6%97%A5` is one character in UTF-8, not three. Decoding it escape
    // by escape would produce mojibake and no file would ever match.
    assert.equal(decodePath('/docs/%E6%97%A5%E6%9C%AC%E8%AA%9E'), '/docs/日本語')
})

test('decodePath leaves an encoded slash encoded', () => {
    // `%2F` is a slash inside a segment, not a separator between segments.
    assert.equal(decodePath('/docs/a%2Fb'), '/docs/a%2Fb')
})

test('decodePath leaves a segment it cannot decode alone', () => {
    // A stray `%` is not an escape sequence. Decoding it would throw, and a
    // file called `100%.html` is a perfectly ordinary name.
    assert.equal(decodePath('/100%.html'), '/100%.html')
})

test('urlToPrerenderPath decodes a percent-encoded path', () => {
    assert.equal(urlToPrerenderPath('/docs/getting%20started'), 'docs/getting started.html')
})

test('prerenderPathToUrl decodes a percent-encoded file name', () => {
    assert.equal(prerenderPathToUrl('docs/getting%20started.html'), '/docs/getting started')
})

test('a percent-encoded path and the file that backs it are the same page', () => {
    // The original defect. The two sides disagreed about encoding: the URL
    // kept the percent-encoding and the file did not, so one page was
    // reported as a 404 and as a stray file at the same time, and a correct
    // artifact was refused.
    const result = audit({
        advertised: [`${ORIGIN}/`, `${ORIGIN}/docs/getting%20started`],
        prerendered: ['index.html', 'docs/getting started.html'],
        origin: ORIGIN,
    })

    assert.equal(result.ok, true)
    assert.deepEqual(result.missing, [])
    assert.deepEqual(result.orphaned, [])
})

test('a build that writes percent-encoded file names is recognised too', () => {
    // The other convention. A fix that only decoded the URL would have fixed
    // the case above and broken this one - trading a false positive for a
    // false negative, which is the one trade this tool must not make.
    const result = audit({
        advertised: [`${ORIGIN}/`, `${ORIGIN}/docs/getting%20started`],
        prerendered: ['index.html', 'docs/getting%20started.html'],
        origin: ORIGIN,
    })

    assert.equal(result.ok, true)
    assert.deepEqual(result.missing, [])
    assert.deepEqual(result.orphaned, [])
})

test('an accented path is the same page whichever way it is written', () => {
    const result = audit({
        advertised: [`${ORIGIN}/`, `${ORIGIN}/docs/caf%C3%A9`],
        prerendered: ['index.html', 'docs/café.html'],
        origin: ORIGIN,
    })

    assert.equal(result.ok, true)
    assert.deepEqual(result.missing, [])
    assert.deepEqual(result.orphaned, [])
})

test('a non-Latin path is the same page whichever way it is written', () => {
    const result = audit({
        advertised: [`${ORIGIN}/`, `${ORIGIN}/docs/%E6%97%A5%E6%9C%AC%E8%AA%9E`],
        prerendered: ['index.html', 'docs/日本語.html'],
        origin: ORIGIN,
    })

    assert.equal(result.ok, true)
    assert.deepEqual(result.missing, [])
    assert.deepEqual(result.orphaned, [])
})

test('a sitemap may spell a path with raw characters instead of encoding it', () => {
    // A sitemap with a literal space or a literal accented character is not
    // strictly conformant, but the URL parser normalises it, and the file
    // that backs it still has to be found.
    const result = audit({
        advertised: [`${ORIGIN}/`, `${ORIGIN}/docs/café`],
        prerendered: ['index.html', 'docs/café.html'],
        origin: ORIGIN,
    })

    assert.equal(result.ok, true)
    assert.deepEqual(result.missing, [])
    assert.deepEqual(result.orphaned, [])
})

test('an encoded slash is not a path separator', () => {
    // `%2F` names one segment whose character is a slash. Decoding it would
    // turn `/docs/a%2Fb` into `/docs/a/b` and match it against a different
    // page's file, which is a false negative.
    const result = audit({
        advertised: [`${ORIGIN}/`, `${ORIGIN}/docs/a%2Fb`],
        prerendered: ['index.html', 'docs/a/b.html'],
        origin: ORIGIN,
    })

    assert.equal(result.ok, false)
    assert.equal(result.missing.length, 1)
    assert.equal(result.missing[0].expectedFile, 'docs/a%2Fb.html')
})

test('a file name with a stray percent sign is still found', () => {
    const result = audit({
        advertised: [`${ORIGIN}/`, `${ORIGIN}/100%25`],
        prerendered: ['index.html', '100%.html'],
        origin: ORIGIN,
    })

    assert.equal(result.ok, true)
    assert.deepEqual(result.missing, [])
    assert.deepEqual(result.orphaned, [])
})

test('an encoded path that was never built is still reported', () => {
    // The fix must not turn the check into a rubber stamp: a page that is
    // advertised and not built is still a 404, encoded or not.
    const result = audit({
        advertised: [`${ORIGIN}/`, `${ORIGIN}/docs/getting%20started`],
        prerendered: ['index.html'],
        origin: ORIGIN,
    })

    assert.equal(result.ok, false)
    assert.equal(result.missing.length, 1)
    assert.equal(result.missing[0].expectedFile, 'docs/getting started.html')
})

// ---------------------------------------------------------------- audit

test('a matching sitemap and build agree', () => {
    const result = audit({
        advertised: [`${ORIGIN}/`, `${ORIGIN}/about`],
        prerendered: ['index.html', 'about.html'],
        origin: ORIGIN,
    })

    assert.equal(result.ok, true)
    assert.deepEqual(result.missing, [])
    assert.deepEqual(result.orphaned, [])
})

test('an advertised URL with no prerendered file is reported', () => {
    // This is the failure that motivated the tool: the sitemap advertises a
    // route the build never produced, so the page will 404.
    const result = audit({
        advertised: [`${ORIGIN}/`, `${ORIGIN}/updates`, `${ORIGIN}/updates/entry`],
        prerendered: ['index.html'],
        origin: ORIGIN,
    })

    assert.equal(result.ok, false)
    assert.equal(result.missing.length, 2)
    assert.deepEqual(result.missing.map((m) => m.expectedFile), [
        'updates.html',
        'updates/entry.html',
    ])
})

test('a prerendered file missing from the sitemap is reported', () => {
    const result = audit({
        advertised: [`${ORIGIN}/`],
        prerendered: ['index.html', 'secret-admin.html'],
        origin: ORIGIN,
    })

    assert.equal(result.ok, false)
    assert.equal(result.orphaned.length, 1)
    assert.equal(result.orphaned[0].file, 'secret-admin.html')
})

test('404.html is not treated as an orphan', () => {
    const result = audit({
        advertised: [`${ORIGIN}/`],
        prerendered: ['index.html', '404.html'],
        origin: ORIGIN,
    })

    assert.equal(result.ok, true)
    assert.deepEqual(result.orphaned, [])
})

test('an offsite URL is reported and not counted as missing', () => {
    const result = audit({
        advertised: [`${ORIGIN}/`, 'https://elsewhere.test/about'],
        prerendered: ['index.html'],
        origin: ORIGIN,
    })

    assert.equal(result.ok, false)
    assert.equal(result.offsite.length, 1)
    assert.match(result.offsite[0].reason, /elsewhere\.test/)
    // Offsite URLs are a different problem from a missing file.
    assert.equal(result.missing.length, 0)
})

test('duplicate sitemap entries are reported', () => {
    const result = audit({
        advertised: [`${ORIGIN}/`, `${ORIGIN}/about`, `${ORIGIN}/about`],
        prerendered: ['index.html', 'about.html'],
        origin: ORIGIN,
    })

    assert.equal(result.ok, false)
    assert.equal(result.duplicates.length, 1)
    assert.equal(result.duplicates[0].count, 2)
})

test('a custom extra can be ignored', () => {
    const result = audit({
        advertised: [`${ORIGIN}/`],
        prerendered: ['index.html', 'search.html'],
        origin: ORIGIN,
        extras: ['search.html'],
    })

    assert.equal(result.ok, true)
})

// ---------------------------------------------------------------- reporting

test('formatReport lists the specific missing file for each failure', () => {
    const result = audit({
        advertised: [`${ORIGIN}/updates`],
        prerendered: ['index.html'],
        origin: ORIGIN,
    })

    const output = formatReport(result)

    assert.match(output, /advertised but NOT prerendered/)
    assert.match(output, /updates\.html/)
    assert.match(output, /advertised in sitemap : 1/)
})

test('an empty sitemap is NOT reported as agreement', () => {
    // Found by running this against a real site during an origin outage: the
    // fetch returned an HTTP 522 error page containing no <loc> elements, so
    // zero URLs trivially matched zero files and the tool reported OK.
    //
    // A safety check that passes on garbage is worse than no check, because it
    // gets read as an all-clear.
    const result = audit({ advertised: [], prerendered: [], origin: ORIGIN })

    assert.equal(result.ok, false)
    assert.equal(result.unusable.length, 2)
    assert.match(result.unusable[0], /sitemap contains no URLs/)
    assert.match(result.unusable[1], /no prerendered .html files/)
})

test('a sitemap with URLs but no built files is refused', () => {
    const result = audit({
        advertised: [`${ORIGIN}/`],
        prerendered: [],
        origin: ORIGIN,
    })

    assert.equal(result.ok, false)
    assert.equal(result.unusable.length, 1)
    assert.match(result.unusable[0], /right directory/)
})

test('an HTTP error page in place of a sitemap is refused', () => {
    // What actually happened: a Cloudflare 522 body written to sitemap.xml.
    const body = 'error code: 522'

    const result = audit({
        advertised: parseSitemap(body),
        prerendered: ['index.html'],
        origin: ORIGIN,
    })

    assert.equal(result.ok, false)
    assert.equal(result.unusable.length, 1)
    assert.match(result.unusable[0], /sitemap contains no URLs/)
})

test('formatReport marks unusable input distinctly from a mismatch', () => {
    const output = formatReport(audit({ advertised: [], prerendered: [], origin: ORIGIN }))

    assert.match(output, /INPUT UNUSABLE/)
    assert.doesNotMatch(output, /advertised but NOT prerendered/)
})

// ---------------------------------------------------------------- cli argument validation

const CLI_PATH = fileURLToPath(new URL('../prerender-audit.mjs', import.meta.url))

for (const option of ['--sitemap', '--origin', '--extra']) {
    test(`CLI rejects ${option} without a value`, () => {
        const result = spawnSync(process.execPath, [CLI_PATH, '.', option], {
            encoding: 'utf8',
        })

        assert.equal(result.status, 2)
        assert.match(result.stderr, new RegExp(`option "${option}" requires a value`))
    })
}

test('CLI rejects an invalid --origin URL as a bad invocation', async () => {
    const f = await fixture({
        'sitemap.xml': sitemap(`${ORIGIN}/`),
        'index.html': page('home'),
    })

    try {
        const result = spawnSync(process.execPath, [CLI_PATH, f.dir, '--origin', 'not a URL'], {
            encoding: 'utf8',
        })

        assert.equal(result.status, 2)
        assert.match(result.stderr, /invalid --origin URL/)
    } finally {
        await f.cleanup()
    }
})

test('CLI rejects non-HTTP(S) --origin protocols', async () => {
    const f = await fixture({
        'sitemap.xml': sitemap(`${ORIGIN}/`),
        'index.html': page('home'),
    })

    try {
        const result = spawnSync(process.execPath, [CLI_PATH, f.dir, '--origin', 'file:///tmp/site'], {
            encoding: 'utf8',
        })

        assert.equal(result.status, 2)
        assert.match(result.stderr, /Only HTTP\(S\) origins are supported/)
    } finally {
        await f.cleanup()
    }
})

test('the CLI runs when reached through a symlink, as npm installs it', async () => {
    // On Linux and macOS npm installs a bin entry as a symlink to this file.
    //
    // The entry guard used to compare names, which does not match across a
    // symlink, so main() never ran and the command exited 0 without auditing
    // anything. In CI that means `npx prerender-audit` passes on a broken
    // build, which is the single most damaging way this tool could misbehave.
    const f = await fixture({
        'sitemap.xml': sitemap(`${ORIGIN}/`, `${ORIGIN}/updates`),
        'index.html': page('home'),
    })

    try {
        const link = path.join(f.dir, 'linked-audit')
        symlinkSync(path.join(REPO, 'prerender-audit.mjs'), link)

        const result = spawnSync(process.execPath, [link, f.dir, '--origin', ORIGIN], {
            encoding: 'utf8',
        })

        assert.equal(
            result.status,
            1,
            'running through a symlink must still perform the audit and exit 1 on a mismatch',
        )
        assert.match(result.stdout, /advertised but NOT prerendered/)
    } finally {
        await f.cleanup()
    }
})

test('importing the module does not execute the CLI', async () => {
    // The other half of the guard: a library import must stay side-effect free.
    const imported = await import('../prerender-audit.mjs')

    assert.equal(typeof imported.audit, 'function')
    assert.equal(typeof imported.formatReport, 'function')
})

// ---------------------------------------------------------------- end to end

test('reads a real directory tree on disk', async () => {
    const f = await fixture({
        'sitemap.xml': sitemap(`${ORIGIN}/`, `${ORIGIN}/about`, `${ORIGIN}/products/lanfy`),
        'index.html': page('home'),
        'about.html': page('about'),
        'products/lanfy.html': page('LanFy'),
        '404.html': page('not found'),
    })

    try {
        const { readFile, readdir } = await import('node:fs/promises')
        const advertised = parseSitemap(await readFile(path.join(f.dir, 'sitemap.xml'), 'utf8'))

        const collected = []
        const walk = async (dir) => {
            for (const e of await readdir(dir, { withFileTypes: true })) {
                const full = path.join(dir, e.name)
                if (e.isDirectory()) await walk(full)
                else if (e.name.endsWith('.html')) collected.push(path.relative(f.dir, full).replace(/\\/g, '/'))
            }
        }
        await walk(f.dir)

        const result = audit({ advertised, prerendered: collected.sort(), origin: ORIGIN })

        assert.equal(result.ok, true)
    } finally {
        await f.cleanup()
    }
})

test('detects the real defect: sitemap grew but the build did not', async () => {
    // Reproduces the shape of the production incident: the sitemap gained two
    // URLs while the prerendered output gained none.
    const f = await fixture({
        'sitemap.xml': sitemap(`${ORIGIN}/`, `${ORIGIN}/updates`, `${ORIGIN}/updates/first-entry`),
        'index.html': page('home'),
        '404.html': page('not found'),
    })

    try {
        const { readFile, readdir } = await import('node:fs/promises')
        const advertised = parseSitemap(await readFile(path.join(f.dir, 'sitemap.xml'), 'utf8'))
        const collected = (await readdir(f.dir))
            .filter((n) => n.endsWith('.html'))
            .sort()

        const result = audit({ advertised, prerendered: collected, origin: ORIGIN })

        assert.equal(result.ok, false)
        assert.equal(result.missing.length, 2)
    } finally {
        await f.cleanup()
    }
})