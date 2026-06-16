const {
  detectFramework
} = require("./parsers/frameworkDetector");

const {
  extractPlaywrightHtmlData
} = require("./parsers/playwrightParser");

const {
  extractCypressFailures
} = require("./parsers/cypressParser");

const {
  extractGenericFailures
} = require("./parsers/genericParser");

const {
  extractEvidenceFromOuterHandle,
  extractEvidenceFromUploadedFiles,
  mergeEvidenceIntoFailures
} = require("./parsers/evidenceExtractor");

const {
  extractFailuresFromXml
} = require("./parsers/xmlParser");

const {
  extractFailuresFromTextLog
} = require("./parsers/textLogParser");

const {
  extractAllureFailuresFromFiles,
  isAllureResultsBundle
} = require("./parsers/allureParser");

const {
  extractExtentFailures
} = require("./parsers/extentParser");

const express = require("express")
const path = require("path")
const cors = require("cors")
const multer = require("multer")
const axios = require("axios")
const fs = require("fs-extra")
const AdmZip = require("adm-zip")
const unzipper = require("unzipper")

// Load server/.env regardless of current working directory (npm run start:prod from repo root).
require("dotenv").config({
  path: path.join(__dirname, ".env")
})

// =============================================================================
// Inlined (single-file server): was rcaEvidenceModel.js, reportJsonAdapters.js,
// testNgHtmlAdapter.js — do not require those paths.
// =============================================================================

function createFailureObject(input) {

  const {
    traceOrTimeline,
    errors: inputErrors,
    attachments = "",
    screenshotDataUrls = [],
    location = "{}",
    status = "failed",
    testName = "",
    framework = "unknown",
    ...rest
  } =
    input ||
    {}

  const errors =
    inputErrors !== undefined && inputErrors !== null
      ? typeof inputErrors === "string"
        ? inputErrors
        : JSON.stringify(inputErrors, null, 2)
      : traceOrTimeline !== undefined && traceOrTimeline !== null
        ? typeof traceOrTimeline === "string"
          ? traceOrTimeline
          : JSON.stringify(traceOrTimeline, null, 2)
        : ""

  const loc =
    typeof location === "string"
      ? location
      : JSON.stringify(location || {}, null, 2)

  return {
    framework,
    testName: String(testName || ""),
    status: String(status || "failed"),
    location: loc,
    errors,
    attachments: String(attachments || ""),
    screenshotDataUrls: Array.isArray(screenshotDataUrls) ? screenshotDataUrls : [],
    ...rest
  }
}

const MAX_JSON_TRACE_CHARS = 200000

function clipJsonReport(content) {

  const s = String(content || "")

  return s.length > MAX_JSON_TRACE_CHARS
    ? s.slice(0, MAX_JSON_TRACE_CHARS) + "\n…(truncated)…"
    : s
}

function attachmentLinesFromMochaContext(test) {

  const c = test && test.context

  if (!c) {
    return ""
  }

  if (typeof c === "string") {
    return c
  }

  if (Array.isArray(c)) {
    return c
      .map((x) => {

        if (!x || typeof x !== "object") {
          return String(x)
        }

        return `${x.title || ""}: ${x.value || ""}`
      })
      .filter(Boolean)
      .join("\n")
  }

  try {
    return JSON.stringify(c, null, 2)
  } catch {

    return String(c)
  }
}

function flattenMochaSuite(suite, chain, acc) {

  const title = suite && suite.title

  const chainNext = title ? [...chain, title] : [...chain]

  for (const test of suite.tests || []) {

    const failed =
      test.state === "failed" ||
      test.state === "broken" ||
      test.fail === true

    if (!failed) {
      continue
    }

    const fullTitle =
      test.fullTitle ||
      [...chainNext, test.title || ""].filter(Boolean).join(" › ")

    let errText = ""

    if (test.err) {

      if (typeof test.err === "string") {
        errText = test.err
      } else {
        errText = [test.err.message, test.err.stack, test.err.estack]
          .filter(Boolean)
          .join("\n")
      }
    }

    acc.push(
      createFailureObject({
        framework: "cypress",
        testName: cleanTestName(fullTitle),
        status: test.state || "failed",
        location: JSON.stringify(
          { file: test.file || "", title: fullTitle },
          null,
          2
        ),
        traceOrTimeline:
          errText || "(no error object in Mochawesome JSON)",
        attachments: attachmentLinesFromMochaContext(test),
        screenshotDataUrls: []
      })
    )
  }

  for (const child of suite.suites || []) {
    flattenMochaSuite(child, chainNext, acc)
  }
}

