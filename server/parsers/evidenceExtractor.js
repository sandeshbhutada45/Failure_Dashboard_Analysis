const path = require("path")
const fs = require("fs-extra")

function envInt(name, fallback) {
  const n = Number.parseInt(process.env[name] || "", 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function toPosix(p) {
  return String(p || "").replace(/\\/g, "/")
}

function isSkippablePath(p) {
  const n = toPosix(p).toLowerCase()
  return !n || n.includes("__macosx/")
}

function guessMimeFromExt(ext) {
  switch (ext) {
    case ".png":
      return "image/png"
    case ".jpg":
    case ".jpeg":
      return "image/jpeg"
    case ".webp":
      return "image/webp"
    case ".gif":
      return "image/gif"
    default:
      return "application/octet-stream"
  }
}

function clipText(s, maxChars) {
  const t = String(s || "")
  return t.length > maxChars ? t.slice(0, maxChars) + "\n…(truncated)…" : t
}

function folderFromEntryName(entryName) {
  const p = toPosix(entryName).replace(/\/+$/, "")
  const parts = p.split("/").filter(Boolean)
  if (parts.length <= 1) return ""
  parts.pop()
  return parts.join("/")
}

function looksLikeLogFile(posixPath) {
  const p = posixPath.toLowerCase()
  const ext = path.extname(p)
  if (ext === ".log") return true
  if (ext === ".txt" && (p.includes("/log") || p.includes("console") || p.includes("output"))) return true
  return p.includes("/logs/") || p.includes("/log/")
}

function looksLikeTraceFile(posixPath) {
  const p = posixPath.toLowerCase()
  const base = p.split("/").pop() || ""
  if (base === "trace.zip") return true
  if (p.includes("/trace/") || p.includes("/traces/") || p.includes("playwright-trace")) return true
  return false
}

function looksLikeVideoFile(posixPath) {
  const p = posixPath.toLowerCase()
  const ext = path.extname(p)
  return ext === ".mp4" || ext === ".webm"
}

function looksLikeAutomationCode(posixPath) {
  const p = posixPath.toLowerCase()
  const ext = path.extname(p)
  if (ext !== ".ts" && ext !== ".js" && ext !== ".java" && ext !== ".py") return false
  return (
    p.includes("/tests/") ||
    p.includes("/test/") ||
    /\.spec\.(ts|js)$/.test(p) ||
    /\.cy\.(ts|js)$/.test(p) ||
    /\.test\.(ts|js)$/.test(p) ||
    p.includes("page") ||
    p.includes("pageobject")
  )
}

/**
 * Extract cross-framework evidence from a report ZIP (outer bundle).
 * Designed to be conservative: small number of screenshots + clipped text snippets.
 */
async function extractEvidenceFromOuterHandle(outerHandle, options = {}) {
  const maxTotalImages = Math.min(60, envInt("EVIDENCE_MAX_TOTAL_IMAGES", 25))
  const maxImagesPerFolder = Math.min(15, envInt("EVIDENCE_MAX_IMAGES_PER_FOLDER", 4))
  const maxImageBytes = Math.min(2 * 1024 * 1024, envInt("EVIDENCE_MAX_IMAGE_BYTES", 524288))
  const maxTextCharsPerFile = Math.min(400000, envInt("EVIDENCE_MAX_TEXT_CHARS_PER_FILE", 60000))
  const maxLogFiles = Math.min(50, envInt("EVIDENCE_MAX_LOG_FILES", 8))
  const maxCodeFiles = Math.min(50, envInt("EVIDENCE_MAX_CODE_FILES", 3))

  const artifacts = []
  const perFolderImageCount = new Map()
  let totalImages = 0
  let logFiles = 0
  let codeFiles = 0

  const pushArtifact = (a) => {
    if (!a || !a.path) return
    artifacts.push(a)
  }

  const iterAdm = async (zip) => {
    for (const e of zip.getEntries()) {
      if (!e || e.isDirectory) continue
      const entryName = toPosix(e.entryName || "")
      if (isSkippablePath(entryName)) continue

      const ext = path.extname(entryName).toLowerCase()
      const folder = folderFromEntryName(entryName)

      if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)) {
        if (totalImages >= maxTotalImages) continue
        const cnt = perFolderImageCount.get(folder) || 0
        if (cnt >= maxImagesPerFolder) continue

        try {
          const buf = e.getData()
          if (!buf || buf.length === 0) continue
          if (buf.length > maxImageBytes) {
            pushArtifact({ kind: "image", path: entryName, folder, bytes: buf.length, skipped: "too_large" })
            continue
          }
          const mime = guessMimeFromExt(ext)
          const dataUrl = `data:${mime};base64,${buf.toString("base64")}`
          pushArtifact({ kind: "image", path: entryName, folder, bytes: buf.length, dataUrl })
          totalImages++
          perFolderImageCount.set(folder, cnt + 1)
        } catch (_) {
          // ignore unreadable entries
        }
        continue
      }

      if (looksLikeTraceFile(entryName)) {
        pushArtifact({ kind: "trace", path: entryName, folder })
        continue
      }

      if (looksLikeVideoFile(entryName)) {
        pushArtifact({ kind: "video", path: entryName, folder })
        continue
      }

      if (looksLikeLogFile(entryName) && logFiles < maxLogFiles) {
        try {
          const buf = e.getData()
          const text = clipText(buf.toString("utf8"), maxTextCharsPerFile)
          pushArtifact({ kind: "log", path: entryName, folder, text })
          logFiles++
        } catch (_) {
          // ignore
        }
        continue
      }

      if (looksLikeAutomationCode(entryName) && codeFiles < maxCodeFiles) {
        try {
          const buf = e.getData()
          const text = clipText(buf.toString("utf8"), maxTextCharsPerFile)
          pushArtifact({ kind: "code", path: entryName, folder, text })
          codeFiles++
        } catch (_) {
          // ignore
        }
      }
    }
  }

  const iterUnzipper = async (directory) => {
    const files = (directory && directory.files) || []
    for (const f of files) {
      if (!f || f.type !== "File") continue
      const entryName = toPosix(f.path || "")
      if (isSkippablePath(entryName)) continue

      const ext = path.extname(entryName).toLowerCase()
      const folder = folderFromEntryName(entryName)

      if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)) {
        if (totalImages >= maxTotalImages) continue
        const cnt = perFolderImageCount.get(folder) || 0
        if (cnt >= maxImagesPerFolder) continue

        try {
          const buf = await f.buffer()
          if (!buf || buf.length === 0) continue
          if (buf.length > maxImageBytes) {
            pushArtifact({ kind: "image", path: entryName, folder, bytes: buf.length, skipped: "too_large" })
            continue
          }
          const mime = guessMimeFromExt(ext)
          const dataUrl = `data:${mime};base64,${buf.toString("base64")}`
          pushArtifact({ kind: "image", path: entryName, folder, bytes: buf.length, dataUrl })
          totalImages++
          perFolderImageCount.set(folder, cnt + 1)
        } catch (_) {
          // ignore
        }
        continue
      }

      if (looksLikeTraceFile(entryName)) {
        pushArtifact({ kind: "trace", path: entryName, folder })
        continue
      }

      if (looksLikeVideoFile(entryName)) {
        pushArtifact({ kind: "video", path: entryName, folder })
        continue
      }

      if (looksLikeLogFile(entryName) && logFiles < maxLogFiles) {
        try {
          const buf = await f.buffer()
          const text = clipText(buf.toString("utf8"), maxTextCharsPerFile)
          pushArtifact({ kind: "log", path: entryName, folder, text })
          logFiles++
        } catch (_) {
          // ignore
        }
        continue
      }

      if (looksLikeAutomationCode(entryName) && codeFiles < maxCodeFiles) {
        try {
          const buf = await f.buffer()
          const text = clipText(buf.toString("utf8"), maxTextCharsPerFile)
          pushArtifact({ kind: "code", path: entryName, folder, text })
          codeFiles++
        } catch (_) {
          // ignore
        }
      }
    }
  }

  try {
    if (outerHandle && outerHandle.type === "adm" && outerHandle.zip) {
      await iterAdm(outerHandle.zip)
    } else if (outerHandle && outerHandle.type === "unzipper" && outerHandle.directory) {
      await iterUnzipper(outerHandle.directory)
    }
  } catch (e) {
    pushArtifact({
      kind: "meta",
      path: options.originalName || "",
      folder: "",
      text: `Evidence scan failed: ${e?.message || String(e)}`
    })
  }

  return {
    artifacts,
    meta: {
      originalName: options.originalName || "",
      totalArtifacts: artifacts.length
    }
  }
}

