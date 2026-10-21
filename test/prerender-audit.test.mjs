import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, stat, symlink } from 'node:fs/promises'
import { existsSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

import {
    parseSitemap,
    urlToPrerenderPath,
    prerenderPathToUrl,
    audit,
    formatReport,
    walkHtmlFiles,
} from '../prerender-audit.mjs'

/**
 * Tests use node:test, which ships with Node. There is no test dependency to
 * install, so `node --test` works on a bare checkout with no npm install. For a
 * safety check that people are meant to run during a build, that matters.
 */

const ORIGIN = 'https://example.test'

/**
 * Build a throwaway dist directory from a {file: contents} map.
 *
 * A value of `{ symlink: 'target' }` creates a symlink instead of a file, so
 * the walk can be exercised against a build that really contains links.
 * `type` is 'file' or 'dir' and only means anything on Windows.
 *
 * Making a link is privileged on Windows and unprivileged on Linux and
 * macOS, so a fixture that needs one records why it could not be made
 * instead of throwing: the test can then skip itself and say why, rather
 * than failing on a machine that simply cannot create a link.
 */
async function fixture(files) {
    const dir = await mkdtemp(path.join(tmpdir(), 'prerender-audit-'))
    let skipReason = null
    for (const [relative, contents] of Object.entries(files)) {
        const full = path.join(dir, relative)
        await mkdir(path.dirname(full), { recursive: true })
        if (contents && typeof contents === 'object' && 'symlink' in contents) {
            try {
                await symlink(contents.symlink, full, contents.type ?? 'file')
            } catch (error) {
                skipReason = `symlinks cannot be created in this environment: ${error.code ?? error.message}`
            }
            continue
        }
        await writeFile(full, contents)
    }
    return {
        dir,
        skipReason,
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

// ---------------------------------------------------------------- walking

/*
 * A symlink is a ROUTE of its own.
 *
 * `readdir(dir, { withFileTypes: true })` describes the LINK, not the target,
 * so `entry.isFile()` and `entry.isDirectory()` are both false for a symlink
 * and the entry used to be skipped entirely. The tool then reported a page
 * that was being served as a 404, and pointed the investigation at the
 * wrong file.
 *
 * The rule these tests encode: when a build serves `linked.html` as a link
 * to `_real.html`, it serves BOTH `/linked` and `/_real`. Both are in-build
 * logical paths, so both are subject to sitemap coverage, and neither may be
 * hidden by the other.
 */

test('a prerendered page delivered as a symlink is found by the walk', async (t) => {
    const f = await fixture({
        'index.html': page('home'),
        '_real.html': page('real'),
        'linked.html': { symlink: '_real.html' },
    })
    if (f.skipReason) return t.skip(f.skipReason)

    try {
        const collected = await walkHtmlFiles(f.dir)

        assert.ok(collected.includes('linked.html'), 'the linked page must be found')
        assert.ok(collected.includes('_real.html'), 'the target must still be found')

        const result = audit({
            advertised: [`${ORIGIN}/`, `${ORIGIN}/linked`],
            prerendered: collected,
            origin: ORIGIN,
        })

        assert.deepEqual(result.missing, [], 'a page that is served must not be reported as a 404')
    } finally {
        await f.cleanup()
    }
})

test('the target of a linked page stays an orphan in its own right', async (t) => {
    // The other half of the rule, and the reason the issue's "exit code 0"
    // acceptance criterion is wrong.
    //
    // `_real.html` is a real file in the build, so the site serves `/_real`
    // whether or not anything links to it. It is a genuine unadvertised
    // route, so it stays an orphan. Hiding it because a symlink points at it
    // would trade a false positive for a false negative, and the false
    // negative is the worse of the two: it is the one nobody looks for.
    const f = await fixture({
        'index.html': page('home'),
        '_real.html': page('real'),
        'linked.html': { symlink: '_real.html' },
    })
    if (f.skipReason) return t.skip(f.skipReason)

    try {
        const collected = await walkHtmlFiles(f.dir)

        const result = audit({
            advertised: [`${ORIGIN}/`, `${ORIGIN}/linked`],
            prerendered: collected,
            origin: ORIGIN,
        })

        assert.equal(result.ok, false, 'an unadvertised page is still a mismatch')
        assert.equal(result.orphaned.length, 1)
        assert.equal(result.orphaned[0].file, '_real.html')
        assert.equal(result.orphaned[0].url, '/_real')
        assert.deepEqual(result.missing, [])
    } finally {
        await f.cleanup()
    }
})

test('a build that delivers a page as a symlink exits 1 and names the real orphan', async (t) => {
    // The CLI level of the same decision: the false "would 404" is gone, and
    // the one report that is left is the true one.
    const f = await fixture({
        'sitemap.xml': sitemap(`${ORIGIN}/`, `${ORIGIN}/linked`),
        'index.html': page('home'),
        '_real.html': page('real'),
        'linked.html': { symlink: '_real.html' },
    })
    if (f.skipReason) return t.skip(f.skipReason)

    try {
        const result = spawnSync(process.execPath, [CLI_PATH, f.dir, '--origin', ORIGIN], {
            encoding: 'utf8',
        })

        assert.equal(result.status, 1)
        assert.doesNotMatch(result.stdout, /advertised but NOT prerendered/)
        assert.match(result.stdout, /_real\.html/)
    } finally {
        await f.cleanup()
    }
})

test('a symlinked directory is walked and keeps its logical child paths', async (t) => {
    const f = await fixture({
        'index.html': page('home'),
        'real/child.html': page('child'),
        'alias': { symlink: 'real', type: 'dir' },
    })
    if (f.skipReason) return t.skip(f.skipReason)

    try {
        const collected = await walkHtmlFiles(f.dir)

        assert.ok(collected.includes('alias/child.html'), 'the linked directory must be walked')
        assert.ok(collected.includes('real/child.html'), 'the real directory must still be walked')
        assert.ok(!collected.includes('child.html'), 'a child must keep its parent in its path')
    } finally {
        await f.cleanup()
    }
})

test('several aliases of one target are all collected and reported separately', async (t) => {
    const f = await fixture({
        'index.html': page('home'),
        'real.html': page('real'),
        'a.html': { symlink: 'real.html' },
        'b.html': { symlink: 'real.html' },
    })
    if (f.skipReason) return t.skip(f.skipReason)

    try {
        const collected = await walkHtmlFiles(f.dir)

        // Three routable paths, one file. All three have to be collected:
        // dropping one would hide a page the sitemap is allowed to advertise.
        assert.deepEqual(collected.sort(), ['a.html', 'b.html', 'index.html', 'real.html'])

        const result = audit({
            advertised: [`${ORIGIN}/`, `${ORIGIN}/a`],
            prerendered: collected,
            origin: ORIGIN,
        })

        assert.deepEqual(result.missing, [])
        assert.deepEqual(
            result.orphaned.map((o) => o.file).sort(),
            ['b.html', 'real.html'],
            'each alias is reported on its own',
        )
    } finally {
        await f.cleanup()
    }
})

test('a symlink loop does not hang the walk', async (t) => {
    const f = await fixture({
        'index.html': page('home'),
        'self.html': { symlink: 'self.html' },
        'loop': { symlink: 'loop', type: 'dir' },
    })
    if (f.skipReason) return t.skip(f.skipReason)

    try {
        // No timeout on the test itself: a walk that does not terminate takes
        // the whole run down with it, which is exactly the failure to catch.
        const collected = await walkHtmlFiles(f.dir)

        assert.deepEqual(collected, ['index.html'])
    } finally {
        await f.cleanup()
    }
})

test('a symlink back to an ancestor is skipped', async (t) => {
    const f = await fixture({
        'index.html': page('home'),
        'sub/child.html': page('child'),
        'sub/back': { symlink: '..', type: 'dir' },
    })
    if (f.skipReason) return t.skip(f.skipReason)

    try {
        const collected = await walkHtmlFiles(f.dir)

        assert.deepEqual(collected.sort(), ['index.html', 'sub/child.html'])
    } finally {
        await f.cleanup()
    }
})

test('a dangling symlink is an absent page, not an unhandled error', async (t) => {
    const f = await fixture({
        'index.html': page('home'),
        'gone.html': { symlink: 'nothing-here.html' },
    })
    if (f.skipReason) return t.skip(f.skipReason)

    const rejections = []
    const onRejection = (reason) => rejections.push(reason)
    process.on('unhandledRejection', onRejection)

    try {
        const collected = await walkHtmlFiles(f.dir)

        assert.deepEqual(collected, ['index.html'], 'a link to nowhere is not a page')

        const result = audit({
            advertised: [`${ORIGIN}/`, `${ORIGIN}/gone`],
            prerendered: collected,
            origin: ORIGIN,
        })

        assert.equal(result.missing.length, 1)
        assert.equal(result.missing[0].expectedFile, 'gone.html')

        // An unhandled rejection is delivered on a later tick, so give it one.
        await new Promise((resolve) => setImmediate(resolve))
        assert.deepEqual(rejections, [], 'the walk must not leave a rejection unhandled')
    } finally {
        process.off('unhandledRejection', onRejection)
        await f.cleanup()
    }
})

test('an ENOENT or ELOOP link is skipped without throwing', async (t) => {
    const f = await fixture({
        'index.html': page('home'),
        'dangling.html': { symlink: 'not-here.html' },
        'loop.html': { symlink: 'loop.html' },
    })
    if (f.skipReason) return t.skip(f.skipReason)

    try {
        // Pin the failures the walk has to survive, so the test states what
        // it is pinning rather than only "it did not crash".
        await assert.rejects(() => stat(path.join(f.dir, 'dangling.html')), { code: 'ENOENT' })
        await assert.rejects(() => stat(path.join(f.dir, 'loop.html')), { code: 'ELOOP' })

        const collected = await walkHtmlFiles(f.dir)

        assert.deepEqual(collected, ['index.html'])
    } finally {
        await f.cleanup()
    }
})

test('a symlink out of the build root is not walked into', async (t) => {
    const outside = await mkdtemp(path.join(tmpdir(), 'prerender-audit-outside-'))
    await writeFile(path.join(outside, 'secret.html'), page('secret'))

    const f = await fixture({
        'index.html': page('home'),
        'elsewhere': { symlink: outside, type: 'dir' },
    })
    if (f.skipReason) {
        await rm(outside, { recursive: true, force: true })
        return t.skip(f.skipReason)
    }

    try {
        const collected = await walkHtmlFiles(f.dir)

        assert.deepEqual(collected, ['index.html'], 'a directory outside the build is not this build')
    } finally {
        await f.cleanup()
    }

    // Cleaning up the build must not have followed the link out of it.
    assert.ok(existsSync(path.join(outside, 'secret.html')), 'the tree outside the build is untouched')
    await rm(outside, { recursive: true, force: true })
})

test('directory aliases give the same result whichever order they are visited in', async (t) => {
    // Two aliases of one directory are two routable paths. A walk that
    // remembered the directories it had already resolved would report one
    // alias and not the other, depending on the order the filesystem
    // happened to list them - and directory order is not something a
    // promotion gate may depend on.
    const forward = await fixture({
        'index.html': page('home'),
        'real/child.html': page('child'),
        'a-alias': { symlink: 'real', type: 'dir' },
        'z-alias': { symlink: 'real', type: 'dir' },
    })
    const backward = await fixture({
        'index.html': page('home'),
        'real/child.html': page('child'),
        'z-alias': { symlink: 'real', type: 'dir' },
        'a-alias': { symlink: 'real', type: 'dir' },
    })
    if (forward.skipReason || backward.skipReason) {
        await forward.cleanup()
        await backward.cleanup()
        return t.skip(forward.skipReason ?? backward.skipReason)
    }

    const expected = ['a-alias/child.html', 'index.html', 'real/child.html', 'z-alias/child.html']

    try {
        assert.deepEqual((await walkHtmlFiles(forward.dir)).sort(), expected)
        assert.deepEqual((await walkHtmlFiles(backward.dir)).sort(), expected)
    } finally {
        await forward.cleanup()
        await backward.cleanup()
    }
})

test('ordinary files are still found and a genuinely missing page is still reported', async (t) => {
    const f = await fixture({
        'index.html': page('home'),
        'about.html': page('about'),
        'products/lanfy.html': page('LanFy'),
    })

    try {
        const collected = await walkHtmlFiles(f.dir)

        assert.deepEqual(collected.sort(), ['about.html', 'index.html', 'products/lanfy.html'])

        const result = audit({
            advertised: [`${ORIGIN}/`, `${ORIGIN}/updates`],
            prerendered: collected,
            origin: ORIGIN,
        })

        assert.equal(result.ok, false)
        assert.equal(result.missing.length, 1)
        assert.equal(result.missing[0].expectedFile, 'updates.html')
    } finally {
        await f.cleanup()
    }
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
        const { readFile } = await import('node:fs/promises')
        const advertised = parseSitemap(await readFile(path.join(f.dir, 'sitemap.xml'), 'utf8'))

        // The production walk, not a copy of it: a copy would keep passing
        // while the shipped walk was wrong.
        const collected = await walkHtmlFiles(f.dir)

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