function extractMochawesomeFailures(parsed) {

  const out = []

  for (const block of parsed.results || []) {

    for (const root of block.suites || []) {
      flattenMochaSuite(root, [], out)
    }
  }

  if (out.length === 0 && Array.isArray(parsed.suites)) {

    for (const root of parsed.suites) {
      flattenMochaSuite(root, [], out)
    }
  }

  return out
}

function isLikelyMochawesomeJson(parsed) {

  if (!parsed || typeof parsed !== "object") {
    return false
  }

  if (Array.isArray(parsed.results) && parsed.results.length > 0) {
    return true
  }

  if (parsed.stats && Array.isArray(parsed.suites)) {
    return true
  }

  return false
}

function isLikelyPlaywrightListJson(parsed) {

  if (!parsed || typeof parsed !== "object") {
    return false
  }

  if (Array.isArray(parsed.suites)) {
    return true
  }

  if (Array.isArray(parsed.projects)) {
    return true
  }

  if (parsed.root && Array.isArray(parsed.root.suites)) {
    return true
  }

  return false
}

function buildPlaywrightDiagnosticsTextFromJson(node) {

  let errors = ""

  if (node.errors) {
    errors += "\n\nERRORS:\n" + JSON.stringify(node.errors, null, 2)
  }

  if (node.error) {
    errors +=
      "\n\nERROR:\n" +
      (node.error.message || "") +
      "\n" +
      (node.error.stack || "")
  }

  if (node.stderr) {
    errors += "\n\nSTDERR:\n" + String(node.stderr)
  }

  if (node.stdout) {
    errors += "\n\nSTDOUT:\n" + String(node.stdout)
  }

  return errors
}

function extractPlaywrightFailuresFromJson(parsed, originalFilename, options = {}) {

  const out = []
  const processed = new Set()

  const visitSuite = (suite, ancestors, defaultFile) => {

    const suiteTitle = suite.title || ""

    const prefix = [...ancestors, suiteTitle].filter(Boolean).join(" › ")

    const file = suite.file || defaultFile || ""

    for (const spec of suite.specs || []) {

      const specTitle = [prefix, spec.title || ""].filter(Boolean).join(" › ")

      for (const test of spec.tests || []) {

        const results =
          Array.isArray(test.results) && test.results.length > 0
            ? test.results
            : [test]

        for (const result of results) {

          const status = result.status || test.status

          const failed =
            status === "failed" ||
            status === "timedOut" ||
            status === "unexpected"

          if (!failed) {
            continue
          }

          const title = test.title || spec.title || "test"

          const cleanedTitle = cleanTestName(
            [specTitle, title].filter(Boolean).join(" › ")
          )

          const loc =
            result.location ||
            test.location || {
              file,
              line: suite.line,
              column: suite.column
            }

          const uniqueKey =
            `${cleanedTitle}-${(loc && loc.file) || ""}-${(loc && loc.line) || ""}`

          if (processed.has(uniqueKey)) {
            continue
          }

          processed.add(uniqueKey)

          let errors = buildPlaywrightDiagnosticsTextFromJson(result)

          const attList = collectPlaywrightAttachments(result)

          if (attList.length > 0) {
            errors +=
              "\n\nATTACHMENTS:\n" +
              attList
                .map(
                  (a) =>
                    `NAME: ${a.name || ""}\nTYPE: ${a.contentType || ""}\nPATH: ${a.path || ""}`
                )
                .join("\n")
          }

          if (typeof options.prioritizeSemantic === "function") {
            errors = options.prioritizeSemantic(errors)
          }

          out.push(
            createFailureObject({
              framework: "playwright",
              testName: cleanedTitle,
              status: status || "failed",
              location: JSON.stringify(loc || {}, null, 2),
              traceOrTimeline:
                errors || "(no diagnostics in JSON result)",
              attachments: "",
              screenshotDataUrls: []
            })
          )
        }
      }
    }

    for (const child of suite.suites || []) {
      visitSuite(
        child,
        [...ancestors, suiteTitle].filter(Boolean),
        file
      )
    }
  }

  const roots = []

  if (Array.isArray(parsed.suites)) {
    roots.push(...parsed.suites)
  }

  if (parsed.root && Array.isArray(parsed.root.suites)) {
    roots.push(...parsed.root.suites)
  }

  if (Array.isArray(parsed.projects)) {

    for (const p of parsed.projects) {

      for (const s of p.suites || []) {
        visitSuite(s, [p.name || ""], s.file || "")
      }
    }
  } else {

    for (const s of roots) {
      visitSuite(s, [], s.file || "")
    }
  }

  return out
}