/**
 * Extract evidence from a "folder upload" (multer files array).
 * Uses `file.originalname` as the logical path (often contains subfolders when using webkitdirectory).
 */
async function extractEvidenceFromUploadedFiles(uploadedFiles, options = {}) {
  const maxTotalImages = Math.min(60, envInt("EVIDENCE_MAX_TOTAL_IMAGES", 25))
  const maxImagesPerFolder = Math.min(15, envInt("EVIDENCE_MAX_IMAGES_PER_FOLDER", 4))
  const maxImageBytes = Math.min(2 * 1024 * 1024, envInt("EVIDENCE_MAX_IMAGE_BYTES", 524288))
  const maxTextCharsPerFile = Math.min(400000, envInt("EVIDENCE_MAX_TEXT_CHARS_PER_FILE", 60000))
  const maxLogFiles = Math.min(50, envInt("EVIDENCE_MAX_LOG_FILES", 8))
  const maxCodeFiles = Math.min(50, envInt("EVIDENCE_MAX_CODE_FILES", 3))

  const artifacts = []
  const perFolderImageCount = new Map()
  let totalImages = 0
  let logFiles = 0
  let codeFiles = 0

  const pushArtifact = (a) => {
    if (!a || !a.path) return
    artifacts.push(a)
  }

  const files = Array.isArray(uploadedFiles) ? uploadedFiles : []

  for (const f of files) {
    if (!f || !f.path) continue

    const logicalPath = toPosix(f.originalname || f.filename || "")
    if (isSkippablePath(logicalPath)) continue

    const folder = folderFromEntryName(logicalPath)
    const ext = path.extname(logicalPath).toLowerCase()

    if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)) {
      if (totalImages >= maxTotalImages) continue
      const cnt = perFolderImageCount.get(folder) || 0
      if (cnt >= maxImagesPerFolder) continue

      try {
        const buf = await fs.readFile(f.path)
        if (!buf || buf.length === 0) continue
        if (buf.length > maxImageBytes) {
          pushArtifact({ kind: "image", path: logicalPath, folder, bytes: buf.length, skipped: "too_large" })
          continue
        }
        const mime = guessMimeFromExt(ext)
        const dataUrl = `data:${mime};base64,${buf.toString("base64")}`
        pushArtifact({ kind: "image", path: logicalPath, folder, bytes: buf.length, dataUrl })
        totalImages++
        perFolderImageCount.set(folder, cnt + 1)
      } catch (_) {
        // ignore unreadable files
      }
      continue
    }

    if (looksLikeTraceFile(logicalPath)) {
      pushArtifact({ kind: "trace", path: logicalPath, folder })
      continue
    }

    if (looksLikeVideoFile(logicalPath)) {
      pushArtifact({ kind: "video", path: logicalPath, folder })
      continue
    }

    if (looksLikeLogFile(logicalPath) && logFiles < maxLogFiles) {
      try {
        const buf = await fs.readFile(f.path)
        const text = clipText(buf.toString("utf8"), maxTextCharsPerFile)
        pushArtifact({ kind: "log", path: logicalPath, folder, text })
        logFiles++
      } catch (_) {
        // ignore
      }
      continue
    }

    if (looksLikeAutomationCode(logicalPath) && codeFiles < maxCodeFiles) {
      try {
        const buf = await fs.readFile(f.path)
        const text = clipText(buf.toString("utf8"), maxTextCharsPerFile)
        pushArtifact({ kind: "code", path: logicalPath, folder, text })
        codeFiles++
      } catch (_) {
        // ignore
      }
    }
  }

  return {
    artifacts,
    meta: {
      originalName: options.originalName || "",
      totalArtifacts: artifacts.length
    }
  }
}

