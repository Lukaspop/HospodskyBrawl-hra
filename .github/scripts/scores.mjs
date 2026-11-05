// Síň slávy party: zápis skóre z issues do scores.json. Běží jako GitHub Action ve veřejném
// repu Lukaspop/HospodskyBrawl-hra (workflow .github/workflows/scores.yml, tam je tenhle
// soubor jako .github/scripts/scores.mjs; kopíruje ho npm run deploy:web).
//
// Hra posílá issue s titulkem „Skóre: …“ a jedním řádkem JSON v bloku kódu:
//   {"v":1,"score":1234,"wave":7,"kills":80,"achievements":0,"mode":"normal","build":"s1-abc1234"}
// Anonymní odeslání (issue zakládá hra tokenem vlastníka repa) má navíc
//   "name":"<přezdívka>","anon":true
//
// Klíč hráče je login autora issue. `anon:<přezdívka>` jen tehdy, když je issue anonymní
// a autor je vlastník repa (token ze hry). Jinak se anon ignoruje a platí login.
// Záznam se přepíše jen vyšším skóre, achievementy se berou vždy jako maximum.
//
// Použití: node scores.mjs --issues issues.json --scores scores.json --results results.json
//   issues.json  = výstup `gh issue list --json number,title,body,author`
//   results.json = [{ number, ok, changed, message }] pro komentář a zavření issue
// Jen vestavěné moduly Node, bez závislostí.

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

export const TITLE_PREFIX = 'Skóre:'
export const NAME_MAX = 20
export const LIMITS = {
  body: 4000,
  json: 600,
  score: 10_000_000,
  wave: 1000,
  kills: 100_000,
  achievements: 1000,
  /** Víc vyřízených na vlnu se do hry nevejde (strop vlny je 35 nepřátel plus bossové). */
  killsPerWave: 80,
}
// „normal“ = endless na normální obtížnost, ostatní režim-obtížnost (src/sim/data/modes.ts).
const MODES = new Set([
  'normal',
  ...['campaign', 'endless'].flatMap((m) =>
    ['easy', 'normal', 'hard', 'regular'].map((d) => `${m}-${d}`),
  ),
])

/** Přezdívka: bez HTML, řídicích a neviditelných znaků, nejvýš 20 znaků. */
export function sanitizeName(raw) {
  if (typeof raw !== 'string') return ''
  const cleaned = raw
    .replace(/<[^>]*>/g, '')
    .replace(/[<>&"'`\\]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\p{C}/gu, '')
    .trim()
  return [...cleaned].slice(0, NAME_MAX).join('').trim()
}

/** Najde v těle issue řádek s JSON (v bloku kódu nebo samostatně) a rozparsuje ho. */
export function extractPayload(body) {
  if (typeof body !== 'string' || !body.trim()) return { ok: false, reason: 'prázdné tělo issue' }
  if (body.length > LIMITS.body) return { ok: false, reason: 'tělo issue je moc dlouhé' }
  const block = /```(?:json)?\s*\n([\s\S]*?)\n\s*```/.exec(body)
  const candidates = block ? [block[1].trim()] : body.split(/\r?\n/).map((line) => line.trim())
  const line = candidates.find((text) => text.startsWith('{') && text.endsWith('}'))
  if (!line) return { ok: false, reason: 'v těle chybí řádek s daty' }
  if (line.length > LIMITS.json) return { ok: false, reason: 'data jsou moc dlouhá' }
  try {
    return { ok: true, payload: JSON.parse(line) }
  } catch {
    return { ok: false, reason: 'data nejsou platný JSON' }
  }
}

const isInt = (value, min, max) =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max

/** Zkontroluje typy a rozsahy. Vrátí `{ ok, data }` s očištěnými hodnotami, nebo důvod. */
export function validatePayload(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'data nejsou objekt' }
  }
  if (raw.v !== 1) return { ok: false, reason: 'neznámá verze dat' }
  if (!isInt(raw.score, 0, LIMITS.score)) return { ok: false, reason: 'neplatné skóre' }
  if (!isInt(raw.wave, 1, LIMITS.wave)) return { ok: false, reason: 'neplatná vlna' }
  if (!isInt(raw.kills, 0, LIMITS.kills)) return { ok: false, reason: 'neplatný počet vyřízených' }
  if (raw.kills > raw.wave * LIMITS.killsPerWave) {
    return { ok: false, reason: 'na tuhle vlnu moc vyřízených' }
  }
  if (!isInt(raw.achievements, 0, LIMITS.achievements)) {
    return { ok: false, reason: 'neplatný počet achievementů' }
  }
  if (typeof raw.mode !== 'string' || !MODES.has(raw.mode)) {
    return { ok: false, reason: 'neznámý režim hry' }
  }
  if (typeof raw.build !== 'string' || !/^[\w.+-]{1,40}$/.test(raw.build)) {
    return { ok: false, reason: 'neplatné označení verze' }
  }
  const data = {
    score: raw.score,
    wave: raw.wave,
    kills: raw.kills,
    achievements: raw.achievements,
    mode: raw.mode,
    build: raw.build,
    anon: raw.anon === true,
    name: '',
  }
  if (data.anon) {
    data.name = sanitizeName(raw.name)
    if (!data.name) return { ok: false, reason: 'chybí přezdívka' }
  }
  return { ok: true, data }
}

