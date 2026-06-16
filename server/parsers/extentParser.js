function clip(s, maxChars = 120000) {
  const t = String(s || "")
  return t.length > maxChars ? t.slice(0, maxChars) + "\n…(truncated)…" : t
}

function cleanName(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .trim()
}

function dedupe(arr) {
  const seen = new Set()
  const out = []
  for (const a of arr) {
    const k = cleanName(a).toLowerCase()
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(cleanName(a))
  }
  return out
}

function extractExtentFailureNames(html) {
  const names = []
  const s = String(html || "")

  // Heuristic 1: JSON-like blocks (common in Spark reports)
  // Look for: "status":"fail" ... "name":"Some test"
  const re1 = /"status"\s*:\s*"(?:fail|failed)"[\s\S]{0,700}?"name"\s*:\s*"([^"]{4,260})"/gi
  let m
  while ((m = re1.exec(s)) !== null) {
    if (m[1]) names.push(m[1])
    if (names.length >= 25) break
  }

  // Heuristic 2: HTML-ish status markers
  // <span class="status fail">fail</span> ... nearby test name
  const re2 = /class\s*=\s*"[^"]*\bstatus\b[^"]*\bfail(?:ed)?\b[^"]*"[\s\S]{0,800}?>([^<]{4,260})</gi
  while ((m = re2.exec(s)) !== null) {
    if (m[1]) names.push(m[1])
    if (names.length >= 25) break
  }

  // Heuristic 3: Generic "FAIL" rows
  const re3 = /\bFAIL(?:ED)?\b[\s:–-]{1,6}([^<\n\r]{4,260})/gi
  while ((m = re3.exec(s)) !== null) {
    if (m[1]) names.push(m[1])
    if (names.length >= 25) break
  }

  return dedupe(names).slice(0, 25)
}

/**
 * Returns common-ish rows; server.js normalizes them into its own failure shape.
 */
async function extractExtentFailures(html, originalFilename = "") {
  const names = extractExtentFailureNames(html)
  const excerpt = clip(html, 200000)

  if (names.length === 0) {
    return [
      {
        framework: "extent",
        testName: originalFilename || "Extent HTML report",
        errorMessage: "Could not reliably extract failed test names from Extent HTML; sending HTML excerpt to LLM.",
        logs: excerpt,
        attachments: ""
      }
    ]
  }

  return names.map((n) => ({
    framework: "extent",
    testName: n,
    errorMessage: "Extent report indicates failure",
    logs: excerpt,
    attachments: ""
  }))
}

module.exports = {
  extractExtentFailures
}