function inferGenericFramework(parsed, filename) {

  const blob = `${JSON.stringify(parsed)}\n${filename}`.toLowerCase()

  if (blob.includes("selenium") || blob.includes("webdriver")) {
    return "selenium"
  }

  if (blob.includes("cypress")) {
    return "cypress"
  }

  if (blob.includes("playwright")) {
    return "playwright"
  }

  return "unknown"
}

function failuresFromMochawesomeEmbeddedHtml(html) {

  if (!html || typeof html !== "string") {
    return null
  }

  const low = html.toLowerCase()

  if (!low.includes("mochawesome") || !/\bdata-raw\s*=\s*"/i.test(html)) {
    return null
  }

  const m = html.match(/<body[^>]*\bdata-raw\s*=\s*"([^"]*)"/i)

  if (!m || !m[1]) {
    return []
  }

  try {

    const s = m[1]
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")

    return extractMochawesomeFailures(JSON.parse(s))
  } catch {

    return []
  }
}

async function tryExtractFailuresFromReportHtml(
  html,
  outerHandle = null,
  entryName = ""
) {
  // 1) Specific known HTML reports first
  if (isTestNgReportHtml(html)) {
    const rows = extractTestNgFailuresFromHtml(html)
    return rows.map((r) =>
      createFailureObject({
        framework: "testng",
        ...r,
        sourceReportPath: entryName || ""
      })
    )
  }

  // 2) Cypress Mochawesome HTML (embedded JSON in <body data-raw="...">)
  const cy = failuresFromMochawesomeEmbeddedHtml(html)
  if (cy !== null) {
    if (cy.length > 0) {
      console.log(
        "CYPRESS MOCHAWESOME HTML:",
        entryName || "",
        cy.length
      )
    }
    // Ensure source tagging.
    return cy.map((r) => ({
      ...r,
      sourceReportPath: r.sourceReportPath || entryName || ""
    }))
  }

  // 3) Detect and route
  const framework =
    detectFramework(
      String(html || ""),
      entryName || ""
    )

  let extracted = []

  try {
    if (framework === "playwright") {
      extracted =
        await extractPlaywrightHtmlData(
          html,
          outerHandle
        )
    } else if (framework === "extent") {
      extracted =
        await extractExtentFailures(
          html,
          entryName || ""
        )
    } else if (framework === "cypress") {
      extracted =
        await extractCypressFailures(
          html
        )
    } else {
      extracted =
        await extractGenericFailures(
          html
        )
    }
  } catch (e) {
    console.log(
      "HTML EXTRACT ROUTE ERROR:",
      e?.message || String(e)
    )
    extracted = []
  }

  // Normalize to server failure object shape.
  const normalized =
    (extracted || [])
      .map((r) => {
        if (!r || typeof r !== "object") return null

        // Already in server.js failure shape
        if ("errors" in r || "traceOrTimeline" in r) {
          return {
            ...r,
            framework: r.framework || framework || "unknown",
            sourceReportPath: r.sourceReportPath || entryName || ""
          }
        }

        // commonFailure.js shape
        const mergedErrors =
          [
            r.stackTrace,
            r.errorMessage,
            r.testSteps,
            r.logs
          ]
            .filter(Boolean)
            .join("\n\n")

        return createFailureObject({
          framework: r.framework || framework || "unknown",
          testName: r.testName || "",
          status: r.status || "failed",
          location: r.location || "{}",
          traceOrTimeline: mergedErrors || "(no extracted error text)",
          attachments: r.attachments || "",
          screenshotDataUrls: r.screenshotDataUrls || [],
          sourceReportPath: entryName || ""
        })
      })
      .filter(Boolean)

  return normalized
}

