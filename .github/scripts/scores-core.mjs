// Síň slávy party: společná čistá logika zápisu skóre. Bez importů a bez Node API, takže
// ji používá jak GitHub Action ve veřejném repu (scores.mjs, kopíruje ji tam
// `npm run deploy:web` jako .github/scripts/scores-core.mjs), tak hra v prohlížeči
// (src/client/hallOfFame/), která stejným výpočtem doplní čerstvá issues, ještě
// nezpracovaná Actionem („čeká na zapsání“). Typy pro hru jsou v scores-core.d.mts.
//
// Hra posílá issue s titulkem „Skóre: …“ a jedním řádkem JSON v bloku kódu:
//   {"v":4,"score":1234,"wave":7,"kills":80,"bosses":1,"megaboss":false,"achievements":0,
//    "mode":"endless-normal","version":"0.2.0","build":"s1-abc1234","time":1234,"earned":12500,
//    "golden":false}
// `time` (délka runu v sekundách bez pauzy) je volitelný, v boss rush rozhoduje při shodě bossů.
// Od v4 povinné: `earned` = vyděláno za run v Kč (součet příjmů, ne konečná hotovost),
// `golden` = hospoda v runu dosáhla tieru „Zlatý Pumbyč“ (nejvyšší tier prestiže).
// Anonymní odeslání (issue zakládá hra tokenem vlastníka repa) má navíc
//   "name":"<jméno>","anon":true
// Starší hra posílá "v":3 bez `earned` a `golden` (neznámé, null), "v":2 nebo "v":1 bez verze
// hry (zapíše se jako „0.x“), v1 i bez bossů a megabosse (a režim „normal“ = endless-normal).
//
// Klíč hráče je login autora issue. `anon:<jméno>` jen tehdy, když je issue anonymní
// a autor je vlastník repa (token ze hry). Jinak se anon ignoruje a platí login.
//
// scores.json (v3):
//   players:   { klíč: { name, anon, achievements (max), runs (počet odeslaných), last } }
//   records:   { "klíč|režim|verze": { player, mode, version, score, wave, kills, bosses,
//                megaboss, time, earned, golden, build, date, issue } } – nejlepší run hráče
//                v každé kategorii (režim-obtížnost) a verzi hry (major.minor, starší záznamy
//                „0.x“). `earned` (vyděláno v Kč) a `golden` (Zlatý Pumbyč) přibyly bez
//                zvednutí verze souboru: starší záznamy je nemají (čtou se jako null)
//                a starší hra je při čtení jen přeskočí.
//   processed: [čísla issues] – zpracovaná issues (i nezapsaná), podle nich hra pozná,
//                která issues už v souboru jsou
// Kampaň se do síně slávy nezapisuje (staré záznamy kampaně v souboru zůstanou, hra je
// neukazuje). Záznam se přepíše jen lepším runem (endless: skóre, boss rush: bossové,
// pak kratší čas, pak skóre). Záznamů je nejvýš MAX_RECORDS, při přetečení vypadnou nejhorší (podle
// umístění v kategorii a verzi), při shodě nejstarší. Starší soubory v1 a v2 se při
// načtení převedou.

export const TITLE_PREFIX = 'Skóre:'
export const NAME_MAX = 20
export const SCORES_VERSION = 3
/** Verze dat v issue, kterou posílá aktuální hra (v4 přidala `earned` a `golden`). */
export const PAYLOAD_VERSION = 4
/** Strop záznamů v scores.json, ať soubor zůstane malý. */
export const MAX_RECORDS = 500
/** Kolik čísel zpracovaných issues si scores.json pamatuje. */
export const MAX_PROCESSED = 2000
/** Verze hry u záznamů z doby před verzováním. */
export const UNKNOWN_VERSION = '0.x'
export const LIMITS = {
  body: 4000,
  json: 700,
  score: 10_000_000,
  wave: 1000,
  kills: 100_000,
  achievements: 1000,
  /** Délka runu (s), 2 dny. */
  time: 172_800,
  /** Vyděláno za run (Kč). */
  earned: 100_000_000,
  /** Strop vydělaných Kč na vlnu s velkou rezervou (i pozdní vlna s násobiči a jackpotem má desítky tisíc). */
  earnedPerWave: 500_000,
  /** Víc vyřízených na vlnu se do hry nevejde (strop vlny je 35 nepřátel plus bossové). */
  killsPerWave: 80,
}

/** Obtížnosti (src/sim/data/modes.ts). */
export const DIFFICULTIES = ['easy', 'normal', 'hard', 'regular']

/**
 * Režimy hry (src/sim/data/modes.ts) a jejich pravidla pro síň slávy:
 * `leaderboard` – zapisuje se do žebříčku, `bossEvery` – nejvýš jeden boss na tolik vln,
 * `megabossWave` – megaboss nejdřív v téhle vlně, `metric` – podle čeho se řadí.
 */
