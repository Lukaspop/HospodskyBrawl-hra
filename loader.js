// Přihlašovací loader šifrované verze hry. Šablona: build (scripts/web/encrypt.mjs) sem
// místo značky níže vloží sdílené funkce z crypto-core.mjs.
//
// Postup: jméno + heslo → PBKDF2 → klíč AES-GCM → zkusí dešifrovat manifest (špatné údaje
// = chyba ověření GCM) → zaregistruje Service Worker (sw.js), předá mu klíč a přejde na
// adresu webu. Service Worker pak hru dešifruje a servíruje místo tohoto loaderu.
// Klíč (ne heslo) si pamatuje v localStorage, odhlášení přes adresu s `?logout`.

/* global base64ToBytes, bytesToBase64, decryptManifest, deriveRawKey, importAesKey */
;(() => {
  'use strict'

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


  const STORAGE_KEY = 'hb-web:key'
  const ENTER_KEY = 'hb-web:entering'
  const SW_TIMEOUT_MS = 15000

  const byId = (id) => document.getElementById(id)
  const form = byId('login')
  const nameInput = byId('name')
  const passwordInput = byId('password')
  const submit = byId('submit')
  const message = byId('message')
  const boot = byId('boot')
  const siteUrl = new URL('./', location.href)

  function setMessage(text, isError) {
    message.textContent = text
    message.classList.toggle('error', Boolean(isError))
  }

  function showForm(text, isError) {
    boot.classList.add('hidden')
    form.classList.remove('hidden')
    submit.disabled = false
    setMessage(text || '', isError)
    ;(nameInput.value ? passwordInput : nameInput).focus()
  }

  function fatal(text) {
    form.classList.add('hidden')
    boot.classList.remove('hidden')
    boot.classList.add('error')
    boot.textContent = text
  }

  function readStored() {
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')
      return value && typeof value.key === 'string' ? value : null
    } catch {
      return null
    }
  }

  function store(value) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
    } catch {
      // Bez úložiště se přihlášení zeptá při každé návštěvě.
    }
  }

  function forget() {
    try {
      localStorage.removeItem(STORAGE_KEY)
      sessionStorage.removeItem(ENTER_KEY)
    } catch {
      // Úložiště není dostupné, není co mazat.
    }
  }

  async function fetchBytes(url) {
    const response = await fetch(url, { cache: 'no-cache' })
    if (!response.ok) throw new Error(`${url}: ${response.status}`)
    return new Uint8Array(await response.arrayBuffer())
  }

  function withTimeout(promise, ms, text) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(text)), ms)),
    ])
  }

  /** Pošle zprávu aktivnímu Service Workeru a počká na odpověď. */
  async function askWorker(data) {
    const registration = await withTimeout(
      navigator.serviceWorker.ready,
      SW_TIMEOUT_MS,
      'Service Worker se nespustil.',
    )
    const worker = registration.active
    if (!worker) throw new Error('Service Worker není aktivní.')
    return withTimeout(
      new Promise((resolve) => {
        const channel = new MessageChannel()
        channel.port1.onmessage = (event) => resolve(event.data)
        worker.postMessage(data, [channel.port2])
      }),
      SW_TIMEOUT_MS,
      'Service Worker neodpověděl.',
    )
  }

  /** Ověří klíč na manifestu. Špatný klíč vyhodí výjimku (selže tag GCM). */
  async function verifyKey(rawKey, manifestBlob) {
    const key = await importAesKey(rawKey)
    await decryptManifest(key, manifestBlob)
  }

  /** Předá klíč Service Workeru a přejde do hry. */
  async function enter(stored) {
    // Pojistka proti smyčce: když se loader do pár sekund vrátí, Service Worker hru nepustil.
    let last = 0
    try {
      last = Number(sessionStorage.getItem(ENTER_KEY)) || 0
    } catch {
      // Bez sessionStorage pojistka nefunguje, smyčku pak zastaví až chyba níže.
    }
    if (Date.now() - last < 8000) {
      throw new Error('Prohlížeč hru nenačetl přes Service Worker.')
    }
    const reply = await askWorker({ type: 'hb-key', value: stored })
    if (!reply || !reply.ok) throw new Error((reply && reply.error) || 'Klíč nesedí.')
    try {
      sessionStorage.setItem(ENTER_KEY, String(Date.now()))
    } catch {
      // Viz výše.
    }
    location.replace(siteUrl.href)
  }

  // Service Worker po restartu (prohlížeč ho uspí) může klíč požádat znovu.
  function answerKeyRequests() {
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'hb-need-key' && event.ports[0]) {
        event.ports[0].postMessage(readStored())
      }
    })
    navigator.serviceWorker.startMessages()
  }

  async function main() {
    if (!window.isSecureContext || !globalThis.crypto || !crypto.subtle) {
      fatal('Hra potřebuje zabezpečené připojení (HTTPS).')
      return
    }
    if (!('serviceWorker' in navigator)) {
      fatal(
        'Prohlížeč nepovolil Service Worker (třeba anonymní okno ve Firefoxu). Zkus normální okno nebo jiný prohlížeč.',
      )
      return
    }
    answerKeyRequests()
    const registering = navigator.serviceWorker
      .register('./sw.js', { scope: './' })
      .catch((error) => {
        console.error(error)
        fatal('Service Worker se nepodařilo zaregistrovat. Zkus jiný prohlížeč.')
        throw error
      })

    const [params, manifestBlob] = await Promise.all([
      fetch('./params.json', { cache: 'no-cache' }).then((r) => r.json()),
      fetchBytes('./manifest.bin'),
    ])
    const salt = base64ToBytes(params.salt)

    const url = new URL(location.href)
    if (url.searchParams.has('logout')) {
      forget()
      await registering
      await askWorker({ type: 'hb-logout' }).catch(() => undefined)
      history.replaceState(null, '', siteUrl.pathname)
      showForm('Odhlášeno. Na zdraví!')
      return
    }

    const stored = readStored()
    if (stored && stored.salt === params.salt) {
      try {
        await verifyKey(base64ToBytes(stored.key), manifestBlob)
        await registering
        await enter(stored)
        return
      } catch (error) {
        console.warn(error)
        if (/Service Worker/.test(String(error && error.message))) {
          showForm(`Nepodařilo se spustit hru: ${error.message} Zkus obnovit stránku.`, true)
          return
        }
        forget()
      }
    } else if (stored) {
      forget()
    }
    showForm()

    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      submit.disabled = true
      setMessage('Ověřuji štamgasta…')
      let value
      try {
        const rawKey = await deriveRawKey(
          nameInput.value,
          passwordInput.value,
          salt,
          params.iterations,
        )
        await verifyKey(rawKey, manifestBlob)
        value = { salt: params.salt, key: bytesToBase64(rawKey) }
      } catch {
        passwordInput.value = ''
        showForm('Špatné jméno nebo heslo. Prokeš tě nezná.', true)
        return
      }
      store(value)
      setMessage('Točí se pivo…')
      try {
        await registering
        await enter(value)
      } catch (error) {
        console.error(error)
        showForm(`Nepodařilo se spustit hru: ${error.message}`, true)
      }
    })
  }

  main().catch((error) => {
    console.error(error)
    fatal('Hospůdku se nepodařilo otevřít. Zkus stránku obnovit.')
  })
})()
