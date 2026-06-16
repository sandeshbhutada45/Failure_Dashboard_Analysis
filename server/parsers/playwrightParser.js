const AdmZip = require("adm-zip")
const { createFailureObject } = require("./commonFailure")

function cleanTestName(title) {
  if (!title) return ""
  return String(title)
    .replace(/@\S+/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function extractPlaywrightZipBase64FromHtml(html) {
  if (!html || typeof html !== "string") return null

  const tmpl =
    html.match(
      /<template[^>]*\bid\s*=\s*["']playwrightReportBase64["'][^>]*>([\s\S]*?)<\/template>/i
    )

  if (tmpl && tmpl[1]) {
    let inner = tmpl[1].trim()
    const prefix = "data:application/zip;base64,"
    if (inner.startsWith(prefix)) inner = inner.slice(prefix.length)
    const b64 = inner.replace(/\s+/g, "")
    return b64.length > 64 ? b64 : null
  }

  const legacy =
    html.match(
      /data:application\/zip;base64,([A-Za-z0-9+/=\r\n]+)/
    )
  if (legacy && legacy[1]) {
    const b64 = legacy[1].replace(/\s+/g, "")
    return b64.length > 64 ? b64 : null
  }

  return null
}

function isImageAttachment(att) {
  if (!att || typeof att !== "object") return false
  const ct = String(att.contentType || "").toLowerCase()
  if (ct.startsWith("image/")) return true
  const p = `${att.path || ""} ${att.name || ""}`.toLowerCase()
  return /\.(png|jpe?g|webp|gif)\b/.test(p)
}

function guessMimeFromAttachment(att) {
  const ct = String(att.contentType || "").toLowerCase().split(";")[0].trim()
  if (ct.startsWith("image/")) return ct
  const p = String(att.path || att.name || "").toLowerCase()
  if (p.endsWith(".png")) return "image/png"
  if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg"
  if (p.endsWith(".webp")) return "image/webp"
  if (p.endsWith(".gif")) return "image/gif"
  return "image/png"
}

function clip(s, maxChars = 200000) {
  const t = String(s || "")
  return t.length > maxChars ? t.slice(0, maxChars) + "\n…(truncated)…" : t
}

function readZipEntryBytes(zip, wantedPath) {
  if (!zip || !wantedPath) return null
  const norm = String(wantedPath).replace(/\\/g, "/")
  const entries = zip.getEntries()

  // direct match
  const direct = entries.find((e) => !e.isDirectory && String(e.entryName || "").replace(/\\/g, "/") === norm)
  if (direct) {
    try {
      return direct.getData()
    } catch {
      return null
    }
  }

  // try basename match
  const base = norm.split("/").pop()
  if (base) {
    const matches = entries.filter((e) => !e.isDirectory && String(e.entryName || "").replace(/\\/g, "/").endsWith("/" + base))
    if (matches.length === 1) {
      try {
        return matches[0].getData()
      } catch {
        return null
      }
    }
  }

  return null
}

async function readOuterHandleBytes(outerHandle, wantedPath) {
  if (!outerHandle || !wantedPath) return null

  const normWanted = String(wantedPath).replace(/\\/g, "/").replace(/^\/+/, "")
  const base = normWanted.split("/").pop()

  const matchEntryName = (entryName) => {
    const n = String(entryName || "").replace(/\\/g, "/").replace(/^\/+/, "")
    if (!n) return false
    if (n === normWanted) return true
    if (n.endsWith("/" + normWanted)) return true
    return false
  }

  if (outerHandle.type === "adm" && outerHandle.zip) {
    const entries = outerHandle.zip.getEntries().filter((e) => e && !e.isDirectory)
    const direct = entries.find((e) => matchEntryName(e.entryName))
    if (direct) {
      try {
        return direct.getData()
      } catch {
        return null
      }
    }

    if (base) {
      const matches = entries.filter((e) => {
        const n = String(e.entryName || "").replace(/\\/g, "/")
        return n.endsWith("/" + base) || n === base
      })
      if (matches.length === 1) {
        try {
          return matches[0].getData()
        } catch {
          return null
        }
      }
    }
  }

  if (outerHandle.type === "unzipper" && outerHandle.directory) {
    const files = (outerHandle.directory.files || []).filter((f) => f && f.type === "File")
    const direct = files.find((f) => matchEntryName(f.path))
    if (direct) {
      try {
        return await direct.buffer()
      } catch {
        return null
      }
    }

    if (base) {
      const matches = files.filter((f) => {
        const n = String(f.path || "").replace(/\\/g, "/")
        return n.endsWith("/" + base) || n === base
      })
      if (matches.length === 1) {
        try {
          return await matches[0].buffer()
        } catch {
          return null
        }
      }
    }
  }

  return null
}

function collectAttachments(node) {
  const out = []
  if (!node || typeof node !== "object") return out
  const results = Array.isArray(node.results) ? node.results : []
  for (const r of results) {
    if (!r || typeof r !== "object") continue
    const atts = Array.isArray(r.attachments) ? r.attachments : []
    for (const a of atts) {
      if (!a || typeof a !== "object") continue
      out.push({
        name: a.name || "",
        contentType: a.contentType || "",
        path: a.path || ""
      })
    }
  }
  return out
}

async function extractPlaywrightHtmlData(html, outerHandle = null) {
  const b64 = extractPlaywrightZipBase64FromHtml(html)
  if (!b64) return []

  let zipBuffer
  try {
    zipBuffer = Buffer.from(b64, "base64")
  } catch {
    return []
  }

  let zip
  try {
    zip = new AdmZip(zipBuffer)
  } catch {
    return []
  }

  const entries = zip.getEntries().filter((e) => !e.isDirectory && String(e.entryName || "").toLowerCase().endsWith(".json"))
  const failed = []
  const seen = new Set()

  const maxJsonFiles = Math.min(200, Math.max(10, parseInt(process.env.PW_PARSER_MAX_JSON_FILES || "80", 10)))
  const jsonEntries = entries.slice(0, maxJsonFiles)

  const traverse = async (node) => {
    if (!node) return
    if (Array.isArray(node)) {
      for (const x of node) await traverse(x)
      return
    }
    if (typeof node !== "object") return

    const title = node.title || node.testName || node.name
    const cleanedTitle = cleanTestName(title)
    const status = node.status
    const outcome = node.outcome
    const hasFailure = status === "failed" || outcome === "unexpected"
    const hasTitle = typeof cleanedTitle === "string" && cleanedTitle.length > 3

    if (hasFailure && hasTitle) {
      const loc = node.location || {}
      const key = `${cleanedTitle}\0${loc.file || ""}\0${loc.line || ""}`
      if (!seen.has(key)) {
        seen.add(key)

        const parts = []
        if (node.error) parts.push("ERROR:\n" + clip(JSON.stringify(node.error, null, 2), 60000))
        if (node.errors) parts.push("ERRORS:\n" + clip(JSON.stringify(node.errors, null, 2), 60000))
        if (Array.isArray(node.annotations) && node.annotations.length) {
          parts.push("ANNOTATIONS:\n" + clip(JSON.stringify(node.annotations, null, 2), 60000))
        }
        if (Array.isArray(node.results) && node.results.length) {
          // steps/errors are useful, but can be huge
          const compactResults = node.results.map((r) => ({
            retry: r.retry,
            workerIndex: r.workerIndex,
            error: r.error,
            stdout: r.stdout,
            stderr: r.stderr,
            steps: r.steps,
            attachments: r.attachments
          }))
          parts.push("RESULTS:\n" + clip(JSON.stringify(compactResults, null, 2), 120000))
        }

        const attList = collectAttachments(node)
        const attachmentText = attList
          .map((a) => `NAME: ${a.name || ""}\nTYPE: ${a.contentType || ""}\nPATH: ${a.path || ""}`)
          .join("\n\n")

        const screenshotDataUrls = []
        const maxScreens = Math.min(5, Math.max(0, parseInt(process.env.VISION_MAX_IMAGES_PER_TEST || "2", 10)))
        for (const a of attList) {
          if (screenshotDataUrls.length >= maxScreens) break
          if (!isImageAttachment(a)) continue
          const buf =
            readZipEntryBytes(zip, a.path) ||
            (await readOuterHandleBytes(outerHandle, a.path))
          if (!buf || buf.length === 0) continue
          const maxBytes = Math.min(2 * 1024 * 1024, Math.max(102400, parseInt(process.env.VISION_MAX_IMAGE_BYTES || "524288", 10)))
          if (buf.length > maxBytes) continue
          const mime = guessMimeFromAttachment(a)
          screenshotDataUrls.push(`data:${mime};base64,${buf.toString("base64")}`)
        }

        failed.push(
          createFailureObject({
            framework: "playwright",
            testName: cleanedTitle,
            stackTrace: "",
            errorMessage: "",
            testSteps: "",
            logs: parts.filter(Boolean).join("\n\n"),
            attachments: attachmentText,
            screenshotDataUrls
          })
        )
      }
    }

    for (const k of Object.keys(node)) await traverse(node[k])
  }

  for (const e of jsonEntries) {
    try {
      const raw = e.getData().toString("utf8")
      await traverse(JSON.parse(raw))
    } catch {
      // ignore non-json
    }
  }

  return failed
}

module.exports = {
  extractPlaywrightHtmlData
}