export const MODE_RULES = {
  endless: { leaderboard: true, bossEvery: 5, megabossWave: 15, metric: 'score' },
  // Boss rush (src/sim/data/bossRush.ts): boss na konci každé vlny, megaboss na konci
  // každého kola bossů (teď 12., 24. vlna…). Rezerva 10 pro případ kratšího kola.
  bossRush: { leaderboard: true, bossEvery: 1, megabossWave: 10, metric: 'bosses' },
  // Kampaň (probuzení po smrti) se do síně slávy nezapisuje.
  campaign: { leaderboard: false, bossEvery: 5, megabossWave: 15, metric: 'score' },
}

/** Všechny známé kategorie `režim-obtížnost` (i kampaň kvůli starým záznamům). */
export const KNOWN_MODES = Object.keys(MODE_RULES).flatMap((m) =>
  DIFFICULTIES.map((d) => `${m}-${d}`),
)
/** Kategorie, které se zapisují do žebříčku. */
export const LEADERBOARD_MODES = KNOWN_MODES.filter((mode) => modeRules(mode)?.leaderboard)
const KNOWN_SET = new Set(KNOWN_MODES)

/** „normal“ ze starší hry = endless na normální obtížnost. */
export function canonicalMode(mode) {
  if (typeof mode !== 'string' || mode === 'normal') return 'endless-normal'
  return mode
}

/** `bossRush-hard` → { game: 'bossRush', difficulty: 'hard' }, neznámé → null. */
export function splitMode(mode) {
  const i = typeof mode === 'string' ? mode.lastIndexOf('-') : -1
  if (i <= 0) return null
  const game = mode.slice(0, i)
  const difficulty = mode.slice(i + 1)
  if (!Object.hasOwn(MODE_RULES, game) || !DIFFICULTIES.includes(difficulty)) return null
  return { game, difficulty }
}

/** Pravidla režimu kategorie, nebo null. */
export function modeRules(mode) {
  const parts = splitMode(mode)
  return parts ? MODE_RULES[parts.game] : null
}

/** Verze hry „1.2.3“ (z package.json), jinak null. */
export function normalizeVersion(raw) {
  return typeof raw === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(raw) ? raw : null
}

/** Klíč verze pro žebříček: major.minor („0.2“), neznámá starší verze „0.x“. */
export function versionKey(version) {
  const valid = normalizeVersion(version)
  if (!valid) return UNKNOWN_VERSION
  const [major, minor] = valid.split('.')
  return `${Number(major)}.${Number(minor)}`
}

/**
 * Porovná dva runy v kategorii: kladné číslo = `a` je lepší. Endless podle skóre a vlny,
 * boss rush podle poražených bossů, pak kratšího času (když ho znají oba), skóre a vlny.
 */
export function compareRuns(a, b, mode) {
  if (modeRules(mode)?.metric === 'bosses') {
    const bosses = (a.bosses ?? 0) - (b.bosses ?? 0)
    if (bosses) return bosses
    const timed = typeof a.time === 'number' && typeof b.time === 'number'
    if (timed && a.time !== b.time) return b.time - a.time
  }
  return a.score - b.score || a.wave - b.wave
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
  const block = /```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n\s*```/.exec(body)
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
  if (![1, 2, 3, 4].includes(raw.v)) return { ok: false, reason: 'neznámá verze dat' }
  const mode = canonicalMode(raw.mode)
  if (!KNOWN_SET.has(mode)) return { ok: false, reason: 'neznámý režim hry' }
  const rules = modeRules(mode)
  if (!rules.leaderboard) return { ok: false, reason: 'kampaň se do síně slávy nezapisuje' }
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
  if (!isInt(bosses, 0, Math.floor(raw.wave / rules.bossEvery))) {
    return { ok: false, reason: 'neplatný počet bossů' }
  }
  const megaboss = raw.megaboss ?? false
  if (typeof megaboss !== 'boolean' || (megaboss && raw.wave < rules.megabossWave)) {
    return { ok: false, reason: 'neplatný megaboss' }
  }
  if (typeof raw.build !== 'string' || !/^[\w.+-]{1,40}$/.test(raw.build)) {
    return { ok: false, reason: 'neplatné označení buildu' }
  }
  const time = raw.time ?? null
  if (time !== null && !isInt(time, 0, LIMITS.time)) {
    return { ok: false, reason: 'neplatná délka runu' }
  }
  let earned = null
  let golden = null
  if (raw.v >= 4) {
    earned = raw.earned
    if (!isInt(earned, 0, Math.min(LIMITS.earned, raw.wave * LIMITS.earnedPerWave))) {
      return { ok: false, reason: 'neplatný výdělek' }
    }
    golden = raw.golden
    if (typeof golden !== 'boolean') return { ok: false, reason: 'neplatný Zlatý Pumbyč' }
  }
  let version = UNKNOWN_VERSION
  if (raw.v >= 3) {
    version = normalizeVersion(raw.version)
    if (!version) return { ok: false, reason: 'neplatná verze hry' }
  }
  const data = {
    score: raw.score,
    wave: raw.wave,
    kills: raw.kills,
    bosses,
    megaboss,
    time,
    earned,
    golden,
    achievements: raw.achievements,
    mode,
    version,
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
  return { v: SCORES_VERSION, updated: null, players: {}, records: {}, processed: [] }
}

/** Klíč záznamu: hráč, kategorie a verze hry (major.minor). */
export const recordKey = (playerKey, mode, version) => `${playerKey}|${mode}|${versionKey(version)}`

const int = (value, max) =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(0, Math.round(value)))
    : 0