function extractJsonReportFailures(
  content,
  originalFilename = "",
  options = {}
) {

  let parsed

  try {
    parsed = JSON.parse(content)
  } catch {

    return [
      createFailureObject({
        framework: "unknown",
        testName: cleanTestName(originalFilename || "Uploaded JSON report"),
        status: "unknown",
        traceOrTimeline: clipJsonReport(content),
        attachments: "",
        location: "{}",
        screenshotDataUrls: []
      })
    ]
  }

  if (isLikelyMochawesomeJson(parsed)) {

    const m = extractMochawesomeFailures(parsed)

    if (m.length > 0) {
      return m
    }
  }

  if (isLikelyPlaywrightListJson(parsed)) {

    const pw = extractPlaywrightFailuresFromJson(
      parsed,
      originalFilename,
      options
    )

    if (pw.length > 0) {
      return pw
    }
  }

  return [
    createFailureObject({
      framework: inferGenericFramework(parsed, originalFilename),
      testName: cleanTestName(originalFilename || "Uploaded JSON report"),
      status: "unknown",
      traceOrTimeline: clipJsonReport(JSON.stringify(parsed, null, 2)),
      attachments: "",
      location: "{}",
      screenshotDataUrls: []
    })
  ]
}

function dedupeByTestName(rows) {

  const seen = new Set()
  const out = []

  for (const r of rows) {

    const k = String(r.testName || "")
      .trim()
      .toLowerCase()

    if (!k || seen.has(k)) {
      continue
    }

    seen.add(k)
    out.push(r)
  }

  return out
}

function isTestNgReportHtml(html) {

  if (!html || typeof html !== "string") {
    return false
  }

  const l = html.toLowerCase()

  if (!l.includes("testng")) {
    return false
  }

  // Standard TestNG emailable HTML uses this title (no literal "emailable report" text).
  if (
    l.includes("testng report") ||
    l.includes("<table id='summary'>") ||
    l.includes("<table id=\"summary\">")
  ) {
    return true
  }

  return (
    l.includes("reporter output") ||
    l.includes("test results") ||
    l.includes("invoked methods") ||
    l.includes("test method") ||
    l.includes("emailable report")
  )
}

/** Pull data:image/* URLs from a TestNG method detail slice (emailable &lt;img src="data:...">). */
function extractTestNgInlineDataScreenshots(htmlSlice) {

  const out = []

  if (
    !htmlSlice ||
    typeof htmlSlice !== "string"
  ) {
    return out
  }

  const maxBytes =
    Math.max(
      4096,
      parseInt(
        process.env.VISION_MAX_IMAGE_BYTES ||
          "524288",
        10
      )
    )

  const maxPerTest =
    Math.min(
      4,
      Math.max(
        1,
        parseInt(
          process.env.VISION_MAX_IMAGES_PER_TEST ||
            "2",
          10
        )
      )
    )

  const re =
    /<img\b[^>]*?\bsrc\s*=\s*["'](data:image\/(?:png|jpe?g|webp);base64,[^"']+)["']/gi

  let im

  while (
    (im = re.exec(htmlSlice)) !== null &&
    out.length < maxPerTest
  ) {

    const u =
      String(
        im[1] ||
          ""
      ).replace(
        /\s+/g,
        ""
      )

    if (
      u.length > maxBytes ||
      u.length < 200
    ) {
      continue
    }

    out.push(u)
  }

  return out
}

/**
 * Anchor ids (#m8, #m45, …) from the emailable **summary** table only: links that
 * appear under a "… — failed" / "… - failed" subsection (not retried / passed).
 * Matches the report's **# Failed** rows the user clicks to open detail.
 */
