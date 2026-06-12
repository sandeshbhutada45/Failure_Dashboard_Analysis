const express = require("express")
const path = require("path")
const cors = require("cors")
const multer = require("multer")
const axios = require("axios")
const fs = require("fs-extra")
const AdmZip = require("adm-zip")
const unzipper = require("unzipper")

require("dotenv").config()

const app = express()

/** Per uploaded report file (multipart). Override with MAX_UPLOAD_FILE_BYTES in .env if needed. */
const DEFAULT_MAX_UPLOAD_FILE_BYTES =
  5 * 1024 * 1024 * 1024

const maxUploadFileBytes =
  Number.parseInt(
    process.env.MAX_UPLOAD_FILE_BYTES ||
      "",
    10
  )

const MAX_UPLOAD_FILE_BYTES =
  Number.isFinite(maxUploadFileBytes) &&
  maxUploadFileBytes > 0
    ? maxUploadFileBytes
    : DEFAULT_MAX_UPLOAD_FILE_BYTES

app.use(cors())
app.use(express.json())

const upload = multer({
  dest: "uploads/",
  limits: {
    files: 10,
    fileSize: MAX_UPLOAD_FILE_BYTES
  }
})

const RCA_PROMPT = require("./rcaPrompt.js")

function cleanTestName(title) {

  if (!title) {
    return ""
  }

  return title
    .replace(/@\\S+/g, "")
    .replace(/\\s+/g, " ")
    .trim()
}

const IMAGE_PATH_RE =
  /\.(png|jpe?g|webp)$/i

function isImageAttachment(a) {

  if (
    !a ||
    typeof a !== "object"
  ) {
    return false
  }

  const ct =
    (a.contentType || "")
      .toLowerCase()
      .split(";")[0]
      .trim()

  if (
    /^image\/(png|jpeg|jpg|webp)$/i.test(
      ct
    )
  ) {
    return true
  }

  const p =
    `${a.path || ""} ${a.name || ""}`.toLowerCase()

  return IMAGE_PATH_RE.test(p)
}

function mimeForAttachment(a) {

  const ct =
    (a.contentType || "")
      .toLowerCase()
      .split(";")[0]
      .trim()

  if (
    ct.startsWith("image/")
  ) {
    return ct
  }

  const p =
    (a.path || a.name || "").toLowerCase()

  if (p.endsWith(".png")) {
    return "image/png"
  }

  if (
    p.endsWith(".jpg") ||
    p.endsWith(".jpeg")
  ) {
    return "image/jpeg"
  }

  if (p.endsWith(".webp")) {
    return "image/webp"
  }

  return "image/png"
}

function collectPlaywrightAttachments(node) {

  const list = []

  if (
    !node ||
    typeof node !== "object"
  ) {
    return list
  }

  if (Array.isArray(node.attachments)) {

    list.push(
      ...node.attachments
    )
  }

  if (Array.isArray(node.results)) {

    for (const r of node.results) {

      if (
        Array.isArray(
          r.attachments
        )
      ) {

        list.push(
          ...r.attachments
        )
      }
    }
  }

  return dedupeAttachments(list)
}

function dedupeAttachments(attList) {

  const seen = new Set()

  const out = []

  for (const a of attList || []) {

    const k =
      `${a.path || ""}|${a.name || ""}|${a.contentType || ""}`

    if (seen.has(k)) {
      continue
    }

    seen.add(k)

    out.push(a)
  }

  return out
}

function readZipEntryBytes(
  zip,
  wantedPath
) {

  if (
    !wantedPath ||
    typeof wantedPath !== "string" ||
    !zip
  ) {
    return null
  }

  let norm =
    wantedPath
      .replace(/\\/g, "/")
      .trim()

  const tryPaths = new Set()

  tryPaths.add(norm)

  tryPaths.add(
    norm.replace(/^\/+/, "")
  )

  try {

    tryPaths.add(
      decodeURIComponent(
        norm.replace(/^\/+/, "")
      )
    )
  } catch (_) {

    // ignore
  }

  for (const p of tryPaths) {

    const e =
      zip.getEntry(p)

    if (
      e &&
      !e.isDirectory
    ) {
      return e.getData()
    }
  }

  const entries =
    zip.getEntries()

  for (const e of entries) {

    if (e.isDirectory) {
      continue
    }

    const en =
      e.entryName.replace(
        /\\/g,
        "/"
      )

    for (const p of tryPaths) {

      if (
        en === p ||
        en.endsWith("/" + p) ||
        p.endsWith(en)
      ) {
        return e.getData()
      }
    }
  }

  const base =
    norm
      .split("/")
      .filter(Boolean)
      .pop()

  if (base) {

    const matches =
      entries.filter(
        e => {

          if (e.isDirectory) {
            return false
          }

          const bn =
            e.entryName
              .replace(/\\/g, "/")
              .split("/")
              .pop()

          return bn === base
        }
      )

    if (
      matches.length === 1
    ) {
      return matches[0].getData()
    }
  }

  return null
}

/** Node readFile(Sync) rejects sizes > 2 GiB; adm-zip reads paths that way. */
const MAX_READFILE_SYNC_BYTES =
  2147483647