const str = (value, max) => (typeof value === 'string' ? value.slice(0, max) : null)
const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value)

/** Vyděláno ze záznamu: celé Kč, nebo null, když ho záznam nemá (starší hra). */
export function readEarned(value) {
  return typeof value === 'number' && Number.isFinite(value) ? int(value, LIMITS.earned) : null
}

/** Zlatý Pumbyč ze záznamu: true/false, nebo null, když ho záznam nemá (starší hra). */
export function readGolden(value) {
  return typeof value === 'boolean' ? value : null
}

/** Záznam ze staršího souboru: očištěné hodnoty, neznámý režim → null. */
function oldRecord(player, old) {
  const mode = canonicalMode(old.mode)
  if (!KNOWN_SET.has(mode)) return null
  return {
    player,
    mode,
    version: normalizeVersion(old.version) ?? UNKNOWN_VERSION,
    score: int(old.score, LIMITS.score),
    wave: Math.max(1, int(old.wave, LIMITS.wave)),
    kills: int(old.kills, LIMITS.kills),
    bosses: int(old.bosses, LIMITS.wave),
    megaboss: old.megaboss === true,
    time: typeof old.time === 'number' ? int(old.time, LIMITS.time) : null,
    earned: readEarned(old.earned),
    golden: readGolden(old.golden),
    build: str(old.build, 40) ?? '',
    date: str(old.date, 40),
    issue: typeof old.issue === 'number' ? old.issue : null,
  }
}

/** Zapamatuje si zpracované issue (seřazeně, nejvýš MAX_PROCESSED posledních). */
export function markProcessed(scores, number) {
  if (!Number.isInteger(number) || number <= 0) return
  const list = scores.processed
  if (list.includes(number)) return
  list.push(number)
  list.sort((a, b) => a - b)
  if (list.length > MAX_PROCESSED) list.splice(0, list.length - MAX_PROCESSED)
}

/** Je issue už v scores.json? (Starší než nejstarší zapamatované se bere jako zpracované.) */
export function isProcessed(scores, number) {
  const list = scores.processed
  if (list.includes(number)) return true
  return list.length >= MAX_PROCESSED && number < list[0]
}

/**
 * Převede scores.json na v3. V1 měl v `players` jeden záznam na hráče s nejlepším runem,
 * v2 měl záznamy `hráč|režim` bez verze hry. Záznamy bez verze dostanou „0.x“ a čísla
 * jejich issues se zapíšou mezi zpracovaná. Nesmysly přeskočí, nic nevyhodí.
 */
export function migrateScores(data) {
  if (!isObject(data) || !isObject(data.players)) return emptyScores()
  if (data.v === SCORES_VERSION && isObject(data.records)) {
    if (!Array.isArray(data.processed)) data.processed = []
    data.processed = data.processed.filter((n) => Number.isInteger(n) && n > 0)
    return data
  }
  const scores = emptyScores()
  scores.updated = str(data.updated, 40)
  const v2 = isObject(data.records)
  for (const [key, old] of Object.entries(data.players)) {
    if (!isObject(old)) continue
    scores.players[key] = {
      name: str(old.name, 40) || key,
      anon: old.anon === true,
      achievements: int(old.achievements, LIMITS.achievements),
      runs: v2 ? Math.max(1, int(old.runs, 1e6)) : 1,
      last: str(v2 ? old.last : old.date, 40),
    }
  }
  const sources = v2
    ? Object.values(data.records).filter(isObject)
    : Object.entries(data.players)
        .filter(([, old]) => isObject(old))
        .map(([key, old]) => ({ ...old, player: key }))
  for (const old of sources) {
    const player = typeof old.player === 'string' ? old.player : ''
    if (!scores.players[player]) continue
    const record = oldRecord(player, old)
    if (!record) continue
    const key = recordKey(player, record.mode, record.version)
    const current = scores.records[key]
    if (!current || compareRuns(record, current, record.mode) > 0) scores.records[key] = record
    if (record.issue !== null) markProcessed(scores, record.issue)
  }
  return scores
}