function collectTestNgSummaryFailedAnchorIds(html) {

  const ids = new Set()

  if (
    !html ||
    typeof html !== "string"
  ) {
    return ids
  }

  const summaryMatch =
    html.match(
      /<table[^>]*\bid\s*=\s*['"]summary['"][^>]*>([\s\S]*?)<\/table>/i
    )

  if (!summaryMatch) {
    return ids
  }

  const summary = summaryMatch[1]

  const subsectionRe =
    /<tr>\s*<th[^>]*colspan[^>]*>[\s\S]*?(?:—|&#8212;|&mdash;|-)\s*failed[\s\S]*?<\/th>\s*<\/tr>([\s\S]*?)(?=<tr>\s*<th[^>]*colspan|<\/tbody>)/gi

  let sm

  while ((sm = subsectionRe.exec(summary)) !== null) {

    const chunk = sm[1]

    const aRe = /<a\s+href="#(m\d+)"/gi

    let am

    while ((am = aRe.exec(chunk)) !== null) {
      ids.add(am[1])
    }
  }

  return ids
}

/** TestNG emailable: <h3 id="m#">full.class#method</h3> + <div class="stacktrace">… */
function extractTestNgEmailableDetailBlocks(html) {

  const rough = []

  if (
    !html ||
    typeof html !== "string"
  ) {
    return rough
  }

  const hasEmailableShape =
    /<title>\s*TestNG\s+Report\s*<\/title>/i.test(html) ||
    (
      /<table[^>]*\bid=['"]summary['"][^>]*>/i.test(html) &&
      /class=['"](?:failed|failedeven|failedodd|retried)/i.test(html)
    )

  if (!hasEmailableShape) {
    return rough
  }

  const failedOnlyAnchors =
    collectTestNgSummaryFailedAnchorIds(
      html
    )

  const decodeEntities = (s) =>
    String(s || "")
      .replace(/&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&#8212;/g, "—")

  const h3Re = /<h3\s+id="m\d+"[^>]*>([^<]+)<\/h3>/gi

  let m

  while ((m = h3Re.exec(html)) !== null) {

    const idFromH3 =
      m[0].match(
        /\bid\s*=\s*["'](m\d+)["']/i
      )

    const anchorId =
      idFromH3
        ? idFromH3[1]
        : ""

    const baseName =
      decodeEntities(
        String(m[1] || "").trim()
      )

    if (
      !baseName ||
      !baseName.includes("#")
    ) {
      continue
    }

    // Summary table shows the method name only (right-hand link text); match that for RCA labels.
    const methodOnly =
      baseName
        .slice(
          baseName.indexOf("#") +
            1
        )
        .trim()

    const testName =
      methodOnly ||
      baseName

    if (
      failedOnlyAnchors.size >
        0 &&
      anchorId &&
      !failedOnlyAnchors.has(
        anchorId
      )
    ) {
      continue
    }

    const afterH3 =
      html.slice(
        m.index +
          m[0].length
      )

    const nextHead =
      afterH3.search(
        /<h[23]\b/i
      )

    const slice =
      nextHead === -1
        ? afterH3
        : afterH3.slice(
            0,
            nextHead
          )

    const sliceNoImg =
      slice.replace(
        /<img\b[\s\S]*?>/gi,
        " [screenshot] "
      )

    const stacks = [
      ...sliceNoImg.matchAll(
        /<div\s+class="stacktrace">([\s\S]*?)<\/div>/gi
      )
    ]

    if (stacks.length === 0) {
      continue
    }

    const traceParts =
      stacks.map(
        (st) =>
          decodeEntities(
            st[1]
              .replace(
                /<br\s*\/?>/gi,
                "\n"
              )
              .replace(
                /<[^>]+>/g,
                " "
              )
              .replace(
                /\s+/g,
                " "
              )
              .trim()
          )
      )
        .filter(
          (t) =>
            t.length >
            40
        )

    const trace =
      traceParts.join(
        "\n\n---\n\n"
      )

    if (
      !trace ||
      trace.length <
      40
    ) {
      continue
    }

    rough.push({
      testName,
      status: "failed",
      location: "{}",
      traceOrTimeline: trace.slice(
        0,
        12000
      ),
      attachments: "",
      screenshotDataUrls:
        extractTestNgInlineDataScreenshots(
          slice
        )
    })
  }

  // Keep every <h3 id="m#"> block distinct — failed vs retried can share the same
  // class#method string; dedupeByTestName would merge the wrong detail into one row.
  return rough
}

function extractTestNgFailuresFromHtml(html) {

  const fromEmailable =
    extractTestNgEmailableDetailBlocks(
      html
    )

  if (
    fromEmailable.length >
    0
  ) {
    return fromEmailable
  }

  const rough = []
  const rowRe = /<tr[^>]*>[\s\S]{0,4000}?<\/tr>/gi

  let m

  while ((m = rowRe.exec(html)) !== null) {

    const chunk = m[0]

    if (!/FAILED|FAILURE/i.test(chunk)) {
      continue
    }

    const stripped = chunk.replace(/<script[\s\S]*?<\/script>/gi, "")

    const text = stripped
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()

    const nameGuess =
      stripped.match(/title\s*=\s*"([^"]{4,240})"/i) ||
      stripped.match(/>([A-Za-z0-9_.:[\]\s-]{6,200})<\/a>/i)

    const testName = nameGuess && nameGuess[1]
      ? nameGuess[1].trim()
      : text.slice(0, 160)

    if (!testName || testName.length < 4) {
      continue
    }

    rough.push({
      testName,
      status: "failed",
      location: "{}",
      traceOrTimeline: text.slice(0, 12000),
      attachments: "",
      screenshotDataUrls: []
    })
  }

  return dedupeByTestName(rough)
}



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

const maxAnalyzeFilesEnv =
  Number.parseInt(
    process.env.MAX_ANALYZE_FILES ||
      "",
    10
  )

/** Multipart field `reports` max count (folder uploads). Override with MAX_ANALYZE_FILES in .env. */
const MAX_ANALYZE_FILES =
  Number.isFinite(maxAnalyzeFilesEnv) &&
  maxAnalyzeFilesEnv > 0
    ? Math.min(
        200,
        maxAnalyzeFilesEnv
      )
    : 25

app.use(cors())
app.use(express.json())

const upload = multer({
  dest: "uploads/",
  limits: {
    files: MAX_ANALYZE_FILES,
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

REPORT FRAMEWORK:
${failedTest.framework || "unknown"}

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

    if (src) {

      row.reportFramework =
        src.framework ||
        "unknown"

      if (
        src.sourceReportFolder ||
        src.sourceReportPath
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

      // =====================================
      // ALLURE RESULTS (folder upload: allure-results/)
      // =====================================

      const allureMode =
        isAllureResultsBundle(
          req.files
        )

      const allureUsedPaths = new Set()

      if (allureMode) {
        try {
          console.log(
            "ALLURE RESULTS DETECTED (folder upload)"
          )

          const allure =
            await extractAllureFailuresFromFiles(
              req.files
            )

          for (const p of allure.usedPaths || []) {
            allureUsedPaths.add(p)
          }

          if (
            allure.failures &&
            allure.failures.length > 0
          ) {
            let folderEvidence = null
            try {
              folderEvidence =
                await extractEvidenceFromUploadedFiles(
                  req.files,
                  { originalName: "allure-results" }
                )
              console.log(
                "ALLURE FOLDER EVIDENCE ARTIFACTS FOUND:",
                folderEvidence?.meta?.totalArtifacts || 0
              )
            } catch (e) {
              console.log(
                "ALLURE EVIDENCE EXTRACTION ERROR:",
                e?.message || String(e)
              )
              folderEvidence = null
            }

            if (folderEvidence) {
              // merge evidence per failure using its folder if present
              for (const t of allure.failures) {
                mergeEvidenceIntoFailures(
                  [t],
                  folderEvidence,
                  { reportFolder: t.sourceReportFolder || "", allowUnmatchedScreenshots: false }
                )
              }
            }

            allFailedTests.push(
              ...allure.failures
            )
          }
        } catch (e) {
          console.log(
            "ALLURE PARSE ERROR:",
            e?.message || String(e)
          )
        }
      }

      for (const file of req.files) {

        // Skip files already consumed by Allure parsing to avoid double-counting.
        if (
          allureUsedPaths.size > 0 &&
          allureUsedPaths.has(file.path)
        ) {
          continue
        }

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

            let outerEvidence = null
            try {
              outerEvidence =
                await extractEvidenceFromOuterHandle(
                  outerHandle,
                  { originalName: file.originalname }
                )
              console.log(
                "EVIDENCE ARTIFACTS FOUND:",
                outerEvidence?.meta?.totalArtifacts || 0
              )
            } catch (e) {
              console.log(
                "EVIDENCE EXTRACTION ERROR:",
                e?.message || String(e)
              )
              outerEvidence = null
            }

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

              if (outerEvidence) {
                mergeEvidenceIntoFailures(
                  extracted,
                  outerEvidence,
                  { reportFolder: folder, allowUnmatchedScreenshots: false }
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
                  await tryExtractFailuresFromReportHtml(
                    html,
                    outerHandle,
                    entryName
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
                await tryExtractFailuresFromReportHtml(
                  htmlContent,
                  outerHandle,
                  htmlEntry.entryName.replace(
                    /\\/g,
                    "/"
                  )
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
                await tryExtractFailuresFromReportHtml(
                  htmlContent,
                  outerHandle,
                  String(
                    htmlFile.path || ""
                  ).replace(
                    /\\/g,
                    "/"
                  )
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

          const detectedFramework =
            detectFramework(
              content,
              file.originalname
            )

          const framework =
            isTestNgReportHtml(
              content
            )
              ? "testng"
              : detectedFramework

          console.log(
            "HTML REPORT DETECTED. FRAMEWORK:",
            framework
          )

          if (framework === "testng") {

            console.log(
              "TESTNG HTML REPORT DETECTED"
            )

            const rows =
              extractTestNgFailuresFromHtml(
                content
              )

            for (const row of rows) {

              allFailedTests.push(
                createFailureObject({
                  framework: "testng",

                  ...row,

                  sourceReportPath:
                    file.originalname
                })
              )
            }
          } else {

            let extracted = []

            // Back-compat: older builds may still have this function inlined.
            if (
              typeof tryExtractFailuresFromReportHtml ===
                "function"
            ) {
              extracted =
                await tryExtractFailuresFromReportHtml(
                  content,
                  null,
                  file.originalname
                )
            } else {
              try {
                if (framework === "playwright") {
                  extracted =
                    await extractPlaywrightHtmlData(
                      content,
                      null
                    )
                } else if (framework === "cypress") {
                  extracted =
                    await extractCypressFailures(
                      content
                    )
                } else if (framework === "extent") {
                  extracted =
                    await extractExtentFailures(
                      content,
                      file.originalname
                    )
                } else {
                  extracted =
                    await extractGenericFailures(
                      content
                    )
                }
              } catch (e) {
                console.log(
                  "HTML EXTRACTION ERROR:",
                  e?.message || String(e)
                )
                extracted =
                  await extractGenericFailures(
                    content
                  )
              }
            }

            if (
              extracted?.length >
              0
            ) {
              const normalized =
                extracted
                  .map((r) => {
                    if (!r || typeof r !== "object") {
                      return null
                    }

                    // If it already matches the server's failure shape, only tag source + framework.
                    if (
                      "errors" in r ||
                      "traceOrTimeline" in r
                    ) {
                      return {
                        ...r,
                        framework:
                          r.framework ||
                          framework ||
                          "unknown",
                        sourceReportPath:
                          r.sourceReportPath ||
                          file.originalname
                      }
                    }

                    // Adapt "commonFailure" shape to this server's failure shape.
                    const mergedErrors =
                      [
                        r.stackTrace,
                        r.errorMessage,
                        r.testSteps,
                        r.logs
                      ]
                        .filter(Boolean)
                        .join("\n\n")

                    return createFailureObject({
                      framework:
                        r.framework ||
                        framework ||
                        "unknown",
                      testName:
                        r.testName ||
                        "",
                      status:
                        r.status ||
                        "failed",
                      location:
                        r.location ||
                        "{}",
                      traceOrTimeline:
                        mergedErrors ||
                        "(no extracted error text)",
                      attachments:
                        r.attachments ||
                        "",
                      screenshotDataUrls:
                        r.screenshotDataUrls ||
                        [],
                      sourceReportPath:
                        file.originalname
                    })
                  })
                  .filter(Boolean)

              allFailedTests.push(
                ...normalized
              )
            }
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

          const extractedJson =
            extractJsonReportFailures(
              content,
              file.originalname,
              {
                prioritizeSemantic:
                  prioritizeSemanticEvidenceForRca
              }
            )

          allFailedTests.push(
            ...extractedJson
          )
        }

        // =====================================
        // XML REPORT (JUnit / TestNG / NUnit)
        // =====================================

        else if (
          lower.endsWith(".xml")
        ) {

          const content =
            await fs.readFile(
              file.path,
              "utf8"
            )

          console.log(
            "XML REPORT DETECTED"
          )

          const rows =
            extractFailuresFromXml(
              content,
              file.originalname
            )

          for (const row of rows) {
            allFailedTests.push(
              createFailureObject({
                framework:
                  row.framework ||
                  "xml",
                ...row,
                sourceReportPath:
                  file.originalname
              })
            )
          }

        // =====================================
        // RAW LOG REPORT (.txt / .log)
        // =====================================

        } else if (
          lower.endsWith(".txt") ||
          lower.endsWith(".log")
        ) {

          const content =
            await fs.readFile(
              file.path,
              "utf8"
            )

          console.log(
            "TEXT/LOG REPORT DETECTED"
          )

          const rows =
            extractFailuresFromTextLog(
              content,
              file.originalname
            )

          for (const row of rows) {
            allFailedTests.push(
              createFailureObject({
                framework:
                  row.framework ||
                  "log",
                ...row,
                sourceReportPath:
                  file.originalname
              })
            )
          }
        } else {

          console.log(
            "SKIP (unsupported type):",
            file.originalname
          )
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

            "Supported: Playwright HTML/ZIP (embedded report), Cypress Mochawesome HTML/JSON, TestNG HTML/XML, JUnit XML, NUnit XML, Extent HTML (best-effort), raw .txt/.log, Allure `allure-results/` folder uploads, and generic HTML/JSON as a bundle. " +

            "Only failed / unexpected tests are analyzed when the format exposes them. " +

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
            "Each FAILED TEST may be from Playwright, Cypress, Selenium-oriented exports, or generic JSON — the REPORT FRAMEWORK line says which. When screenshot images (image_url) follow a test, use visible UI with stack traces, logs, and steps.\n\n"

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

        const sleep = (ms) =>
          new Promise((resolve) =>
            setTimeout(resolve, ms)
          )

        const postWithRetry = async (
          body,
          timeoutMs
        ) => {
          const maxRetries =
            Math.min(
              8,
              Math.max(
                1,
                parseInt(
                  process.env.HELIXGPT_MAX_RETRIES ||
                    "5",
                  10
                )
              )
            )

          let attempt = 0
          let lastErr = null

          while (attempt < maxRetries) {
            attempt++
            try {
              return await axios.post(
                process.env.HELIXGPT_API_URL,
                body,
                {
                  headers: {
                    "Content-Type":
                      "application/json",
                    "api-key":
                      process.env.HELIXGPT_API_KEY
                  },
                  timeout: timeoutMs
                }
              )
            } catch (e) {
              lastErr = e
              const status =
                e?.response?.status
              const code =
                e?.response?.data?.error
                  ?.code
              const is429 =
                status === 429 ||
                code === "too_many_requests"

              if (!is429) {
                throw e
              }

              const retryAfterSec =
                parseInt(
                  e?.response?.headers?.[
                    "retry-after"
                  ] || "",
                  10
                )

              const backoffMs =
                Number.isFinite(
                  retryAfterSec
                ) &&
                retryAfterSec > 0
                  ? retryAfterSec * 1000
                  : Math.min(
                      30000,
                      1000 *
                        Math.pow(
                          2,
                          attempt - 1
                        )
                    )

              console.log(
                "HELIXGPT 429 — RETRY",
                {
                  attempt,
                  maxRetries,
                  backoffMs
                }
              )

              await sleep(backoffMs)
            }
          }

          throw lastErr
        }

        try {

          let response
        
            console.log(
              "CALLING HELIXGPT...",
              {
                batchSize: batch.length,
                visionEnabled,
                hasScreenshots,
                screenshotCount:
                  batch.reduce(
                    (n, t) =>
                      n +
                      (
                        t.screenshotDataUrls ||
                        []
                      ).length,
                    0
                  )
              }
            )
        
          try {
        
            console.log(
              "REQUEST BODY SIZE:",
              JSON.stringify(requestBody).length
            )
            
            response =
              await postWithRetry(
                requestBody,
                180000
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
              await postWithRetry(
                requestBody,
                120000
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

  // Express 5: unnamed "*" is invalid for path-to-regexp — use named wildcard.
  app.get(
    "/{*splat}",
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
            `Maximum ${MAX_ANALYZE_FILES} report files per request`
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