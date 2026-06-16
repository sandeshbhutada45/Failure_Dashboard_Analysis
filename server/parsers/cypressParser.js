const {
  createFailureObject
} = require("./commonFailure");

function stripHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** Preserve newlines so `at …` stack frames remain line-oriented after tag strip. */
function htmlToPlainWithBreaks(html) {
  let s = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "\n")
    .replace(/<style[\s\S]*?<\/style>/gi, "\n")
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner) => {
    const t = decodeEntities(
      inner.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")
    ).trim()
    return `\n${t}\n`
  })
  s = s.replace(/<br\s*\/?>/gi, "\n")
  s = s.replace(/<\/(p|div|tr|td|li|h[1-6]|table|thead|tbody|section|article|header)>/gi, "\n")
  s = s.replace(/<[^>]+>/g, " ")
  s = decodeEntities(s)
  return s
    .replace(/\r\n/g, "\n")
    .replace(/[ \t\f\v]{2,}/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim()
}

function clip(s, maxChars = 120000) {
  const t = String(s || "")
  return t.length > maxChars ? t.slice(0, maxChars) + "\n…(truncated)…" : t
}

function decodeEntities(s) {
  return String(s || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
}

/** Pull text from <pre>…</pre> (Cypress runner often puts the stack here). */
function preBlocksFromHtml(html) {
  const raw = String(html || "")
  const out = []
  const re = /<pre[^>]*>([\s\S]*?)<\/pre>/gi
  let m
  while ((m = re.exec(raw)) !== null) {
    let inner = m[1]
    inner = inner.replace(/<br\s*\/?>/gi, "\n")
    inner = inner.replace(/<\/(div|p|li)>/gi, "\n")
    inner = inner.replace(/<[^>]+>/g, "")
    inner = decodeEntities(inner)
    const t = inner.replace(/\r\n/g, "\n").trim()
    if (t.length > 20) out.push(t)
  }
  return out
}

/** Stack frames like `at foo (webpack:///…)` */
function atStackFromPlainText(text) {
  const lines = String(text || "").split(/\r?\n/)
  const frames = []
  for (const line of lines) {
    if (/^\s*at\s+/.test(line) || /webpack:\/\/\//.test(line)) {
      frames.push(line.trim())
      if (frames.length > 80) break
    }
  }
  return frames.join("\n")
}

function buildStackTrace(html) {
  const pres = preBlocksFromHtml(html)
  const relevant = pres.filter((p) =>
    /AssertionError|Timed out retrying|CypressError|TypeError|ReferenceError|\bat\s+/i.test(p)
  )
  const presJoined =
    relevant.length > 0
      ? relevant.join("\n\n---\n\n")
      : pres.length > 0
        ? pres.sort((a, b) => b.length - a.length)[0]
        : ""

  const atStack = atStackFromPlainText(htmlToPlainWithBreaks(html))
  if (presJoined && /\bat\s+/i.test(presJoined)) {
    return clip(presJoined, 80000)
  }
  const combined = [presJoined, atStack].filter(Boolean).join("\n\n")
  return clip(combined, 80000)
}

/** One-line stripHtml collapses stack; cut summary before first ` at ` frame. */
function extractErrorSummaries(collapsedText) {
  const t = String(collapsedText || "")
  const idx = t.search(
    /AssertionError|Timed out retrying|CypressError|TypeError|ReferenceError/i
  )
  if (idx < 0) return []
  let chunk = t.slice(idx, idx + 1200)
  const atCut = chunk.search(/\s+at\s+/)
  if (atCut > 0) {
    chunk = chunk.slice(0, atCut).trim()
  }
  chunk = chunk.replace(/\s+/g, " ").trim()
  if (chunk.length < 5) return []
  return [chunk.length > 900 ? chunk.slice(0, 900) + "…" : chunk]
}

function dedupeByName(rows) {
  const seen = new Set()
  const out = []
  for (const r of rows) {
    const k = String(r.testName || "").trim().toLowerCase()
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(r)
  }
  return out
}

async function extractCypressFailures(html) {

  const failures = []
  const stackTrace = buildStackTrace(String(html || ""))

  // 1) Mochawesome-style headings (legacy)
  try {
    const matches =
      String(html || "").matchAll(
        /<h2[^>]*>[\s\S]{0,200}?fail(?:ed)?[\s\S]{0,200}?<\/h2>/gis
      )

    for (const m of matches) {
      const txt = stripHtml(m[0])
      if (txt && txt.length > 6) {
        failures.push(
          createFailureObject({
            framework: "cypress",
            testName: txt,
            errorMessage: "",
            stackTrace,
            logs: clip(stripHtml(html), 200000),
            attachments: ""
          })
        )
      }
    }
  } catch {
    // ignore
  }

  // 2) Generic Cypress HTML (like your screenshot): pull test titles and assertion text
  const text = stripHtml(html)

  // Test titles often look like: [119742]: Validate "Call Process" post-action execution.
  const titleRe = /\[\d{3,12}\]\s*:\s*[^.]{4,180}\./g
  const titles = (text.match(titleRe) || []).slice(0, 25)

  // Capture the most meaningful failure sentence(s) (avoid cutting at `file.ts` dots)
  const errBits = extractErrorSummaries(text)

  const errorSummary =
    errBits.length > 0
      ? errBits.join("\n")
      : ""

  if (titles.length > 0) {
    for (const t of titles) {
      failures.push(
        createFailureObject({
          framework: "cypress",
          testName: t,
          errorMessage: errorSummary,
          stackTrace,
          logs: clip(text, 200000),
          attachments: ""
        })
      )
    }
  }

  // 3) If we still couldn't find explicit titles, fallback to a single bundle row
  if (failures.length === 0) {
    failures.push(
      createFailureObject({
        framework: "cypress",
        testName: "Cypress HTML report (failure)",
        errorMessage: errorSummary,
        stackTrace,
        logs: clip(text, 200000),
        attachments: ""
      })
    )
  }

  return dedupeByName(failures)
}

module.exports = {
  extractCypressFailures
};