async function readZipEntryBytesFromUnzipper(
  directory,
  wantedPath
) {

  if (
    !wantedPath ||
    typeof wantedPath !== "string" ||
    !directory ||
    !Array.isArray(
      directory.files
    )
  ) {

    return null
  }

  const files =
    directory.files.filter(
      (f) =>
        f.type === "File"
    )

  let norm =
    wantedPath
      .replace(/\\/g, "/")
      .trim()

  const tryPaths = new Set()

  tryPaths.add(norm)

  tryPaths.add(
    norm.replace(/^\/+/, "")
  )

  try {

    tryPaths.add(
      decodeURIComponent(
        norm.replace(/^\/+/, "")
      )
    )
  } catch (_) {

    // ignore
  }

  for (const p of tryPaths) {

    const f =
      files.find(
        (d) =>
          String(
            d.path || ""
          )
            .replace(
              /\\/g,
              "/"
            ) === p
      )

    if (f) {

      try {

        return await f.buffer()
      } catch (_) {

        return null
      }
    }
  }

  for (const p of tryPaths) {

    for (const f of files) {

      const en =
        String(
          f.path || ""
        )
          .replace(
            /\\/g,
            "/"
          )

      if (
        en === p ||
        en.endsWith(
          "/" + p
        ) ||
        p.endsWith(
          en
        )
      ) {

        try {

          return await f.buffer()
        } catch (_) {

          return null
        }
      }
    }
  }

  const base =
    norm
      .split("/")
      .filter(Boolean)
      .pop()

  if (base) {

    const matches =
      files.filter(
        (d) => {

          const bn =
            String(
              d.path || ""
            )
              .replace(
                /\\/g,
                "/"
              )
              .split("/")
              .pop()

          return bn === base
        }
      )

    if (
      matches.length === 1
    ) {

      try {

        return await matches[0].buffer()
      } catch (_) {

        return null
      }
    }
  }

  return null
}

async function readAssetBytesAsync(
  innerZip,
  outerHandle,
  wantedPath
) {

  if (
    !wantedPath ||
    typeof wantedPath !== "string"
  ) {

    return null
  }

  let buf =
    readZipEntryBytes(
      innerZip,
      wantedPath
    )

  if (
    buf &&
    buf.length > 0
  ) {

    return buf
  }

  if (
    !outerHandle
  ) {

    return null
  }

  if (
    outerHandle.type ===
    "adm"
  ) {

    const outerZip =
      outerHandle.zip

    buf =
      readZipEntryBytes(
        outerZip,
        wantedPath
      )

    if (
      buf &&
      buf.length > 0
    ) {

      return buf
    }

    const norm =
      wantedPath.replace(/\\/g, "/")

    const dataIdx =
      norm.indexOf("data/")

    if (
      dataIdx >= 0
    ) {

      buf =
        readZipEntryBytes(
          outerZip,
          norm.slice(dataIdx)
        )

      if (
        buf &&
        buf.length > 0
      ) {

        return buf
      }
    }

    const testRes =
      norm.indexOf("test-results/")

    if (
      testRes >= 0
    ) {

      buf =
        readZipEntryBytes(
          outerZip,
          norm.slice(testRes)
        )

      if (
        buf &&
        buf.length > 0
      ) {

        return buf
      }
    }

    return null
  }

  if (
    outerHandle.type ===
    "unzipper"
  ) {

    const directory =
      outerHandle.directory

    buf =
      await readZipEntryBytesFromUnzipper(
        directory,
        wantedPath
      )

    if (
      buf &&
      buf.length > 0
    ) {

      return buf
    }

    const norm =
      wantedPath.replace(/\\/g, "/")

    const dataIdx =
      norm.indexOf("data/")

    if (
      dataIdx >= 0
    ) {

      buf =
        await readZipEntryBytesFromUnzipper(
          directory,
          norm.slice(dataIdx)
        )

      if (
        buf &&
        buf.length > 0
      ) {

        return buf
      }
    }

    const testRes =
      norm.indexOf("test-results/")

    if (
      testRes >= 0
    ) {

      buf =
        await readZipEntryBytesFromUnzipper(
          directory,
          norm.slice(testRes)
        )

      if (
        buf &&
        buf.length > 0
      ) {

        return buf
      }
    }
  }

  return null
}

/**
 * Semantic evaluator output is often written to an HTML attachment (e.g. global-chat-semantic-report.html)
 * while STDERR only says "see attachment". Merge a bounded excerpt so RCA + post-process see semantic: lines.
 */
