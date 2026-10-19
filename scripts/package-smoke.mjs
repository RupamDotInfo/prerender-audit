#!/usr/bin/env node
/**
 * Package-level smoke test.
 *
 * WHY THIS EXISTS, SEPARATE FROM THE UNIT TESTS
 * ---------------------------------------------
 * `node --test` imports the source module and calls its functions. It would
 * keep passing if the `bin` entry were misspelled, if the shebang were
 * removed, if the file were excluded from the published tarball, or if the
 * "run only when executed directly" guard stopped firing.
 *
 * Those are exactly the defects that make a package unusable after publishing,
 * and none of them are visible to a test that imports the module directly.
 *
 * So this packs the real tarball with `npm pack`, installs it into a throwaway
 * project, and invokes the *installed* command the way a consumer would. What
 * it runs is the artifact, not the working tree.
 *
 * Zero dependencies: it uses npm, which any consumer of a Node package has.
 *
 * Usage:  node scripts/package-smoke.mjs
 * Exit:   0 all checks passed, 1 something is wrong with the packaged artifact.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const failures = []
let checks = 0

function check(label, condition, detail = '') {
    checks++
    if (!condition) failures.push(label + (detail ? ` (${detail})` : ''))
    console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail && !condition ? ` — ${detail}` : ''}`)
}

function sh(command, args, cwd) {
    return execFileSync(command, args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
    })
}

function exitCode(command, args, cwd) {
    try {
        sh(command, args, cwd)
        return 0
    } catch (error) {
        // execFileSync throws on a non-zero exit; the code is what we want.
        return typeof error.status === 'number' ? error.status : 1
    }
}

const workspace = mkdtempSync(path.join(tmpdir(), 'prerender-audit-smoke-'))

try {
    console.log(`prerender-audit package smoke test\n  workspace: ${workspace}\n`)

    // ---- 1. pack ------------------------------------------------------------
    console.log('1. pack')
    const packed = sh('npm', ['pack', '--pack-destination', workspace], ROOT).trim().split('\n').pop().trim()
    const tarball = path.join(workspace, packed)
    check('npm pack produced a tarball', existsSync(tarball), tarball)

    // ---- 2. the tarball must actually contain the CLI ----------------------
    console.log('\n2. tarball contents')
    const listing = sh('tar', ['-tzf', tarball], workspace)
    for (const required of ['package/prerender-audit.mjs', 'package/package.json', 'package/README.md']) {
        check(`contains ${required}`, listing.includes(required))
    }

    // ---- 3. install into a clean project -----------------------------------
    console.log('\n3. install into a clean project')
    const consumer = path.join(workspace, 'consumer')
    mkdirSync(consumer, { recursive: true })
    writeFileSync(
        path.join(consumer, 'package.json'),
        JSON.stringify({ name: 'smoke-consumer', private: true, version: '1.0.0' }),
    )
    const installCode = exitCode('npm', ['install', '--silent', '--no-audit', '--no-fund', tarball], consumer)
    check('npm install <tarball> succeeded', installCode === 0, `exit ${installCode}`)

    const installed = path.join(consumer, 'node_modules', 'prerender-audit', 'prerender-audit.mjs')
    check('the CLI is present in node_modules', existsSync(installed), installed)

    const shebang = existsSync(installed)
        ? readFileSync(installed, 'utf8').split('\n')[0].trim()
        : ''
    check('the installed CLI keeps its shebang', shebang.startsWith('#!'), shebang)

    // ---- 4. fixtures --------------------------------------------------------
    console.log('\n4. run the installed command')
    const healthy = path.join(consumer, 'healthy')
    mkdirSync(healthy, { recursive: true })
    writeFileSync(
        path.join(healthy, 'sitemap.xml'),
        `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>https://example.test/</loc></url>\n  <url><loc>https://example.test/about</loc></url>\n</urlset>\n`,
    )
    writeFileSync(path.join(healthy, 'index.html'), '<html><title>home</title></html>')
    writeFileSync(path.join(healthy, 'about.html'), '<html><title>about</title></html>')
    writeFileSync(path.join(healthy, '404.html'), '<html><title>404</title></html>')

    const broken = path.join(consumer, 'broken')
    mkdirSync(broken, { recursive: true })
    writeFileSync(
        path.join(broken, 'sitemap.xml'),
        `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>https://example.test/</loc></url>\n  <url><loc>https://example.test/updates</loc></url>\n</urlset>\n`,
    )
    writeFileSync(path.join(broken, 'index.html'), '<html><title>home</title></html>')

    const unusable = path.join(consumer, 'unusable')
    mkdirSync(unusable, { recursive: true })
    writeFileSync(path.join(unusable, 'sitemap.xml'), 'error code: 522')

    const run = (dir, extra = []) => exitCode('node', [installed, dir, ...extra], consumer)

    check('healthy build exits 0', run(healthy, ['--origin', 'https://example.test']) === 0)
    check('advertised-but-unbuilt build exits 1', run(broken, ['--origin', 'https://example.test']) === 1)
    check('unusable input exits 1, never 0', run(unusable) === 1)
    check('missing directory exits 2', run(path.join(consumer, 'nope')) === 2)

    // ---- 5. the installed command must produce real output ------------------
    console.log('\n5. the command really runs, not just imports')
    const output = sh('node', [installed, healthy, '--origin', 'https://example.test'], consumer)
    check('prints a verdict', /sitemap and prerendered output agree/.test(output))
    // Two advertised URLs; three prerendered files (index, about, and the
    // 404 document, which is present but deliberately not advertised).
    // Whitespace-tolerant, because the labels are column-padded for alignment.
    check(
        'reports both counts',
        /advertised in sitemap\s*:\s*2/.test(output) && /prerendered files\s*:\s*3/.test(output),
        output.replace(/\s+/g, ' ').slice(0, 120),
    )

    // ---- 6. bin shim --------------------------------------------------------
    console.log('\n6. bin shim')
    const shimCmd = process.platform === 'win32' ? 'prerender-audit.cmd' : 'prerender-audit'
    const shim = path.join(consumer, 'node_modules', '.bin', shimCmd)
    check('npm created a bin shim', existsSync(shim), shim)
    if (existsSync(shim)) {
        const shimExit = exitCode(path.join(consumer, 'node_modules', '.bin', shimCmd), [broken, '--origin', 'https://example.test'], consumer)
        check('the bin shim detects a broken build (exit 1)', shimExit === 1, `exit ${shimExit}`)
    }

    console.log('')
    if (failures.length > 0) {
        console.error(`${failures.length} of ${checks} package checks FAILED:`)
        for (const failure of failures) console.error(`  - ${failure}`)
        process.exit(1)
    }
    console.log(`All ${checks} package checks passed.`)
    process.exit(0)
} finally {
    rmSync(workspace, { recursive: true, force: true })
}