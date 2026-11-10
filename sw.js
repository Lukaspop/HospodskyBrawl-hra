// Service Worker šifrované verze hry. Šablona: build (scripts/web/encrypt.mjs) sem vloží
// sdílené funkce z crypto-core.mjs a site-core.mjs a seznam souborů loaderu.
//
// Zachytává požadavky na soubory webu, stáhne odpovídající zašifrovaný blob (x/<hex>.bin),
// dešifruje ho a vrátí se správným Content-Type. Rozsahy (Range) vrací jako 206, aby
// <audio> fungovalo i v Safari. Dešifrované soubory drží v paměti po dobu běhu workeru.
// Bez klíče pouští adresu webu na síť, kde je přihlašovací loader. Navigaci jinam pošle na
// loader s parametrem `next`, aby se po přihlášení vrátila tam, kam uživatel mířil.
// Podsložky webu můžou být samostatné statické weby (stránky .html, index.html ve složkách,
// vlastní 404.html), pravidla adres jsou v site-core.mjs.
'use strict'

/* global base64ToBytes, decryptBytes, decryptManifest, fileAad, importAesKey, resolveSitePath */

// Společné šifrování pro verzi hry na webu (npm run build:web).
//
// Používá jen WebCrypto (`globalThis.crypto.subtle`), takže stejný kód běží v Node
// (šifrování při buildu, testy) i v prohlížeči (loader a Service Worker). Build ho do
// `loader.js` a `sw.js` vloží jako text a odstraní z něj slova `export`, proto tu smí být
// jen deklarace funkcí a konstant bez importů.
//
// Klíč: PBKDF2-SHA256 z „jméno:heslo“ s náhodnou solí → AES-256-GCM.
// Zašifrovaný soubor: 12 bajtů IV + šifrový text s 16bajtovým tagem GCM.
// Dodatečná data (AAD) svazují soubor s jeho cestou, takže bloby nejde mezi sebou prohodit.

const KDF_ITERATIONS = 600000
const IV_BYTES = 12
const SALT_BYTES = 16
const MANIFEST_AAD = 'hb-web:manifest'

/** Text, ze kterého se odvozuje klíč. Mezery na okrajích se ignorují (jako v src/gate.ts). */
function credentialText(name, password) {
  return `${String(name).trim()}:${String(password).trim()}`
}

/** AAD pro soubor hry s danou cestou (relativní ke kořeni webu, bez úvodního lomítka). */
function fileAad(path) {
  return `hb-web:file:${path}`
}

function bytesToBase64(bytes) {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

function base64ToBytes(text) {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Odvodí 32 bajtů klíče AES z přihlašovacích údajů (PBKDF2-SHA256). */
async function deriveRawKey(name, password, salt, iterations) {
  const subtle = globalThis.crypto.subtle
  const base = await subtle.importKey(
    'raw',
    new TextEncoder().encode(credentialText(name, password)),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    256,
  )
  return new Uint8Array(bits)
}

/** Z hrubého klíče udělá neexportovatelný klíč AES-GCM. */
function importAesKey(rawKey) {
  return globalThis.crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

/** Zašifruje bajty. Vrátí IV + šifrový text. IV je náhodný, pokud ho nezadáš. */
async function encryptBytes(key, plain, aad, iv) {
  const nonce = iv || globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const cipher = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: new TextEncoder().encode(aad) },
    key,
    plain,
  )
  const out = new Uint8Array(IV_BYTES + cipher.byteLength)
  out.set(nonce, 0)
  out.set(new Uint8Array(cipher), IV_BYTES)
  return out
}

/** Dešifruje blob z `encryptBytes`. Špatný klíč nebo upravená data vyhodí výjimku. */
async function decryptBytes(key, blob, aad) {
  const data = blob instanceof Uint8Array ? blob : new Uint8Array(blob)
  const plain = await globalThis.crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: data.subarray(0, IV_BYTES),
      additionalData: new TextEncoder().encode(aad),
    },
    key,
    data.subarray(IV_BYTES),
  )
  return new Uint8Array(plain)
}

/** Dešifruje manifest (JSON se seznamem souborů). */
async function decryptManifest(key, blob) {
  const plain = await decryptBytes(key, blob, MANIFEST_AAD)
  return JSON.parse(new TextDecoder().decode(plain))
}

