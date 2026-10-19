#!/usr/bin/env node
/**
 * prerender-audit
 *
 * Verify that a static site's sitemap and its prerendered output describe the
 * same set of pages.
 *
 * THE PROBLEM
 * -----------
 * Static site generators split into two independent outputs: the prerendered
 * HTML that is actually served, and the sitemap that tells the world those URLs
 * exist. Nothing forces them to agree.
 *
 * When a route is advertised but never prerendered, the page returns 404. This
 * is silent in every local build: the dev server resolves the route from the
 * router, so it appears to work. It surfaces only after deploy, on real URLs,
 * usually as a broken link or a search-engine crawl error.
 *
 * A real instance of exactly this: a content-management change added a new
 * top-level collection to the public payload. The sitemap generator reads the
 * raw CMS snapshot, but the router reads the same data through a sanitising
 * function that rebuilt the payload key by key. A key was added to the payload
 * and the type, but not to the sanitiser, so it was silently dropped on the way
 * to the router. The sitemap advertised two URLs, the build prerendered zero of
 * them, and the deploy's post-promotion check refused to promote the artifact
 * and restored the previous release. The site was never broken - but the same
 * defect without that check would have shipped a 404 into a sitemap.
 *
 * THE CHECKS
 * ----------
 *   advertised   every sitemap URL has a prerendered file behind it
 *   orphaned     every prerendered file is advertised, excluding known extras
 *   offsite      no sitemap URL points at another origin
 *   duplicates   no URL appears twice in the sitemap
 *
 * WHY A COMMAND-LINE TOOL
 * -----------------------
 * The deploy host already verifies URLs after promoting. This is for the case
 * that check cannot cover: reviewing an artifact before it is promoted, in CI,
 * or during a build, where a rollback is cheap because nothing has shipped.
 *
 * Zero dependencies, on purpose. A safety check that needs its own supply chain
 * is one more thing that can fail during an incident.
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

/** Files that legitimately exist without being listed in the sitemap. */
const DEFAULT_EXTRAS = ['404.html']

// ---------------------------------------------------------------- sitemap

/**
 * Pull `<loc>` values out of a sitemap.
 *
 * Deliberately a small regex rather than an XML dependency: sitemaps are
 * machine-generated, and a dependency here would be a dependency that can fail
 * in the middle of an incident. Handles both a urlset and a sitemapindex
 * document, because both declare `loc` in the same namespace.
 */
export function parseSitemap(xml) {
    const urls = []
    const pattern = /<loc>\s*([^<]+?)\s*<\/loc>/gi
    let match
    while ((match = pattern.exec(xml)) !== null) {
        urls.push(decodeXmlEntities(match[1]).trim())
    }
    return urls
}

function decodeXmlEntities(value) {
    return value
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&')
}

// ---------------------------------------------------------------- paths

/**
 * Turn a URL into the prerendered file that should back it.
 *
 * `/` becomes `index.html`, `/about` becomes `about.html`,
 * `/products/lanfy/downloads` becomes `products/lanfy/downloads.html`.
 * That mapping is the convention every mainstream SSG uses for a flat output
 * directory, which is what makes this checkable at all.
 */
export function urlToPrerenderPath(urlPath) {
    const clean = urlPath.replace(/\/+$/, '')
    const relative = clean === '' ? 'index.html' : `${clean.replace(/^\//, '')}.html`
    return relative
}

/**
 * Reverse mapping: which prerendered files should be advertised?
 *
 * `index.html` is the site root, and `404.html` is an error document that is
 * deliberately not a crawlable URL.
 */
export function prerenderPathToUrl(relative, extras = DEFAULT_EXTRAS) {
    const normalised = relative.replace(/\\/g, '/')
    if (extras.includes(normalised)) return null
    if (normalised === 'index.html') return '/'
    return '/' + normalised.replace(/\.html$/i, '')
}

// ---------------------------------------------------------------- walking

async function walkHtmlFiles(dir, base = dir, found = []) {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
            await walkHtmlFiles(full, base, found)
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.html')) {
            found.push(path.relative(base, full).replace(/\\/g, '/'))
        }
    }
    return found
}

