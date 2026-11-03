#!/usr/bin/env node
// Keeps this plugin's marketplace entry description in sync with the canonical text kept in this repo.
//
// Why this exists: the marketplace listing's *version* is filled in by the catalog's nightly npm probe
// (the entry YAML has no version key at all), so a PR cannot update it. Only the description can drift,
// and that is what this script compares: market/description.en.txt and market/description.zh.txt are the
// source of truth, the entry file in the catalog is the copy.
//
// Usage (in CI):
//   node tools/sync-market-entry.mjs --check        # exit 0 always; writes changed=true|false to $GITHUB_OUTPUT
//   node tools/sync-market-entry.mjs --write <file> # write the updated entry YAML to <file>
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
const OWNER = 'Lovenndme'
const UPSTREAM = 'awesome-dsh-plugin/awesome-dsh-plugin'
const repoName = process.env.GITHUB_REPOSITORY ? process.env.GITHUB_REPOSITORY.split('/')[1] : 'dsh-profile-stats'
const entryPath = `data/plugins/${OWNER}__${repoName}.yml`

const descriptionFiles = {
  en: join(repoRoot, 'market', 'description.en.txt'),
  zh: join(repoRoot, 'market', 'description.zh.txt'),
}

/** YAML 单引号字符串：内部的单引号写成两个。 */
const quote = (text) => `'${String(text).replace(/'/g, "''")}'`
const unquote = (raw) => String(raw).replace(/^'/, '').replace(/'$/, '').replace(/''/g, "'")

function canonical() {
  const out = {}
  for (const [key, file] of Object.entries(descriptionFiles)) {
    if (!existsSync(file)) throw new Error(`missing ${file}`)
    out[key] = readFileSync(file, 'utf8').trim().replace(/\s*\n\s*/g, ' ')
  }
  return out
}

/** 从条目文件里取出 description 下的 en / zh（本目录所有条目都是单行单引号字符串）。 */
function parseEntry(text) {
  const found = {}
  for (const key of ['en', 'zh']) {
    const match = text.match(new RegExp(`^\\s{2}${key}:\\s*('(?:[^']|'')*')\\s*$`, 'm'))
    if (match) found[key] = unquote(match[1])
  }
  return found
}

function rewriteEntry(text, next) {
  let out = text
  for (const key of ['en', 'zh']) {
    const pattern = new RegExp(`^(\\s{2})${key}:\\s*('(?:[^']|'')*')\\s*$`, 'm')
    if (!pattern.test(out)) throw new Error(`entry has no description.${key} line to rewrite`)
    out = out.replace(pattern, (line, indent) => `${indent}${key}: ${quote(next[key])}`)
  }
  return out
}

async function fetchEntry(token) {
  const response = await fetch(`https://api.github.com/repos/${UPSTREAM}/contents/${entryPath}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-market-sync',
    },
  })
  if (!response.ok) throw new Error(`GET ${entryPath} → ${response.status} ${await response.text()}`)
  const payload = await response.json()
  return Buffer.from(payload.content, 'base64').toString('utf8')
}

const mode = process.argv[2]
const token = process.env.MARKET_TOKEN || process.env.GH_TOKEN
if (!token) {
  console.error('MARKET_TOKEN is not set')
  process.exit(1)
}

const entry = await fetchEntry(token)
const current = parseEntry(entry)
const wanted = canonical()

const drifted = ['en', 'zh'].filter((key) => (current[key] || '') !== wanted[key])
console.log(`entry: ${entryPath}`)
for (const key of ['en', 'zh']) {
  console.log(`  ${key}: ${drifted.includes(key) ? 'DIFFERS' : 'in sync'}`)
}

if (mode === '--write') {
  const target = process.argv[3]
  if (!target) throw new Error('--write needs an output path')
  writeFileSync(target, rewriteEntry(entry, wanted), 'utf8')
  console.log(`wrote ${target}`)
} else {
  const output = process.env.GITHUB_OUTPUT
  const changed = drifted.length > 0 ? 'true' : 'false'
  if (output) writeFileSync(output, `changed=${changed}\n`, { flag: 'a' })
  console.log(`changed=${changed}`)
}