// Společná pravidla adres šifrovaného webu (npm run build:web): Service Worker podle nich
// hledá soubor v manifestu, loader podle nich ověří, kam se po přihlášení vrátit.
//
// Stejně jako crypto-core.mjs ho build vloží do `loader.js` a `sw.js` jako text a odstraní
// slova `export`, proto tu smí být jen deklarace funkcí a konstant bez importů. Loader je
// veřejný: komentáře ani kód tu nesmí prozradit názvy souborů a složek webu.

/** Nejdelší přijatá cesta návratu po přihlášení (parametr `next`). */
const NEXT_MAX_LENGTH = 512

/**
 * Najde v manifestu soubor pro cestu `path` (relativní ke kořeni webu, dekódovaná, u složky
 * s doplněným `index.html`). `files` je seznam souborů z manifestu.
 *
 * Vrátí `{ file }` (soubor k vrácení), `{ redirect }` (relativní cesta, kam přesměrovat:
 * stránka bez `.html` nebo složka bez lomítka na konci), `{ file, status: 404 }` (stránka
 * 404.html nejbližší nadřazené podsložky) nebo `null` (nic takového není). Přesměrování
 * a stránku 404 dostane jen navigace, požadavky na soubory jen přesnou shodu.
 */
function resolveSitePath(files, path, isNavigation) {
  const has = (rel) => Object.prototype.hasOwnProperty.call(files, rel)
  if (has(path)) return { file: path }
  if (!isNavigation || !path) return null
  if (!path.endsWith('/index.html')) {
    if (has(`${path}.html`)) return { redirect: `${path}.html` }
    if (has(`${path}/index.html`)) return { redirect: `${path}/` }
  }
  const parts = path.split('/')
  for (let i = parts.length - 1; i > 0; i--) {
    const notFound = `${parts.slice(0, i).join('/')}/404.html`
    if (has(notFound)) return { file: notFound, status: 404 }
  }
  return null
}

/**
 * Ověří cíl návratu po přihlášení (parametr `next`, cesta relativní ke kořeni webu, jak ji
 * poslal Service Worker nebo stránka 404). Pustí jen obyčejnou cestu uvnitř webu: žádné
 * schéma, `//`, `..` (ani zakódované), dotaz nebo kotvu a nic ze složky zašifrovaných blobů.
 * Vrátí cestu, nebo prázdný řetězec.
 */
function safeNextPath(next) {
  if (typeof next !== 'string' || !next || next.length > NEXT_MAX_LENGTH) return ''
  if (!/^[A-Za-z0-9._~%@-][A-Za-z0-9._~%@/-]*$/.test(next)) return ''
  let decoded
  try {
    decoded = decodeURIComponent(next)
  } catch {
    return ''
  }
  for (const text of [next, decoded]) {
    if (text.includes('//') || text.includes('\\') || text.startsWith('/')) return ''
    if (text.split('/').some((part) => part === '.' || part === '..')) return ''
    if (/^x(\/|$)/.test(text)) return ''
  }
  return next
}


const LOADER_FILES = new Set(["index.html","loader.js","sw.js","params.json","manifest.bin","404.html",".nojekyll"])
// Veřejná nešifrovaná data (žebříček síně slávy scores.json): rovnou na síť, i bez přihlášení.
const PUBLIC_FILES = new Set(["scores.json"])
const BLOB_DIR = 'x/'
const SCOPE = new URL(self.registration.scope)
const DB_NAME = 'hb-web'
const DB_STORE = 'kv'
const ASK_TIMEOUT_MS = 2000

/** Stav přihlášení: klíč, manifest a cache dešifrovaných souborů. */
const state = {
  key: null,
  manifest: null,
  manifestBytes: null,
  files: new Map(),
  loading: null,
}

// ---------------------------------------------------------------- úložiště klíče
// Prohlížeč worker po chvíli nečinnosti uspí a paměť zahodí. Klíč proto leží i v IndexedDB
// (stejně jako v localStorage stránky), odkud si ho worker po probuzení vezme.

function idb(mode, action) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1)
    open.onupgradeneeded = () => open.result.createObjectStore(DB_STORE)
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const tx = db.transaction(DB_STORE, mode)
      const request = action(tx.objectStore(DB_STORE))
      tx.oncomplete = () => {
        db.close()
        resolve(request.result)
      }
      tx.onerror = () => {
        db.close()
        reject(tx.error)
      }
    }
  })
}