function filterArtifactsForFolder(artifacts, reportFolder) {
  const folder = toPosix(reportFolder || "").replace(/\/+$/, "")
  if (!folder) return artifacts
  const prefix = folder.endsWith("/") ? folder : folder + "/"
  return artifacts.filter((a) => a && typeof a.path === "string" && toPosix(a.path).startsWith(prefix))
}

function buildEvidenceAttachmentText(artifacts, opts = {}) {
  const maxLines = Math.min(250, envInt("EVIDENCE_MAX_ATTACHMENT_LINES", 80))
  const lines = []

  const push = (s) => {
    if (!s) return
    if (lines.length >= maxLines) return
    lines.push(s)
  }

  const imgs = artifacts.filter((a) => a.kind === "image")
  const traces = artifacts.filter((a) => a.kind === "trace")
  const videos = artifacts.filter((a) => a.kind === "video")
  const logs = artifacts.filter((a) => a.kind === "log")
  const code = artifacts.filter((a) => a.kind === "code")

  if (imgs.length || traces.length || videos.length || logs.length || code.length) {
    push("EVIDENCE (auto-extracted from report bundle):")
  }

  if (imgs.length) {
    push("")
    push(`SCREENSHOTS FOUND: ${imgs.length}`)
    for (const a of imgs.slice(0, 30)) {
      push(`- ${a.path}${a.skipped ? ` (skipped: ${a.skipped})` : ""}`)
    }
  }

  if (traces.length) {
    push("")
    push(`TRACES FOUND: ${traces.length}`)
    for (const a of traces.slice(0, 20)) push(`- ${a.path}`)
  }

  if (videos.length) {
    push("")
    push(`VIDEOS FOUND: ${videos.length}`)
    for (const a of videos.slice(0, 20)) push(`- ${a.path}`)
  }

  if (logs.length) {
    push("")
    push(`LOG EXCERPTS: ${logs.length}`)
    for (const a of logs.slice(0, 5)) {
      push("")
      push(`--- LOG: ${a.path} ---`)
      push(clipText(a.text || "", envInt("EVIDENCE_MAX_LOG_CHARS_IN_ATTACHMENT", 8000)))
    }
  }

  if (code.length) {
    push("")
    push(`CODE EXCERPTS: ${code.length}`)
    for (const a of code.slice(0, 2)) {
      push("")
      push(`--- CODE: ${a.path} ---`)
      push(clipText(a.text || "", envInt("EVIDENCE_MAX_CODE_CHARS_IN_ATTACHMENT", 8000)))
    }
  }

  return lines.join("\n")
}