// ---------------------------------------------------------------- audit

/**
 * @returns {{
 *   ok: boolean,
 *   advertised: string[],
 *   prerendered: string[],
 *   missing: Array<{url: string, expectedFile: string}>,
 *   orphaned: Array<{url: string, file: string}>,
 *   offsite: Array<{url: string, reason: string}>,
 *   duplicates: Array<{url: string, count: number}>,
 * }}
 */
export function audit({ advertised, prerendered, origin, extras = DEFAULT_EXTRAS }) {
    const missing = []
    const offsite = []
    const duplicates = []
    const orphaned = []
    const unusable = []

    /*
     * Empty input is never agreement.
     *
     * Found by running this against a real site during an origin outage: the
     * fetch returned an HTTP 522 error page, the sitemap parser found no <loc>
     * elements, and the tool cheerfully reported OK because zero URLs trivially
     * match zero files.
     *
     * A safety check that passes on garbage is worse than no check, because it
     * is read as an all-clear. Zero advertised URLs, or zero prerendered files,
     * almost always means a failed fetch or the wrong directory - both of which
     * this tool would otherwise have signed off.
     */
    if (advertised.length === 0) {
        unusable.push('the sitemap contains no URLs - was the file fetched correctly?')
    }
    if (prerendered.length === 0) {
        unusable.push('no prerendered .html files were found - is this the right directory?')
    }

    // --- advertised: must have a file, and must belong to this origin -------
    const seen = new Map()
    for (const url of advertised) {
        seen.set(url, (seen.get(url) ?? 0) + 1)

        let parsed
        try {
            parsed = new URL(url)
        } catch {
            offsite.push({ url, reason: 'not a valid absolute URL' })
            continue
        }

        if (origin && parsed.origin !== origin) {
            offsite.push({ url, reason: `points at ${parsed.origin}, expected ${origin}` })
            continue
        }

        const expectedFile = urlToPrerenderPath(parsed.pathname)
        if (!prerendered.includes(expectedFile)) {
            missing.push({ url, expectedFile })
        }
    }

    for (const [url, count] of seen) {
        if (count > 1) duplicates.push({ url, count })
    }

    // --- prerendered: should be advertised, unless it is a known extra -----
    const advertisedPaths = new Set()
    for (const url of advertised) {
        try {
            advertisedPaths.add(urlToPrerenderPath(new URL(url).pathname))
        } catch {
            /* already reported as offsite */
        }
    }

    for (const file of prerendered) {
        if (extras.includes(file)) continue
        if (advertisedPaths.has(file)) continue
        orphaned.push({ url: prerenderPathToUrl(file), file })
    }

    return {
        ok:
            unusable.length === 0 &&
            missing.length === 0 &&
            orphaned.length === 0 &&
            offsite.length === 0 &&
            duplicates.length === 0,
        advertised,
        prerendered,
        unusable,
        missing,
        orphaned,
        offsite,
        duplicates,
    }
}

// ---------------------------------------------------------------- cli

const COLOURS = {
    reset: '[0m',
    red: '[31m',
    green: '[32m',
    yellow: '[33m',
    dim: '[2m',
}

function colour(name, text) {
    if (process.env.NO_COLOR) return text
    return `${COLOURS[name]}${text}${COLOURS.reset}`
}

export function formatReport(result) {
    const lines = []
    const label = (name, entries, describe) => {
        if (entries.length === 0) return
        lines.push('')
        lines.push(colour('red', `  ${entries.length} ${name}`))
        for (const entry of entries.slice(0, 25)) lines.push(`    ${describe(entry)}`)
        if (entries.length > 25) {
            lines.push(`    ... and ${entries.length - 25} more`)
        }
    }

    lines.push(`  advertised in sitemap : ${result.advertised.length}`)
    lines.push(`  prerendered files     : ${result.prerendered.length}`)

    if (result.unusable.length > 0) {
        lines.push('')
        lines.push(colour('red', '  INPUT UNUSABLE - this is not evidence of agreement'))
        for (const reason of result.unusable) lines.push(`    ${reason}`)
    }

    label(
        'advertised but NOT prerendered (these would 404)',
        result.missing,
        (e) => `${e.url}\n      expected file: ${e.expectedFile}`,
    )
    label('prerendered but not advertised', result.orphaned, (e) => `${e.file}  (${e.url})`)
    label('offsite or malformed URL', result.offsite, (e) => `${e.url}\n      ${e.reason}`)
    label('duplicate sitemap entries', result.duplicates, (e) => `${e.url}  x${e.count}`)

    return lines.join('\n')
}