async function appendSemanticReportAttachmentText(
  innerZip,
  outerHandle,
  attList,
  errors
) {

  if (
    !innerZip ||
    !Array.isArray(
      attList
    ) ||
    attList.length ===
      0
  ) {

    return errors || ""
  }

  const base =
    typeof errors ===
    "string"
      ? errors
      : ""

  let extra = ""

  const cap =
    Math.min(
      96000,
      Math.max(
        12000,
        parseInt(
          process.env.RCA_SEMANTIC_ATTACHMENT_MAX_CHARS ||
            "48000",
          10
        )
      )
    )

  for (const a of attList) {

    const label =
      `${a.name || ""} ${a.path || ""}`
        .toLowerCase()

    if (
      !label.includes(
        "semantic"
      ) &&
      !label.includes(
        "global-chat"
      ) &&
      !label.includes(
        "globalchat"
      )
    ) {

      continue
    }

    const p =
      a.path || ""

    if (!p) {
      continue
    }

    const buf =
      await readAssetBytesAsync(
        innerZip,
        outerHandle,
        p
      )

    if (
      !buf ||
      buf.length ===
        0
    ) {
      continue
    }

    let text = ""

    try {

      text = buf.toString(
        "utf8"
      )
    } catch (_) {

      continue
    }

    const low =
      text.toLowerCase()

    if (
      !low.includes(
        "semantic:"
      ) &&
      !low.includes(
        "semanticassertion"
      ) &&
      !low.includes(
        "similarity_score"
      ) &&
      !(
        low.includes(
          '"question"'
        ) &&
        low.includes(
          "expectedresponse"
        )
      )
    ) {

      continue
    }

    let body = text

    if (
      body.length >
      cap
    ) {

      body =
        body.slice(
          0,
          cap
        ) +
        "\n... (semantic attachment truncated for RCA)\n"
    }

    extra +=
      `\n\n=== ATTACHMENT (semantic / Helix report): ${a.name || a.path} ===\n\n` +
      body
  }

  return base + extra
}

async function extractScreenshotDataUrls(
  innerZip,
  attachments,
  limits,
  outerHandle
) {

  const urls = []

  if (
    !innerZip ||
    !Array.isArray(attachments)
  ) {
    return urls
  }

  const maxPerTest =
    limits.maxPerTest

  const maxBytes =
    limits.maxBytes

  for (const a of attachments) {

    if (
      urls.length >= maxPerTest
    ) {
      break
    }

    if (!isImageAttachment(a)) {
      continue
    }

    const p =
      a.path || ""

    if (!p) {
      continue
    }

    const buf =
      await readAssetBytesAsync(
        innerZip,
        outerHandle,
        p
      )

    if (
      !buf ||
      buf.length === 0
    ) {

      console.log(
        "SCREENSHOT ZIP MISS:",
        p
      )

      continue
    }

    if (
      buf.length > maxBytes
    ) {

      console.log(
        "SCREENSHOT TOO LARGE SKIP:",
        p,
        buf.length
      )

      continue
    }

    const mime =
      mimeForAttachment(a)

    urls.push(

      `data:${mime};base64,${buf.toString("base64")}`
    )
  }

  return urls
}

/** Playwright error blobs can exceed 20k; semantic lines often sit in STDERR after huge STEP JSON and get truncated. Hoist semantic/LLM evidence to the top for the RCA model. */
const RCA_ERROR_TEXT_MAX = 52000

function prioritizeSemanticEvidenceForRca(errors) {

  if (
    typeof errors !==
    "string"
  ) {

    return ""
  }

  if (
    errors.length ===
    0
  ) {

    return errors
  }

  const lower =
    errors.toLowerCase()

  const markers = [

    "semantic:",
    "semanticassertionresults",
    "semanticassertionjustification",
    "similarity_score",
    "helixgpt replied"
  ]

  let start = -1

  for (const m of markers) {

    const i =
      lower.indexOf(
        m
      )

    if (
      i !== -1 &&
      (
        start === -1 ||
        i < start
      )
    ) {

      start = i
    }
  }

  if (
    start === -1
  ) {

    return errors.slice(
      0,
      RCA_ERROR_TEXT_MAX
    )
  }

  const excerptLen =
    Math.min(
      18000,
      errors.length -
        start
    )

  const priority =
    errors.slice(
      start,
      start +
        excerptLen
    )

  const banner =
    "RCA_PRIORITY_SEMANTIC_OR_LLM_BLOCK (read FIRST — if every SemanticAssertionResults is PASS/matching=true, classify per POST-VALIDATION FAILURE AFTER ALL SEMANTIC PASS in FULL ERRORS below; NOT Semantic):\n\n"

  const combined =
    banner +
    priority +
    "\n\n--- FULL ERRORS/TRACE BELOW (may repeat login/URL; do not classify from URL alone if PRIORITY block above applies) ---\n\n" +
    errors

  return combined.length > RCA_ERROR_TEXT_MAX
    ? combined.slice(
        0,
        RCA_ERROR_TEXT_MAX
      )
    : combined
}

function formatFailedTestBlock(
  failedTest,
  index
) {

  const source =
    failedTest.sourceReportFolder ||
    failedTest.sourceReportPath
      ? `

SOURCE REPORT (bundle):
${failedTest.sourceReportFolder || ""}${failedTest.sourceReportFolder && failedTest.sourceReportPath ? " — " : ""}${failedTest.sourceReportPath || ""}
`
      : ""

  return `

==================================================
FAILED TEST ${index + 1}
==================================================
${source}
TEST NAME:
${failedTest.testName}

STATUS:
${failedTest.status}

ERRORS:
${failedTest.errors}

ATTACHMENTS:
${failedTest.attachments}

LOCATION:
${failedTest.location}

`
}