/** Klíč a jméno hráče: login autora, nebo anon:<přezdívka> od vlastníka repa. */
export function playerIdentity(data, author, owner) {
  if (data.anon && owner && author.toLowerCase() === owner.toLowerCase()) {
    return { key: `anon:${data.name.toLowerCase()}`, name: data.name, anon: true }
  }
  return { key: author.toLowerCase(), name: author, anon: false }
}

export function emptyScores() {
  return { v: 1, updated: null, players: {} }
}

/** Načte scores.json. Chybějící nebo poškozený soubor = prázdný žebříček. */
export function loadScores(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (data && typeof data.players === 'object' && !Array.isArray(data.players)) return data
  } catch {
    // Soubor zatím neexistuje.
  }
  return emptyScores()
}

const formatScore = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')

/**
 * Zapíše záznam hráče (mění `scores`). Skóre a ostatní pole jen při vyšším skóre,
 * achievementy vždy maximum. Vrátí `{ changed, written, message }`.
 */
export function upsertScore(scores, identity, data, meta = {}) {
  const old = scores.players[identity.key]
  const entry = {
    name: identity.name,
    anon: identity.anon,
    score: data.score,
    wave: data.wave,
    kills: data.kills,
    achievements: data.achievements,
    mode: data.mode,
    build: data.build,
    date: meta.date ?? null,
    issue: meta.issue ?? null,
  }
  if (!old) {
    scores.players[identity.key] = entry
    return { changed: true, written: true, message: `Zapsáno: ${formatScore(data.score)} b.` }
  }
  if (data.score > old.score) {
    entry.achievements = Math.max(old.achievements ?? 0, data.achievements)
    scores.players[identity.key] = entry
    return {
      changed: true,
      written: true,
      message: `Zapsáno: nový rekord ${formatScore(data.score)} b. (předchozí ${formatScore(old.score)} b.).`,
    }
  }
  const achievements = Math.max(old.achievements ?? 0, data.achievements)
  const moreAchievements = achievements > (old.achievements ?? 0)
  if (moreAchievements) old.achievements = achievements
  return {
    changed: moreAchievements,
    written: false,
    message:
      `Nezapsáno: skóre ${formatScore(data.score)} b. není vyšší než dosavadní ` +
      `${formatScore(old.score)} b.` +
      (moreAchievements ? ` Achievementy aktualizované na ${achievements}.` : ''),
  }
}

/** Zpracuje jedno issue (objekt z `gh issue list`). Vrátí výsledek pro komentář. */
export function processIssue(scores, issue, owner, now = new Date()) {
  const author = issue?.author?.login
  const base = { number: issue.number, ok: false, changed: false }
  if (typeof author !== 'string' || !author) {
    return { ...base, message: 'Nezapsáno: neznámý autor issue.' }
  }
  const extracted = extractPayload(issue.body)
  if (!extracted.ok) return { ...base, message: `Nezapsáno: ${extracted.reason}.` }
  const valid = validatePayload(extracted.payload)
  if (!valid.ok) return { ...base, message: `Nezapsáno: ${valid.reason}.` }
  const identity = playerIdentity(valid.data, author, owner)
  const result = upsertScore(scores, identity, valid.data, {
    date: now.toISOString(),
    issue: issue.number,
  })
  return {
    ...base,
    ok: result.written,
    changed: result.changed,
    message: `${result.message} Hráč: ${identity.name}${identity.anon ? ' (anonymně)' : ''}.`,
  }
}

/** Zpracuje všechna otevřená issues se skóre, od nejstaršího. */
export function processIssues(scores, issues, owner, now = new Date()) {
  const relevant = issues
    .filter((issue) => typeof issue?.title === 'string' && issue.title.startsWith(TITLE_PREFIX))
    .sort((a, b) => a.number - b.number)
  const results = relevant.map((issue) => processIssue(scores, issue, owner, now))
  if (results.some((r) => r.changed)) scores.updated = now.toISOString()
  return results
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]
    if (!['--issues', '--scores', '--results'].includes(name)) {
      throw new Error(`Neznámý přepínač ${name}`)
    }
    args[name.slice(2)] = argv[i + 1]
  }
  if (!args.issues || !args.scores || !args.results) {
    throw new Error('Použití: --issues <soubor> --scores <soubor> --results <soubor>')
  }
  return args
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const owner = process.env.GITHUB_REPOSITORY_OWNER || 'Lukaspop'
  const issues = JSON.parse(fs.readFileSync(args.issues, 'utf8'))
  const scores = loadScores(args.scores)
  const results = processIssues(scores, Array.isArray(issues) ? issues : [], owner)
  if (results.some((r) => r.changed)) {
    fs.writeFileSync(args.scores, `${JSON.stringify(scores, null, 2)}\n`)
  }
  fs.writeFileSync(args.results, JSON.stringify(results))
  for (const r of results) console.log(`#${r.number}: ${r.message}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(error.message || error)
    process.exit(1)
  }
}