/**
 * Ořízne záznamy na `max`. Vypadnou ty s nejhorším umístěním ve své kategorii a verzi
 * (každá si tak drží svou špičku), při shodě nejstarší. Hráči bez záznamu se smažou.
 * Vrátí klíče vyřazených záznamů.
 */
export function trimScores(scores, max = MAX_RECORDS) {
  const entries = Object.entries(scores.records)
  if (entries.length <= max) return []
  const groups = new Map()
  for (const entry of entries) {
    const group = `${entry[1].mode}|${versionKey(entry[1].version)}`
    const list = groups.get(group) ?? []
    list.push(entry)
    groups.set(group, list)
  }
  const rank = new Map()
  for (const list of groups.values()) {
    list.sort((a, b) => compareRuns(b[1], a[1], a[1].mode))
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
 * nejlepší run v kategorii a verzi jen při lepším výsledku. Vrátí `{ changed, written, message }`.
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
  if (!player.last || (date && date > player.last)) player.last = date
  scores.players[identity.key] = player

  const key = recordKey(identity.key, data.mode, data.version)
  const old = scores.records[key]
  if (old && compareRuns(data, old, data.mode) <= 0) {
    return {
      changed: true,
      written: false,
      message:
        `Run započítaný, do žebříčku nezapsaný: ${formatScore(data.score)} b. není lepší ` +
        `než dosavadní ${formatScore(old.score)} b. v téhle kategorii a verzi hry.`,
    }
  }
  scores.records[key] = {
    player: identity.key,
    mode: data.mode,
    version: data.version,
    score: data.score,
    wave: data.wave,
    kills: data.kills,
    bosses: data.bosses,
    megaboss: data.megaboss,
    time: data.time,
    earned: data.earned ?? null,
    golden: data.golden ?? null,
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

/** Datum issue (ISO), jinak `now`. */
function issueDate(issue, now) {
  const created = typeof issue?.createdAt === 'string' ? new Date(issue.createdAt) : null
  return created && !Number.isNaN(created.getTime()) ? created.toISOString() : now.toISOString()
}

/**
 * Zpracuje jedno issue (tvar z `gh issue list --json number,title,body,author,createdAt`).
 * Issue se zapíše mezi zpracovaná. Vrátí výsledek pro komentář.
 */
export function processIssue(scores, issue, owner, now = new Date()) {
  const author = issue?.author?.login
  const base = { number: issue.number, ok: false, changed: false }
  markProcessed(scores, issue.number)
  if (typeof author !== 'string' || !author) {
    return { ...base, changed: true, message: 'Nezapsáno: neznámý autor issue.' }
  }
  const extracted = extractPayload(issue.body)
  if (!extracted.ok) return { ...base, changed: true, message: `Nezapsáno: ${extracted.reason}.` }
  const valid = validatePayload(extracted.payload)
  if (!valid.ok) return { ...base, changed: true, message: `Nezapsáno: ${valid.reason}.` }
  const identity = playerIdentity(valid.data, author, owner)
  const result = upsertScore(scores, identity, valid.data, {
    date: issueDate(issue, now),
    issue: issue.number,
  })
  return {
    ...base,
    ok: result.written,
    changed: true,
    message: `${result.message} Hráč: ${identity.name}${identity.anon ? ' (anonymně)' : ''}.`,
  }
}

/**
 * Zpracuje všechna dosud nezpracovaná issues se skóre (otevřená i zavřená, třeba když
 * je hráč hned zavřel sám), od nejstaršího. Zpracovaná podle `processed` přeskočí.
 */
export function processIssues(scores, issues, owner, now = new Date()) {
  const seen = new Set()
  const relevant = issues
    .filter(
      (issue) =>
        Number.isInteger(issue?.number) &&
        typeof issue.title === 'string' &&
        issue.title.startsWith(TITLE_PREFIX) &&
        !isProcessed(scores, issue.number) &&
        !seen.has(issue.number) &&
        seen.add(issue.number),
    )
    .sort((a, b) => a.number - b.number)
  const results = relevant.map((issue) => processIssue(scores, issue, owner, now))
  if (results.some((r) => r.changed)) scores.updated = now.toISOString()
  return results
}

/** Issue z REST API GitHubu (`GET /repos/…/issues`) do tvaru, který čte processIssue. */
export function fromApiIssue(raw) {
  if (!isObject(raw) || raw.pull_request) return null
  if (!Number.isInteger(raw.number) || typeof raw.title !== 'string') return null
  return {
    number: raw.number,
    title: raw.title,
    body: typeof raw.body === 'string' ? raw.body : '',
    author: { login: typeof raw.user?.login === 'string' ? raw.user.login : '' },
    createdAt: typeof raw.created_at === 'string' ? raw.created_at : null,
  }
}