/**
 * Playwright stores the report zip as base64 inside index.html, usually:
 * <template id="playwrightReportBase64">data:application/zip;base64,...</template>
 * Base64 may include line breaks. Older HTML may use one long data: URL.
 */
function extractPlaywrightZipBase64FromHtml(html) {

  if (
    !html ||
    typeof html !== "string"
  ) {
    return null
  }

  const tmpl =
    html.match(
      /<template[^>]*\bid\s*=\s*["']playwrightReportBase64["'][^>]*>([\s\S]*?)<\/template>/i
    )

  if (tmpl && tmpl[1]) {

    let inner =
      tmpl[1].trim()

    const prefix =
      "data:application/zip;base64,"

    if (
      inner.startsWith(
        prefix
      )
    ) {

      inner = inner.slice(
        prefix.length
      )
    }

    const b64 =
      inner.replace(
        /\s+/g,
        ""
      )

    if (
      b64.length > 64
    ) {
      return b64
    }
  }

  const legacy =
    html.match(
      /data:application\/zip;base64,([A-Za-z0-9+/=\r\n]+)/
    )

  if (legacy && legacy[1]) {

    const b64 =
      legacy[1].replace(
        /\s+/g,
        ""
      )

    if (
      b64.length > 64
    ) {
      return b64
    }
  }

  return null
}

function isPlaywrightReportIndexHtml(
  html
) {

  if (
    !html ||
    typeof html !== "string"
  ) {

    return false
  }

  return (
    html.includes(
      "playwrightReportBase64"
    ) ||
    html.includes(
      "data:application/zip;base64,"
    )
  )
}

function listPlaywrightReportIndexHtmlEntries(
  outerZip
) {

  const out = []

  if (
    !outerZip
  ) {

    return out
  }

  const seen = new Set()

  for (const e of outerZip.getEntries()) {

    if (
      e.isDirectory
    ) {

      continue
    }

    const name =
      String(
        e.entryName || ""
      )
        .replace(
          /\\/g,
          "/"
        )

    if (
      name.includes(
        "__MACOSX/"
      )
    ) {

      continue
    }

    if (
      !/\/index\.html$/i.test(
        name
      ) &&
      !/^index\.html$/i.test(
        name
      )
    ) {

      continue
    }

    const rawSize =
      e.header?.uncompressedSize ??
      0

    if (
      rawSize >
      35 * 1024 * 1024
    ) {

      continue
    }

    let html

    try {

      html =
        e.getData()
          .toString(
            "utf8"
          )
    } catch (_) {

      continue
    }

    if (
      !isPlaywrightReportIndexHtml(
        html
      )
    ) {

      continue
    }

    if (
      seen.has(
        name
      )
    ) {

      continue
    }

    seen.add(
      name
    )

    out.push({
      entryName: name,
      html
    })
  }

  out.sort(
    (a, b) =>
      a.entryName.localeCompare(
        b.entryName
      )
  )

  return out
}

async function listPlaywrightReportIndexHtmlEntriesFromUnzipper(
  directory
) {

  const out = []

  if (
    !directory ||
    !Array.isArray(
      directory.files
    )
  ) {

    return out
  }

  const seen = new Set()

  const files =
    directory.files.filter(
      (f) =>
        f.type === "File"
    )

  for (const f of files) {

    const name =
      String(
        f.path || ""
      )
        .replace(
          /\\/g,
          "/"
        )

    if (
      name.includes(
        "__MACOSX/"
      )
    ) {

      continue
    }

    if (
      !/\/index\.html$/i.test(
        name
      ) &&
      !/^index\.html$/i.test(
        name
      )
    ) {

      continue
    }

    const rawSize =
      f.uncompressedSize ??
      0

    if (
      rawSize >
      35 * 1024 * 1024
    ) {

      continue
    }

    let html

    try {

      html =
        (
          await f.buffer()
        ).toString(
          "utf8"
        )
    } catch (_) {

      continue
    }

    if (
      !isPlaywrightReportIndexHtml(
        html
      )
    ) {

      continue
    }

    if (
      seen.has(
        name
      )
    ) {

      continue
    }

    seen.add(
      name
    )

    out.push({
      entryName: name,
      html
    })
  }

  out.sort(
    (a, b) =>
      a.entryName.localeCompare(
        b.entryName
      )
  )

  return out
}

async function openOuterZipForAnalyze(
  filePath
) {

  const st =
    await fs.stat(
      filePath
    )

  if (
    st.size <=
    MAX_READFILE_SYNC_BYTES
  ) {

    return {
      type: "adm",
      zip: new AdmZip(
        filePath
      )
    }
  }

  console.log(
    "LARGE ZIP (>= 2 GiB on disk): using unzipper random-access reader, bytes=",
    st.size
  )

  const directory =
    await unzipper.Open.file(
      filePath
    )

  return {
    type: "unzipper",
    directory
  }
}

function sourceReportFolderFromIndexEntry(
  entryName
) {

  const norm =
    String(
      entryName || ""
    )
      .replace(
        /\\/g,
        "/"
      )
      .replace(
        /\/+$/,
        ""
      )

  const m =
    norm.match(
      /^(.*)\/index\.html$/i
    )

  if (
    m &&
    m[1]
  ) {

    return m[1]
  }

  if (
    /^index\.html$/i.test(
      norm
    )
  ) {

    return ""
  }

  return norm.replace(
    /\/index\.html$/i,
    ""
  ) ||
    norm
}

function attachSourceReportMetadataToLlmRows(
  parsed,
  batch
) {

  if (
    !Array.isArray(
      parsed
    ) ||
    !Array.isArray(
      batch
    )
  ) {

    return
  }

  const norm = (s) =>
    String(
      s || ""
    )
      .replace(
        /\s+/g,
        " "
      )
      .trim()
      .toLowerCase()

  for (
    let i = 0;
    i < parsed.length;
    i++
  ) {

    const row =
      parsed[i]

    if (
      !row ||
      typeof row !== "object"
    ) {

      continue
    }

    let src =
      batch[i]

    if (
      !src ||
      norm(
        row.testName
      ) !==
        norm(
          src.testName
        )
    ) {

      src =
        batch.find(
          (b) =>
            norm(
              b.testName
            ) ===
            norm(
              row.testName
            )
        ) ||
        null
    }

    if (
      src &&
      (
        src.sourceReportFolder ||
        src.sourceReportPath
      )
    ) {

      row.sourceReportFolder =
        src.sourceReportFolder ||
        ""

      row.sourceReportPath =
        src.sourceReportPath ||
        ""
    }
  }
}

async function extractPlaywrightHtmlData(
  html,
  outerHandle = null
) {

  try {

    const b64 =
      extractPlaywrightZipBase64FromHtml(
        html
      )

    if (!b64) {

      console.log(
        "NO PLAYWRIGHT ZIP IN HTML (expected template id=playwrightReportBase64 or data:application/zip;base64,...)"
      )

      return []
    }

    console.log("PLAYWRIGHT ZIP BASE64 FOUND")

    let zipBuffer

    try {

      zipBuffer = Buffer.from(
        b64,
        "base64"
      )
    } catch (e) {

      console.log(
        "BASE64 DECODE FAILED:",
        e.message
      )

      return []
    }

    const zip = new AdmZip(
      zipBuffer
    )

    const entries = zip.getEntries()

    console.log(
      "TOTAL ZIP ENTRIES:",
      entries.length
    )

    const failedTests = []

    const processedTests = new Set()

    let failedCount = 0

    const visionLimits = {
      maxPerTest: Math.min(
        5,
        Math.max(
          1,
          parseInt(
            process.env.VISION_MAX_IMAGES_PER_TEST ||
              "2",
            10
          )
        )
      ),
      maxBytes: Math.min(
        2 * 1024 * 1024,
        Math.max(
          102400,
          parseInt(
            process.env.VISION_MAX_IMAGE_BYTES ||
              "524288",
            10
          )
        )
      )
    }

    for (const entry of entries) {

      if (
        !entry.entryName.endsWith(".json")
      ) {
        continue
      }

      try {

        const raw = entry
          .getData()
          .toString("utf8")

        const json = JSON.parse(raw)

        await traverse(json)

      } catch (err) {

        console.log(
          "SKIPPED FILE:",
          entry.entryName
        )
      }
    }

    console.log(
      "TOTAL FAILED TESTS FOUND:",
      failedCount
    )

    return failedTests

    async function traverse(node) {

      if (!node) {
        return
      }

      if (Array.isArray(node)) {

        for (const item of node) {
          await traverse(item)
        }

        return
      }

      if (typeof node === "object") {

        const title =
          node.title ||
          node.testName ||
          node.name

        const cleanedTitle =
          cleanTestName(title)

        const status =
          node.status

        const outcome =
          node.outcome

        const hasFailure =
          status === "failed" ||
          outcome === "unexpected"

        const hasTitle =
          typeof cleanedTitle === "string" &&
          cleanedTitle.length > 3

        if (
          hasFailure &&
          hasTitle
        ) {

          const uniqueKey =
            `${cleanedTitle}-${node.location?.file}-${node.location?.line}`

          if (
            !processedTests.has(uniqueKey)
          ) {

            processedTests.add(uniqueKey)

            failedCount++

            let errors = ""

            if (node.errors) {

              errors += "\\n\\nERRORS:\\n"

              errors += JSON.stringify(
                node.errors,
                null,
                2
              )
            }

            if (node.error) {

              errors += "\\n\\nERROR:\\n"

              errors += JSON.stringify(
                node.error,
                null,
                2
              )
            }

            if (
              Array.isArray(
                node.annotations
              ) &&
              node.annotations.length >
                0
            ) {

              errors +=
                "\\n\\nANNOTATIONS:\\n"

              errors +=
                JSON.stringify(
                  node.annotations,
                  null,
                  2
                )
            }

            if (node.results) {

              errors += "\\n\\nRESULTS:\\n"

              errors += JSON.stringify(
                node.results,
                null,
                2
              )

              for (const result of node.results) {

                if (result.steps) {

                  errors += "\\n\\nPLAYWRIGHT STEPS:\\n"

                  errors += JSON.stringify(
                    result.steps,
                    null,
                    2
                  )
                }

                if (result.error) {

                  errors += "\\n\\nRESULT ERROR:\\n"

                  errors += JSON.stringify(
                    result.error,
                    null,
                    2
                  )
                }

                if (result.stdout) {

                  errors += "\\n\\nSTDOUT:\\n"

                  errors += JSON.stringify(
                    result.stdout,
                    null,
                    2
                  )
                }

                if (result.stderr) {

                  errors += "\\n\\nSTDERR:\\n"

                  errors += JSON.stringify(
                    result.stderr,
                    null,
                    2
                  )
                }
              }
            }

            const attList =
              collectPlaywrightAttachments(
                node
              )

            errors =
              await appendSemanticReportAttachmentText(
                zip,
                outerHandle,
                attList,
                errors
              )

            errors =
              prioritizeSemanticEvidenceForRca(
                errors
              )

            let attachmentText = ""

            if (attList.length > 0) {

              attachmentText =
                attList
                  .map(a => {

                    return `
NAME: ${a.name || ""}
TYPE: ${a.contentType || ""}
PATH: ${a.path || ""}
`
                  })
                  .join("\\n")
            }

            const screenshotDataUrls =
              await extractScreenshotDataUrls(
                zip,
                attList,
                visionLimits,
                outerHandle
              )

            if (
              screenshotDataUrls.length > 0
            ) {

              console.log(
                "SCREENSHOTS LOADED:",
                cleanedTitle,
                screenshotDataUrls.length
              )
            }

            failedTests.push({

              testName: cleanedTitle,

              status:
                status || "unknown",

              errors,

              attachments:
                attachmentText.substring(
                  0,
                  5000
                ),

              location:
                JSON.stringify(
                  node.location || {},
                  null,
                  2
                ),

              screenshotDataUrls
            })
          }
        }

        for (const key in node) {
          await traverse(node[key])
        }
      }
    }

  } catch (err) {

    console.log(
      "HTML EXTRACTION ERROR"
    )

    console.log(err.message)

    return []
  }
}

app.post(
  "/analyze",
  upload.array("reports"),
  async (req, res) => {

    try {

      console.log("ANALYZE API HIT")

      if (
        !req.files ||
        req.files.length === 0
      ) {

        return res.status(400).json({
          error:
            "No files uploaded"
        })
      }

      let allFailedTests = []

      for (const file of req.files) {

        console.log(
          "PROCESSING FILE:",
          file.originalname
        )
      
        const lower =
          file.originalname.toLowerCase()
      
        // =====================================
        // ZIP REPORT
        // =====================================
      
        if (
          lower.endsWith(".zip")
        ) {
      
          console.log(
            "ZIP REPORT DETECTED"
          )
      
          try {

            const outerHandle =
              await openOuterZipForAnalyze(
                file.path
              )

            let reportEntries

            if (
              outerHandle.type ===
              "adm"
            ) {

              reportEntries =
                listPlaywrightReportIndexHtmlEntries(
                  outerHandle.zip
                )
            } else {

              reportEntries =
                await listPlaywrightReportIndexHtmlEntriesFromUnzipper(
                  outerHandle.directory
                )
            }

            const zipStem =
              file.originalname.replace(
                /\.zip$/i,
                ""
              )

            const tagExtracted = (
              extracted,
              entryName
            ) => {

              if (
                !extracted ||
                extracted.length ===
                  0
              ) {

                return
              }

              const folder =
                sourceReportFolderFromIndexEntry(
                  entryName
                ) ||
                zipStem

              for (const t of extracted) {

                t.sourceReportFolder =
                  folder

                t.sourceReportPath =
                  String(
                    entryName || ""
                  )
                    .replace(
                      /\\/g,
                      "/"
                    )
              }

              allFailedTests.push(
                ...extracted
              )
            }

            if (
              reportEntries.length >
              0
            ) {

              console.log(
                "PLAYWRIGHT INDEX.HTML ENTRIES IN ZIP:",
                reportEntries.length,
                reportEntries.map(
                  (r) =>
                    r.entryName
                )
              )

              for (const {
                entryName,
                html
              } of reportEntries) {

                const extracted =
                  await extractPlaywrightHtmlData(
                    html,
                    outerHandle
                  )

                tagExtracted(
                  extracted,
                  entryName
                )
              }
            } else if (
              outerHandle.type ===
              "adm"
            ) {

              const htmlEntry =
                outerHandle.zip
                  .getEntries()
                  .find(
                    (e) =>
                      !e.isDirectory &&
                      e.entryName
                        .toLowerCase()
                        .endsWith(
                          "index.html"
                        ) &&
                      !String(
                        e.entryName
                      )
                        .replace(
                          /\\/g,
                          "/"
                        )
                        .includes(
                          "__MACOSX/"
                        )
                  )

              if (!htmlEntry) {

                console.log(
                  "index.html not found in zip"
                )

                continue
              }

              const htmlContent =
                htmlEntry
                  .getData()
                  .toString("utf8")

              const extracted =
                await extractPlaywrightHtmlData(
                  htmlContent,
                  outerHandle
                )

              tagExtracted(
                extracted,
                htmlEntry.entryName.replace(
                  /\\/g,
                  "/"
                )
              )
            } else {

              const files =
                outerHandle.directory.files.filter(
                  (f) =>
                    f.type === "File"
                )

              const htmlFile =
                files.find(
                  (f) => {

                    const n =
                      String(
                        f.path || ""
                      )
                        .toLowerCase()

                    return (
                      n.endsWith(
                        "index.html"
                      ) &&
                      !n.includes(
                        "__macosx/"
                      )
                    )
                  }
                )

              if (!htmlFile) {

                console.log(
                  "index.html not found in zip"
                )

                continue
              }

              const htmlContent =
                (
                  await htmlFile.buffer()
                ).toString(
                  "utf8"
                )

              const extracted =
                await extractPlaywrightHtmlData(
                  htmlContent,
                  outerHandle
                )

              tagExtracted(
                extracted,
                String(
                  htmlFile.path || ""
                ).replace(
                  /\\/g,
                  "/"
                )
              )
            }

          } catch (err) {
      
            console.log(
              "ZIP PROCESSING ERROR"
            )
      
            console.log(
              err.message
            )
          }
        }
      
        // =====================================
        // HTML REPORT
        // =====================================
      
        else if (
          lower.endsWith(".html") ||
          lower.endsWith(".htm")
        ) {
      
          const content =
            await fs.readFile(
              file.path,
              "utf8"
            )
      
          console.log(
            "PLAYWRIGHT HTML REPORT DETECTED"
          )
      
          const extracted =
            await extractPlaywrightHtmlData(
              content
            )
      
          if (
            extracted &&
            extracted.length > 0
          ) {
      
            allFailedTests.push(
              ...extracted
            )
          }
        }
      
        // =====================================
        // JSON REPORT
        // =====================================
      
        else if (
          lower.endsWith(".json")
        ) {
      
          const content =
            await fs.readFile(
              file.path,
              "utf8"
            )
      
          console.log(
            "JSON REPORT DETECTED"
          )
      
          allFailedTests.push({
      
            testName:
              cleanTestName(
                file.originalname
              ),
      
            status: "unknown",
      
            errors:
              content.substring(
                0,
                20000
              ),
      
            attachments: "",
      
            location: "{}",
      
            screenshotDataUrls: []
          })
        }
      }

      console.log(
        "TOTAL FAILED TESTS:",
        allFailedTests.length
      )

      if (
        allFailedTests.length === 0
      ) {

        const names =
          (req.files || [])
            .map(f => f.originalname)
            .join(", ")

        return res.status(400).json({

          error:

            "Could not extract failed tests from the uploaded file(s). " +

            "Use Playwright’s full index.html (with embedded report data), or a raw .json snippet. " +

            "Only failed / unexpected tests are analyzed. " +

            `(Received: ${names || "no filenames"})`
        })
      }

      const finalResults = []

      const BATCH_SIZE = 5

      for (
        let i = 0;
        i < allFailedTests.length;
        i += BATCH_SIZE
      ) {

        const batch =
          allFailedTests.slice(
            i,
            i + BATCH_SIZE
          )

        console.log(
          `PROCESSING BATCH ${
            i / BATCH_SIZE + 1
          }`
        )

        let combinedPayload = ""

        batch.forEach(
          (failedTest, index) => {

            combinedPayload +=
              formatFailedTestBlock(
                failedTest,
                index
              )
          }
        )

        const visionEnabled =
          process.env.RCA_VISION !== "0"

        const hasScreenshots =
          batch.some(
            (t) =>
              (
                t.screenshotDataUrls ||
                []
              ).length > 0
          )

        let userContent =
          combinedPayload

        if (
          visionEnabled &&
          hasScreenshots
        ) {

          const maxImgReq =
            Math.min(
              20,
              Math.max(
                1,
                parseInt(
                  process.env
                    .VISION_MAX_IMAGES_PER_REQUEST ||
                    "10",
                  10
                )
              )
            )

          let imgBudget =
            maxImgReq

          const introVision =
            "Each FAILED TEST section is followed by that test's screenshot images (image_url) when present. Use visible UI, layout, modals, and toasts together with stack traces and steps.\n\n"

          const userParts =
            [
              {
                type: "text",
                text: introVision
              }
            ]

          for (
            let idx = 0;
            idx < batch.length;
            idx++
          ) {

            userParts.push({
              type: "text",
              text:
                formatFailedTestBlock(
                  batch[idx],
                  idx
                )
            })

            for (const dataUrl of
              batch[idx]
                .screenshotDataUrls || []
            ) {

              if (
                imgBudget <= 0
              ) {
                break
              }

              userParts.push({
                type: "image_url",
                image_url: {
                  url: dataUrl,
                  detail: "low"
                }
              })

              imgBudget--
            }
          }

          userContent = userParts
        }

        const requestBody = {

          messages: [

            {
              role: "system",
              content:
                RCA_PROMPT
            },

            {
              role: "user",
              content:
                userContent
            }
          ],

          temperature: 0,

          frequency_penalty: 0,

          presence_penalty: 0,

          max_completion_tokens: 8192
        }

        try {

          let response
        
            console.log(
              "CALLING HELIXGPT...",
              {
                batchSize: batch.length,
                visionEnabled,
                hasScreenshots
              }
            )
        
          try {
        
            console.log(
              "REQUEST BODY SIZE:",
              JSON.stringify(requestBody).length
            )
            
            response =
              await axios.post(

                process.env.HELIXGPT_API_URL,

                requestBody,

                {
                  headers: {

                    "Content-Type":
                      "application/json",

                    "api-key":
                      process.env.HELIXGPT_API_KEY
                  },

                  timeout: 180000
                }
              )

              console.log(
                "HELIXGPT RESPONSE STATUS:",
                response.status
              )

          } catch (firstErr) {

            const wasMultimodal =
              Array.isArray(userContent)

            if (!wasMultimodal) {

              throw firstErr
            }

            console.log(
              "MULTIMODAL REQUEST FAILED — RETRY TEXT-ONLY:",
              firstErr.response?.data ||
                firstErr.message
            )

            requestBody.messages[1].content =

              `${combinedPayload}\n\n(NOTE: Screenshot images could not be sent to the model; use attachment paths and text only.)`

            response =
              await axios.post(

                process.env.HELIXGPT_API_URL,

                requestBody,

                {
                  headers: {

                    "Content-Type":
                      "application/json",

                    "api-key":
                      process.env.HELIXGPT_API_KEY
                  },

                  timeout: 120000
                }
              )
          }

          const result =
            response.data
              ?.choices?.[0]
              ?.message?.content

          if (!result) {

            console.log(
              "EMPTY LLM RESPONSE"
            )

            continue
          }

          try {

            const parsed =
  JSON.parse(result)

console.log(
  "========== GPT RESPONSE =========="
)

console.log(
  JSON.stringify(
    parsed,
    null,
    2
  )
)

console.log(
  "=================================="
)

if (Array.isArray(parsed)) {

  attachSourceReportMetadataToLlmRows(
    parsed,
    batch
  )

  finalResults.push(
    ...parsed
  )

} else {

  attachSourceReportMetadataToLlmRows(
    [parsed],
    batch.slice(
      0,
      1
    )
  )

  finalResults.push(
    parsed
  )
}

          } catch (err) {

            console.log(
              "JSON PARSE ERROR"
            )

            console.log(result)
          }

        } catch (err) {

          console.log(
            "LLM API ERROR"
          )

          console.log(
            "FULL ERROR:"
          )
          
          console.dir(
            err.response?.data ||
            err,
            { depth: null }
          )
        }
      }

      if (
        finalResults.length === 0 &&
        allFailedTests.length > 0
      ) {

        return res.status(503).json({
          error:
            "The model returned no usable JSON for any batch. Check the server terminal (LLM_API_ERROR / JSON PARSE ERROR) and HELIXGPT_API_URL / HELIXGPT_API_KEY in server/.env."
        })
      }

      res.json(finalResults)

    } catch (error) {

      console.log(
        "FULL SERVER ERROR"
      )

      console.log(
        error.response?.data ||
        error.message
      )

      res.status(500).json({

        error:
          error.response?.data ||
          error.message
      })
    }
  }
)

/** Production: serve Vite build so one process hosts UI + API (same origin, POST /analyze). */
const clientDist = path.join(
  __dirname,
  "..",
  "client",
  "dist"
)

if (
  fs.existsSync(clientDist)
) {

  app.use(
    express.static(
      clientDist
    )
  )

  app.get(
    "*",
    (req, res, next) => {

      if (
        req.method !==
        "GET"
      ) {

        return next()
      }

      if (
        req.path.startsWith(
          "/analyze"
        )
      ) {

        return res.status(404).send(
          "Use POST /analyze"
        )
      }

      res.sendFile(
        path.join(
          clientDist,
          "index.html"
        )
      )
    }
  )

  console.log(
    "Serving static UI from:",
    clientDist
  )
}

app.use(
  (err, req, res, next) => {

    if (
      err instanceof multer.MulterError
    ) {

      if (
        err.code ===
        "LIMIT_FILE_COUNT"
      ) {

        return res.status(400).json({
          error:
            "Maximum 10 report files per request"
        })
      }

      if (
        err.code ===
        "LIMIT_FILE_SIZE"
      ) {

        const gb =
          (
            MAX_UPLOAD_FILE_BYTES /
            (1024 * 1024 * 1024)
          ).toFixed(1)

        return res.status(413).json({
          error:
            `A report file exceeded the maximum size (${gb} GB per file). Split the archive or raise MAX_UPLOAD_FILE_BYTES in server .env.`
        })
      }

      return res.status(400).json({
        error: err.message
      })
    }

    next(err)
  }
)

const port =
  Number.parseInt(
    process.env.PORT ||
      "8080",
    10
  ) ||
  8080

app.listen(
  port,
  "0.0.0.0",
  () => {

    console.log(
      `SERVER RUNNING ON PORT ${port} (bind 0.0.0.0)`
    )
  }
)