function pickScreenshotDataUrls(artifacts, limit) {
  const out = []
  for (const a of artifacts) {
    if (out.length >= limit) break
    if (a && a.kind === "image" && a.dataUrl) out.push(a.dataUrl)
  }
  return out
}

/**
 * Merge extracted evidence into server.js' failure objects:
 * - only adds screenshots if there are none (or very few)
 * - appends a bounded evidence summary into `attachments`
 */
function mergeEvidenceIntoFailures(failures, evidence, options = {}) {
  if (!Array.isArray(failures) || failures.length === 0) return failures
  const artifacts = (evidence && evidence.artifacts) || []
  const reportFolder = options.reportFolder || ""
  const relevant = filterArtifactsForFolder(artifacts, reportFolder)

  const maxScreensPerTest = Math.min(10, envInt("EVIDENCE_MAX_SCREENSHOTS_PER_TEST", 2))

  const attachmentText = buildEvidenceAttachmentText(relevant, options)
  const pickedShots = pickScreenshotDataUrls(relevant, maxScreensPerTest)
  const allowUnmatchedScreenshots =
    options.allowUnmatchedScreenshots === true

  for (const t of failures) {
    if (!t || typeof t !== "object") continue

    const existingShots = Array.isArray(t.screenshotDataUrls) ? t.screenshotDataUrls : []
    const needShots = existingShots.length < 1
    // IMPORTANT: Do not attach arbitrary "folder screenshots" to each failed test by default.
    // This can cause cross-test evidence leakage and wrong categorization (e.g., an alert from another test).
    if (allowUnmatchedScreenshots && needShots && pickedShots.length > 0) {
      t.screenshotDataUrls = pickedShots
    }

    if (attachmentText) {
      const existingAtt = String(t.attachments || "")
      // avoid repeated evidence blocks if called twice
      if (!existingAtt.includes("EVIDENCE (auto-extracted from report bundle):")) {
        t.attachments = existingAtt
          ? existingAtt + "\n\n" + attachmentText
          : attachmentText
      }
    }
  }

  return failures
}

module.exports = {
  extractEvidenceFromOuterHandle,
  extractEvidenceFromUploadedFiles,
  mergeEvidenceIntoFailures
}