function usage(message) {
    console.error(`prerender-audit: ${message}\n`)
    console.error('Usage:')
    console.error('  prerender-audit <dist-dir> [options]\n')
    console.error('Options:')
    console.error('  --sitemap <file>   Path to sitemap.xml (default: <dist-dir>/sitemap.xml)')
    console.error('  --origin <url>     Expected origin for every sitemap URL')
    console.error('  --extra <file>     Extra prerendered file to ignore (repeatable)')
    console.error('  --json             Machine-readable output on stdout')
    console.error('  --help             This message\n')
    console.error('Exit codes: 0 agreement, 1 mismatch, 2 bad invocation.')
}

async function main(argv) {
    const args = argv.slice(2)

    if (args.includes('--help') || args.includes('-h')) {
        usage('check that a sitemap and a prerendered build describe the same pages.')
        return 0
    }

    const positional = []
    const extras = []
    let sitemap = null
    let origin = null
    let asJson = false

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]

        if (arg === '--sitemap' || arg === '--origin' || arg === '--extra') {
            const value = args[i + 1]
            if (!value || value.startsWith('--')) {
                usage(`option "${arg}" requires a value.`)
                return 2
            }

            i += 1
            if (arg === '--sitemap') sitemap = value
            else if (arg === '--origin') origin = value
            else extras.push(value)
        } else if (arg === '--json') asJson = true
        else if (arg.startsWith('-')) {
            usage(`unknown option "${arg}".`)
            return 2
        } else positional.push(arg)
    }

    const dir = positional[0]
    if (!dir) {
        usage('a dist directory is required.')
        return 2
    }
    if (!existsSync(dir)) {
        console.error(`prerender-audit: "${dir}" does not exist.`)
        return 2
    }

    const sitemapPath = sitemap ?? path.join(dir, 'sitemap.xml')
    if (!existsSync(sitemapPath)) {
        console.error(`prerender-audit: no sitemap at "${sitemapPath}".`)
        console.error('Pass --sitemap if it lives elsewhere.')
        return 2
    }

    const advertised = parseSitemap(await readFile(sitemapPath, 'utf8'))
    const prerendered = (await walkHtmlFiles(dir)).sort()

    let expectedOrigin = null
    if (origin) {
        let parsedOrigin
        try {
            parsedOrigin = new URL(origin)
        } catch {
            usage(`invalid --origin URL "${origin}". Expected an absolute HTTP(S) URL.`)
            return 2
        }

        if (!['http:', 'https:'].includes(parsedOrigin.protocol)) {
            usage(`invalid --origin URL "${origin}". Only HTTP(S) origins are supported.`)
            return 2
        }
        expectedOrigin = parsedOrigin.origin
    }

    const result = audit({
        advertised,
        prerendered,
        origin: expectedOrigin,
        extras: extras.length ? extras : DEFAULT_EXTRAS,
    })

    if (asJson) {
        console.log(JSON.stringify(result, null, 2))
    } else {
        console.log(`prerender-audit: ${dir}`)
        console.log(formatReport(result))
        console.log('')
        if (result.unusable.length > 0) {
            console.log(
                colour(
                    'red',
                    '  CANNOT VERIFY  the inputs are not usable. Do not read this as a pass.',
                ),
            )
        } else {
            console.log(
                result.ok
                    ? colour('green', '  OK  sitemap and prerendered output agree.')
                    : colour('red', '  MISMATCH  do not promote this artifact.'),
            )
        }
    }

    return result.ok ? 0 : 1
}

// Only run the CLI when executed directly, so the audit stays importable.
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
    main(process.argv).then((code) => {
        process.exit(code)
    })
}