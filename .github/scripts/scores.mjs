// Síň slávy party: zápis skóre z issues do scores.json. Běží jako GitHub Action ve veřejném
// repu Lukaspop/HospodskyBrawl-hra (workflow .github/workflows/scores.yml, tam je tenhle
// soubor jako .github/scripts/scores.mjs a vedle něj scores-core.mjs; oba kopíruje
// npm run deploy:web). Formát issue i scores.json a pravidla zápisu popisuje
// scores-core.mjs, tady je jen načtení a uložení souborů.
//
// Použití: node scores.mjs --issues issues.json --scores scores.json --results results.json
//   issues.json  = výstup `gh issue list --state all --json number,title,body,author,createdAt`
//                  (zpracovaná issues podle `processed` v scores.json se přeskočí)
//   results.json = [{ number, ok, changed, message }] pro komentář a zavření issue
// Jen vestavěné moduly Node, bez závislostí.

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { emptyScores, migrateScores, processIssues } from './scores-core.mjs'

export * from './scores-core.mjs'

/** Načte scores.json (a převede na v3). Chybějící nebo poškozený soubor = prázdný žebříček. */
export function loadScores(file) {
  try {
    return migrateScores(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch {
    // Soubor zatím neexistuje.
  }
  return emptyScores()
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
  const before = fs.existsSync(args.scores) ? fs.readFileSync(args.scores, 'utf8') : ''
  const scores = loadScores(args.scores)
  const results = processIssues(scores, Array.isArray(issues) ? issues : [], owner)
  const text = `${JSON.stringify(scores, null, 2)}\n`
  // Zapíše i samotný převod staršího souboru na v3 (bez nových issues).
  if (text !== before) fs.writeFileSync(args.scores, text)
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
