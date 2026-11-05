// Síň slávy party: zápis skóre z issues do scores.json. Běží jako GitHub Action ve veřejném
// repu Lukaspop/HospodskyBrawl-hra (workflow .github/workflows/scores.yml, tam je tenhle
// soubor jako .github/scripts/scores.mjs; kopíruje ho npm run deploy:web).
//
// Hra posílá issue s titulkem „Skóre: …“ a jedním řádkem JSON v bloku kódu:
//   {"v":2,"score":1234,"wave":7,"kills":80,"bosses":1,"megaboss":false,"achievements":0,
//    "mode":"endless-normal","build":"s1-abc1234"}
// Anonymní odeslání (issue zakládá hra tokenem vlastníka repa) má navíc
//   "name":"<jméno>","anon":true
// Starší hra posílá "v":1 bez bossů a megabosse (a režim „normal“ = endless-normal).
//
// Klíč hráče je login autora issue. `anon:<jméno>` jen tehdy, když je issue anonymní
// a autor je vlastník repa (token ze hry). Jinak se anon ignoruje a platí login.
//
// scores.json (v2):
//   players: { klíč: { name, anon, achievements (max), runs (počet odeslaných), last } }
//   records: { "klíč|režim": { player, mode, score, wave, kills, bosses, megaboss, build,
//              date, issue } } – nejlepší run hráče v každém režimu a obtížnosti
// Záznam se přepíše jen vyšším skóre. Záznamů je nejvýš MAX_RECORDS, při přetečení
// vypadnou nejhorší (podle umístění v režimu), při shodě nejstarší. Starý soubor v1
// (jeden řádek na hráče v `players`) se při načtení převede.
//
// Použití: node scores.mjs --issues issues.json --scores scores.json --results results.json
//   issues.json  = výstup `gh issue list --json number,title,body,author`
//   results.json = [{ number, ok, changed, message }] pro komentář a zavření issue
// Jen vestavěné moduly Node, bez závislostí.

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

export const TITLE_PREFIX = 'Skóre:'
export const NAME_MAX = 20
export const SCORES_VERSION = 2
/** Strop záznamů (hráč × režim) v scores.json, ať soubor zůstane malý. */
export const MAX_RECORDS = 500
export const LIMITS = {
  body: 4000,
  json: 700,
  score: 10_000_000,
  wave: 1000,
  kills: 100_000,
  achievements: 1000,
  /** Víc vyřízených na vlnu se do hry nevejde (strop vlny je 35 nepřátel plus bossové). */
  killsPerWave: 80,
  /** Boss je každou 5. vlnu, megaboss od 15. vlny. */
  bossEvery: 5,
  megabossWave: 15,
}
/** Režim-obtížnost (src/sim/data/modes.ts). */
export const MODES = ['campaign', 'endless'].flatMap((m) =>
  ['easy', 'normal', 'hard', 'regular'].map((d) => `${m}-${d}`),
)
const MODE_SET = new Set(MODES)

/** „normal“ ze starší hry = endless na normální obtížnost. */
export function canonicalMode(mode) {
  return mode === 'normal' ? 'endless-normal' : mode
}