const idbGet = () => idb('readonly', (s) => s.get('key')).catch(() => null)
const idbSet = (value) => idb('readwrite', (s) => s.put(value, 'key')).catch(() => undefined)
const idbClear = () => idb('readwrite', (s) => s.delete('key')).catch(() => undefined)

// ---------------------------------------------------------------- klíč a manifest

function forgetKey() {
  state.key = null
  state.manifest = null
  state.manifestBytes = null
  state.files.clear()
}

async function fetchManifestBytes() {
  const response = await fetch(new URL('manifest.bin', SCOPE), { cache: 'no-cache' })
  if (!response.ok) throw new Error(`manifest: ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

function sameBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** Nastaví klíč z uložené hodnoty `{ salt, key }`. Vrátí true, když sedí na manifest. */
async function useStoredKey(value) {
  if (!value || typeof value.key !== 'string') return false
  try {
    const key = await importAesKey(base64ToBytes(value.key))
    const bytes = await fetchManifestBytes()
    const manifest = await decryptManifest(key, bytes)
    state.files.clear()
    state.key = key
    state.manifest = manifest
    state.manifestBytes = bytes
    return true
  } catch {
    return false
  }
}

/** Po nasazení nové verze se změní manifest: načte ho znovu a zahodí starou cache. */
async function refreshManifest() {
  const bytes = await fetchManifestBytes()
  if (sameBytes(bytes, state.manifestBytes)) return true
  try {
    state.manifest = await decryptManifest(state.key, bytes)
    state.manifestBytes = bytes
    state.files.clear()
    return true
  } catch {
    // Jiné heslo nebo sůl: klíč už neplatí.
    forgetKey()
    await idbClear()
    return false
  }
}

/** Zeptá se otevřených stránek webu na klíč (loader i hra odpovídají z localStorage). */
async function askClients() {
  const windows = await self.clients.matchAll({ type: 'window' })
  for (const client of windows) {
    const value = await new Promise((resolve) => {
      const channel = new MessageChannel()
      const timer = setTimeout(() => resolve(null), ASK_TIMEOUT_MS)
      channel.port1.onmessage = (event) => {
        clearTimeout(timer)
        resolve(event.data)
      }
      client.postMessage({ type: 'hb-need-key' }, [channel.port2])
    })
    if (value && (await useStoredKey(value))) {
      await idbSet(value)
      return true
    }
  }
  return false
}

async function ensureKey() {
  if (state.key) return true
  if (!state.loading) {
    state.loading = (async () => {
      if (await useStoredKey(await idbGet())) return true
      return askClients()
    })().finally(() => {
      state.loading = null
    })
  }
  return state.loading
}

// ---------------------------------------------------------------- soubory

function decryptFile(path, entry) {
  let promise = state.files.get(path)
  if (!promise) {
    const key = state.key
    promise = (async () => {
      const response = await fetch(new URL(`${BLOB_DIR}${entry.b}.bin`, SCOPE))
      if (!response.ok) throw new Error(`${path}: ${response.status}`)
      const plain = await decryptBytes(key, await response.arrayBuffer(), fileAad(path))
      return entry.t.startsWith('text/html') ? injectKeyHelper(plain) : plain
    })()
    promise.catch(() => state.files.delete(path))
    state.files.set(path, promise)
  }
  return promise
}

/**
 * Do každé stránky HTML vloží malý skript, který Service Workeru po restartu podá klíč
 * z localStorage (hra ani ostatní stránky o šifrování nevědí).
 */
function injectKeyHelper(bytes) {
  const html = new TextDecoder().decode(bytes)
  const helper =
    "<script>navigator.serviceWorker&&(navigator.serviceWorker.addEventListener('message',function(e){" +
    "if(e.data&&e.data.type==='hb-need-key'&&e.ports[0]){var v=null;" +
    "try{v=JSON.parse(localStorage.getItem('hb-web:key'))}catch(_){}e.ports[0].postMessage(v)}})," +
    'navigator.serviceWorker.startMessages())</script>'
  const out = html.replace(/<head>/i, (head) => `${head}\n    ${helper}`)
  return new TextEncoder().encode(out)
}

function textResponse(status, text) {
  return new Response(text, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

/** Odpověď na požadavek s hlavičkou Range (206), nebo celý soubor (200, případně `status`). */
function fileResponse(request, bytes, contentType, status = 200) {
  const size = bytes.length
  const headers = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  }
  const head = request.method === 'HEAD'
  const range = request.headers.get('Range')
  const match = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim())
  if (range && match && (match[1] || match[2])) {
    let start
    let end
    if (match[1]) {
      start = Number(match[1])
      end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
    } else {
      start = Math.max(0, size - Number(match[2]))
      end = size - 1
    }
    if (start >= size || start > end) {
      return new Response(null, {
        status: 416,
        headers: { ...headers, 'Content-Range': `bytes */${size}` },
      })
    }
    const slice = bytes.subarray(start, end + 1)
    return new Response(head ? null : slice, {
      status: 206,
      headers: {
        ...headers,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': String(slice.length),
      },
    })
  }
  return new Response(head ? null : bytes, {
    status,
    headers: { ...headers, 'Content-Length': String(size) },
  })
}

/** Adresa loaderu, který se po přihlášení vrátí na `rel` (zakódovaná cesta od kořene webu). */
function loginUrl(rel) {
  const url = new URL(SCOPE.href)
  if (rel) url.searchParams.set('next', rel)
  return url.href
}

/** Zakóduje relativní cestu do adresy (po segmentech). */
function encodePath(rel) {
  return rel.split('/').map(encodeURIComponent).join('/')
}

async function handle(request, path, rel) {
  const isNavigation = request.mode === 'navigate'
  if (!(await ensureKey())) {
    // Nepřihlášený: adresa webu ukáže loader, ostatní nic.
    if (path === 'index.html') return fetch(request)
    if (isNavigation) return Response.redirect(loginUrl(rel), 302)
    return textResponse(403, 'Nepřihlášeno')
  }
  if (isNavigation) {
    // Každá navigace ověří, jestli mezitím nevyšla nová verze (jiné bloby v manifestu).
    const valid = await refreshManifest().catch(() => true)
    if (!valid) {
      if (path === 'index.html') return fetch(request)
      return Response.redirect(loginUrl(rel), 302)
    }
  }
  const found = resolveSitePath(state.manifest.files, path, isNavigation)
  if (!found) return textResponse(404, 'Nenalezeno')
  if (found.redirect) return Response.redirect(new URL(encodePath(found.redirect), SCOPE).href, 302)
  const entry = state.manifest.files[found.file]
  try {
    return fileResponse(request, await decryptFile(found.file, entry), entry.t, found.status)
  } catch (error) {
    console.error(error)
    return textResponse(500, 'Soubor se nepodařilo dešifrovat')
  }
}

// ---------------------------------------------------------------- události

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('message', (event) => {
  const data = event.data || {}
  const reply = (value) => event.ports[0] && event.ports[0].postMessage(value)
  if (data.type === 'hb-key') {
    event.waitUntil(
      useStoredKey(data.value).then(async (ok) => {
        if (ok) await idbSet(data.value)
        reply(ok ? { ok: true } : { ok: false, error: 'Klíč nesedí na manifest.' })
      }),
    )
  } else if (data.type === 'hb-logout') {
    forgetKey()
    event.waitUntil(idbClear().then(() => reply({ ok: true })))
  }
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET' && request.method !== 'HEAD') return
  const url = new URL(request.url)
  // Cizí servery (Google Fonts) a adresy mimo web jdou rovnou na síť.
  if (url.origin !== SCOPE.origin || !url.pathname.startsWith(SCOPE.pathname)) return
  if (url.searchParams.has('logout')) return
  const rel = url.pathname.slice(SCOPE.pathname.length)
  let path
  try {
    path = decodeURIComponent(rel)
  } catch {
    return
  }
  if (path === '' || path.endsWith('/')) path += 'index.html'
  // Soubory loaderu a zašifrované bloby servíruje přímo server.
  if (path !== 'index.html' && (LOADER_FILES.has(path) || path.startsWith(BLOB_DIR))) return
  if (PUBLIC_FILES.has(path)) return
  event.respondWith(handle(request, path, rel))
})
