const fs = require("fs-extra")

function asArray(x) {
  if (!x) return []
  return Array.isArray(x) ? x : [x]
}

function clip(s, maxChars = 120000) {
  const t = String(s || "")
  return t.length > maxChars ? t.slice(0, maxChars) + "\n…(truncated)…" : t
}

function toPosix(p) {
  return String(p || "").replace(/\\/g, "/")
}

function folderFromEntryName(entryName) {
  const p = toPosix(entryName).replace(/\/+$/, "")
  const parts = p.split("/").filter(Boolean)
  if (parts.length <= 1) return ""
  parts.pop()
  return parts.join("/")
}

function isAllureResultFile(file) {
  const n = toPosix(file?.originalname || "").toLowerCase()
  return n.endsWith("-result.json") || n.includes("/allure-results/") && n.endsWith(".json") && n.includes("result")
}

function isAllureResultsBundle(files) {
  if (!Array.isArray(files) || files.length < 2) return false
  return files.some((f) => toPosix(f.originalname || "").toLowerCase().includes("allure-results/")) ||
    files.some((f) => isAllureResultFile(f))
}

function summarizeSteps(steps, max = 30) {
  const flat = []
  const visit = (s, depth) => {
    if (!s || typeof s !== "object") return
    const name = s.name || s.title || ""
    const status = s.status || ""
    if (name) flat.push(`${"  ".repeat(Math.min(depth, 5))}- ${name}${status ? ` [${status}]` : ""}`)
    for (const child of asArray(s.steps)) visit(child, depth + 1)
  }
  for (const s of asArray(steps)) visit(s, 0)
  return flat.slice(0, max).join("\n")
}

async function extractAllureFailuresFromFiles(files) {
  const failures = []
  const usedPaths = new Set()

  const resultFiles = (Array.isArray(files) ? files : []).filter(isAllureResultFile)
  for (const f of resultFiles) {
    try {
      const raw = await fs.readFile(f.path, "utf8")
      const parsed = JSON.parse(raw)

      const status = String(parsed.status || "").toLowerCase()
      if (status !== "failed" && status !== "broken") {
        usedPaths.add(f.path)
        continue
      }

      const name =
        parsed.name ||
        parsed.fullName ||
        parsed.testCaseName ||
        toPosix(f.originalname || "").split("/").pop() ||
        "Allure failure"

      const sd = parsed.statusDetails || {}
      const msg = sd.message || ""
      const trace = sd.trace || ""

      const stepText = summarizeSteps(parsed.steps)
      const att = asArray(parsed.attachments)
        .map((a) => `NAME: ${a.name || ""}\nTYPE: ${a.type || ""}\nSOURCE: ${a.source || ""}`)
        .filter(Boolean)
        .join("\n\n")

      const evidenceText = [
        "ALLURE RESULT JSON",
        `STATUS: ${parsed.status || ""}`,
        msg ? `MESSAGE:\n${msg}` : "",
        trace ? `TRACE:\n${trace}` : "",
        stepText ? `STEPS:\n${stepText}` : ""
      ]
        .filter(Boolean)
        .join("\n\n")

      const folder = folderFromEntryName(f.originalname || "")

      failures.push({
        framework: "allure",
        testName: String(name),
        status: "failed",
        location: JSON.stringify(
          {
            labels: parsed.labels || [],
            historyId: parsed.historyId || "",
            fullName: parsed.fullName || "",
            source: toPosix(f.originalname || ""),
            folder
          },
          null,
          2
        ),
        traceOrTimeline: clip(evidenceText),
        attachments: clip(att, 60000),
        sourceReportFolder: folder,
        sourceReportPath: toPosix(f.originalname || "")
      })

      usedPaths.add(f.path)
    } catch (_) {
      // ignore parse failures; handled by generic fallback
    }
  }

  return {
    detected: isAllureResultsBundle(files),
    failures,
    usedPaths
  }
}

module.exports = {
  extractAllureFailuresFromFiles,
  isAllureResultsBundle
}