/** Jméno: bez HTML, řídicích a neviditelných znaků, nejvýš 20 znaků. */
export function sanitizeName(raw) {
  if (typeof raw !== 'string') return ''
  const cleaned = raw
    .replace(/<[^>]*>/g, '')
    .replace(/[<>&"'`\\|]/g, '')
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
  if (raw.v !== 1 && raw.v !== 2) return { ok: false, reason: 'neznámá verze dat' }
  if (!isInt(raw.score, 0, LIMITS.score)) return { ok: false, reason: 'neplatné skóre' }
  if (!isInt(raw.wave, 1, LIMITS.wave)) return { ok: false, reason: 'neplatná vlna' }
  if (!isInt(raw.kills, 0, LIMITS.kills)) return { ok: false, reason: 'neplatný počet vyřízených' }
  if (raw.kills > raw.wave * LIMITS.killsPerWave) {
    return { ok: false, reason: 'na tuhle vlnu moc vyřízených' }
  }
  if (!isInt(raw.achievements, 0, LIMITS.achievements)) {
    return { ok: false, reason: 'neplatný počet achievementů' }
  }
  const bosses = raw.bosses ?? 0
  if (!isInt(bosses, 0, Math.floor(raw.wave / LIMITS.bossEvery))) {
    return { ok: false, reason: 'neplatný počet bossů' }
  }
  const megaboss = raw.megaboss ?? false
  if (typeof megaboss !== 'boolean' || (megaboss && raw.wave < LIMITS.megabossWave)) {
    return { ok: false, reason: 'neplatný megaboss' }
  }
  const mode = typeof raw.mode === 'string' ? canonicalMode(raw.mode) : ''
  if (!MODE_SET.has(mode)) return { ok: false, reason: 'neznámý režim hry' }
  if (typeof raw.build !== 'string' || !/^[\w.+-]{1,40}$/.test(raw.build)) {
    return { ok: false, reason: 'neplatné označení verze' }
  }
  const data = {
    score: raw.score,
    wave: raw.wave,
    kills: raw.kills,
    bosses,
    megaboss,
    achievements: raw.achievements,
    mode,
    build: raw.build,
    anon: raw.anon === true,
    name: '',
  }
  if (data.anon) {
    data.name = sanitizeName(raw.name)
    if (!data.name) return { ok: false, reason: 'chybí jméno' }
  }
  return { ok: true, data }
}

/** Klíč a jméno hráče: login autora, nebo anon:<jméno> od vlastníka repa. */
export function playerIdentity(data, author, owner) {
  if (data.anon && owner && author.toLowerCase() === owner.toLowerCase()) {
    return { key: `anon:${data.name.toLowerCase()}`, name: data.name, anon: true }
  }
  return { key: author.toLowerCase(), name: author, anon: false }
}

export function emptyScores() {
  return { v: SCORES_VERSION, updated: null, players: {}, records: {} }
}

export const recordKey = (playerKey, mode) => `${playerKey}|${mode}`

const int = (value, max) =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(0, Math.round(value)))
    : 0
const str = (value, max) => (typeof value === 'string' ? value.slice(0, max) : null)

/**
 * Převede scores.json na v2. V1 měl v `players` jeden záznam na hráče s nejlepším runem,
 * ten se rozdělí na hráče a záznam jeho režimu. Nesmysly přeskočí, nic nevyhodí.
 */
export function migrateScores(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return emptyScores()
  const players = data.players
  if (!players || typeof players !== 'object' || Array.isArray(players)) return emptyScores()
  if (data.v === SCORES_VERSION && data.records && typeof data.records === 'object') return data
  const scores = emptyScores()
  scores.updated = str(data.updated, 40)
  for (const [key, old] of Object.entries(players)) {
    if (!old || typeof old !== 'object') continue
    const mode = canonicalMode(typeof old.mode === 'string' ? old.mode : 'normal')
    if (!MODE_SET.has(mode)) continue
    const date = str(old.date, 40)
    scores.players[key] = {
      name: str(old.name, 40) || key,
      anon: old.anon === true,
      achievements: int(old.achievements, LIMITS.achievements),
      runs: 1,
      last: date,
    }
    scores.records[recordKey(key, mode)] = {
      player: key,
      mode,
      score: int(old.score, LIMITS.score),
      wave: Math.max(1, int(old.wave, LIMITS.wave)),
      kills: int(old.kills, LIMITS.kills),
      bosses: 0,
      megaboss: false,
      build: str(old.build, 40) ?? '',
      date,
      issue: typeof old.issue === 'number' ? old.issue : null,
    }
  }
  return scores
}

/** Načte scores.json (a převede na v2). Chybějící nebo poškozený soubor = prázdný žebříček. */
export function loadScores(file) {
  try {
    return migrateScores(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch {
    // Soubor zatím neexistuje.
  }
  return emptyScores()
}

/**
 * Ořízne záznamy na `max`. Vypadnou ty s nejhorším umístěním ve svém režimu (každý režim
 * si tak drží svou špičku), při shodě nejstarší. Hráči bez záznamu se smažou.
 * Vrátí klíče vyřazených záznamů.
 */
export function trimScores(scores, max = MAX_RECORDS) {
  const entries = Object.entries(scores.records)
  if (entries.length <= max) return []
  const byMode = new Map()
  for (const entry of entries) {
    const list = byMode.get(entry[1].mode) ?? []
    list.push(entry)
    byMode.set(entry[1].mode, list)
  }
  const rank = new Map()
  for (const list of byMode.values()) {
    list.sort((a, b) => b[1].score - a[1].score || b[1].wave - a[1].wave)
    list.forEach(([key], i) => rank.set(key, i))
  }
  const date = (record) => (typeof record.date === 'string' ? record.date : '')
  const removed = entries
    .sort((a, b) => rank.get(b[0]) - rank.get(a[0]) || date(a[1]).localeCompare(date(b[1])))
    .slice(0, entries.length - max)
    .map(([key]) => key)
  for (const key of removed) delete scores.records[key]
  const alive = new Set(Object.values(scores.records).map((r) => r.player))
  for (const key of Object.keys(scores.players)) if (!alive.has(key)) delete scores.players[key]
  return removed
}

const formatScore = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')

/**
 * Zapíše run hráče (mění `scores`): u hráče počet runů, datum a achievementy (maximum),
 * nejlepší run v režimu jen při vyšším skóre. Vrátí `{ changed, written, message }`.
 */
export function upsertScore(scores, identity, data, meta = {}) {
  const date = meta.date ?? null
  const player = scores.players[identity.key] ?? {
    name: identity.name,
    anon: identity.anon,
    achievements: 0,
    runs: 0,
    last: null,
  }
  player.name = identity.name
  player.anon = identity.anon
  player.achievements = Math.max(player.achievements ?? 0, data.achievements)
  player.runs = (player.runs ?? 0) + 1
  player.last = date
  scores.players[identity.key] = player

  const key = recordKey(identity.key, data.mode)
  const old = scores.records[key]
  if (old && data.score <= old.score) {
    return {
      changed: true,
      written: false,
      message:
        `Run započítaný, do žebříčku nezapsaný: skóre ${formatScore(data.score)} b. není vyšší ` +
        `než dosavadní ${formatScore(old.score)} b. v tomhle režimu.`,
    }
  }
  scores.records[key] = {
    player: identity.key,
    mode: data.mode,
    score: data.score,
    wave: data.wave,
    kills: data.kills,
    bosses: data.bosses,
    megaboss: data.megaboss,
    build: data.build,
    date,
    issue: meta.issue ?? null,
  }
  trimScores(scores)
  if (!scores.records[key]) {
    return {
      changed: true,
      written: false,
      message: `Nezapsáno: ${formatScore(data.score)} b. se do síně slávy nevešlo (je plná).`,
    }
  }
  return {
    changed: true,
    written: true,
    message: old
      ? `Zapsáno: nový rekord ${formatScore(data.score)} b. (předchozí ${formatScore(old.score)} b.).`
      : `Zapsáno: ${formatScore(data.score)} b.`,
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
