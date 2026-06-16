function clip(s, maxChars = 120000) {
  const t = String(s || "")
  return t.length > maxChars ? t.slice(0, maxChars) + "\n…(truncated)…" : t
}

function cleanName(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .replace(/^\s*[-*•]+\s*/, "")
    .trim()
}

function dedupe(names) {
  const seen = new Set()
  const out = []
  for (const n of names) {
    const k = cleanName(n).toLowerCase()
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(cleanName(n))
  }
  return out
}

function extractFailureNames(text) {
  const lines = String(text || "").split(/\r?\n/)
  const names = []

  for (const line of lines) {
    // Mocha/Cypress style:
    //   1) Some test name
    const m1 = line.match(/^\s*\d+\)\s+(.{4,220})\s*$/)
    if (m1 && m1[1]) {
      names.push(m1[1])
      continue
    }

    // JUnit/Jest-ish:
    // FAIL  path/to/spec  Test name
    const m2 = line.match(/^\s*(FAIL|FAILED)\b[:\s-]+(.{4,220})$/i)
    if (m2 && m2[2]) {
      names.push(m2[2])
      continue
    }

    // Playwright-ish:
    // × [chromium] › spec › test name
    const m3 = line.match(/^\s*[×✘]\s+(.{6,260})\s*$/)
    if (m3 && m3[1]) {
      names.push(m3[1])
      continue
    }

    // Jest bullet:
    // ● Suite › test
    const m4 = line.match(/^\s*●\s+(.{6,260})\s*$/)
    if (m4 && m4[1]) {
      names.push(m4[1])
      continue
    }

    // Generic:
    const m5 = line.match(/\bTest failed:\s*(.{4,240})/i)
    if (m5 && m5[1]) {
      names.push(m5[1])
      continue
    }
  }

  return dedupe(names)
}

/**
 * Returns "row" objects suitable for server.js `createFailureObject({ framework, ...row })`.
 */
function extractFailuresFromTextLog(content, originalFilename = "") {
  const names = extractFailureNames(content).slice(0, 25)
  const excerpt = clip(content, 200000)

  if (names.length === 0) {
    return [
      {
        framework: "log",
        testName: originalFilename || "Uploaded log",
        status: "failed",
        location: "{}",
        traceOrTimeline: excerpt,
        attachments: ""
      }
    ]
  }

  return names.map((n) => ({
    framework: "log",
    testName: n,
    status: "failed",
    location: JSON.stringify({ source: originalFilename || "" }, null, 2),
    traceOrTimeline: excerpt,
    attachments: ""
  }))
}

module.exports = {
  extractFailuresFromTextLog
}

