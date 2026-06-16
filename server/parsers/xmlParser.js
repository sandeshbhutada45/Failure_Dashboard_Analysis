const { XMLParser } = require("fast-xml-parser")

function asArray(x) {
  if (!x) return []
  return Array.isArray(x) ? x : [x]
}

function safeText(x) {
  if (x === undefined || x === null) return ""
  if (typeof x === "string") return x
  if (typeof x === "number" || typeof x === "boolean") return String(x)
  if (typeof x === "object") {
    if (typeof x["#text"] === "string") return x["#text"]
    if (typeof x.text === "string") return x.text
    if (typeof x.message === "string") return x.message
  }
  try {
    return JSON.stringify(x, null, 2)
  } catch {
    return String(x)
  }
}

function clip(s, maxChars = 120000) {
  const t = String(s || "")
  return t.length > maxChars ? t.slice(0, maxChars) + "\n…(truncated)…" : t
}

function parseXml(xml) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    textNodeName: "#text",
    trimValues: true,
    allowBooleanAttributes: true
  })
  return parser.parse(xml)
}

function extractFromJUnit(obj) {
  const out = []

  const visitSuite = (suite, inherited = {}) => {
    if (!suite || typeof suite !== "object") return

    const suiteName = suite["@_name"] || inherited.suiteName || ""
    const suiteFile = suite["@_file"] || inherited.file || ""

    for (const tc of asArray(suite.testcase)) {
      const name = tc && (tc["@_name"] || tc.name)
      const classname = tc && (tc["@_classname"] || tc.classname)
      const file = tc && (tc["@_file"] || suiteFile || "")
      const line = tc && (tc["@_line"] || "")

      const failure = tc && (tc.failure || tc.error)
      if (!failure) continue

      const failures = asArray(failure)
      const parts = []
      for (const f of failures) {
        const msg = f && (f["@_message"] || f.message)
        const typ = f && (f["@_type"] || f.type)
        const body = safeText(f)
        if (typ) parts.push(`TYPE: ${typ}`)
        if (msg) parts.push(`MESSAGE: ${msg}`)
        if (body) parts.push(body)
      }

      const testName = [classname, name].filter(Boolean).join(" › ") || String(name || "JUnit failure")

      out.push({
        framework: "junit",
        testName,
        status: "failed",
        location: JSON.stringify({ file, line, suite: suiteName, classname }, null, 2),
        traceOrTimeline: clip(parts.filter(Boolean).join("\n\n") || "JUnit failure (no message/stack)"),
        attachments: ""
      })
    }

    for (const child of asArray(suite.testsuite)) {
      visitSuite(child, { suiteName, file: suiteFile })
    }
  }

  if (obj.testsuite) {
    visitSuite(obj.testsuite, {})
  }
  if (obj.testsuites) {
    for (const s of asArray(obj.testsuites.testsuite)) visitSuite(s, {})
  }

  return out
}

function extractFromTestNg(obj) {
  const out = []
  const root = obj["testng-results"]
  if (!root) return out

  const suites = asArray(root.suite)
  for (const s of suites) {
    const suiteName = s && (s["@_name"] || "")
    const tests = asArray(s.test)
    for (const t of tests) {
      const testName = t && (t["@_name"] || "")
      const classes = asArray(t.class)
      for (const c of classes) {
        const className = c && (c["@_name"] || "")
        const methods = asArray(c["test-method"])
        for (const m of methods) {
          const status = String(m && (m["@_status"] || "")).toLowerCase()
          if (status !== "fail" && status !== "failed") continue

          const methodName = m && (m["@_name"] || "")
          const exception = m && m.exception
          const msg = exception && (exception["@_class"] || exception["@_name"] || "")
          const innerMsg = safeText(exception && exception.message)
          const stack = safeText(exception && (exception["full-stacktrace"] || exception["stack-trace"]))

          out.push({
            framework: "testng",
            testName: [className, methodName].filter(Boolean).join(" › ") || "TestNG failure",
            status: "failed",
            location: JSON.stringify({ suite: suiteName, test: testName, className, method: methodName }, null, 2),
            traceOrTimeline: clip([msg, innerMsg, stack].filter(Boolean).join("\n\n") || "TestNG failure (no stack)"),
            attachments: ""
          })
        }
      }
    }
  }

  return out
}

function extractFromNUnit(obj) {
  const out = []
  const root = obj["test-run"] || obj["test-suite"] || null
  if (!root) return out

  const visitSuite = (suite, inherited = {}) => {
    if (!suite || typeof suite !== "object") return

    const suiteName = suite["@_name"] || inherited.suiteName || ""
    const suiteType = suite["@_type"] || inherited.suiteType || ""

    for (const tc of asArray(suite["test-case"])) {
      const result = String(tc && (tc["@_result"] || "")).toLowerCase()
      if (result !== "failed" && result !== "error") continue

      const name = tc && (tc["@_name"] || "")
      const fullName = tc && (tc["@_fullname"] || "")
      const failure = tc && tc.failure
      const message = safeText(failure && (failure.message || failure["message"]))
      const stack = safeText(failure && (failure["stack-trace"] || failure["stacktrace"] || failure.stack))

      out.push({
        framework: "nunit",
        testName: fullName || name || "NUnit failure",
        status: "failed",
        location: JSON.stringify({ suite: suiteName, suiteType }, null, 2),
        traceOrTimeline: clip([message, stack].filter(Boolean).join("\n\n") || "NUnit failure (no stack)"),
        attachments: ""
      })
    }

    for (const child of asArray(suite["test-suite"])) {
      visitSuite(child, { suiteName, suiteType })
    }
  }

  // NUnit can nest under test-run.test-suite
  if (obj["test-run"]) {
    const topSuites = asArray(obj["test-run"]["test-suite"])
    for (const s of topSuites) visitSuite(s, {})
  } else {
    visitSuite(root, {})
  }

  return out
}

/**
 * Extract failures from XML reports:
 * - JUnit XML
 * - TestNG XML
 * - NUnit XML
 *
 * Returns "row" objects suitable for server.js `createFailureObject({ framework, ...row })`.
 */
function extractFailuresFromXml(xml, originalFilename = "") {
  let obj
  try {
    obj = parseXml(xml)
  } catch (e) {
    return [
      {
        framework: "xml",
        testName: originalFilename || "Uploaded XML report",
        status: "failed",
        location: "{}",
        traceOrTimeline: clip(`XML parse failed: ${e?.message || String(e)}\n\n` + String(xml || "")),
        attachments: ""
      }
    ]
  }

  // Try to auto-detect format by root tags.
  const isTestNg = !!obj["testng-results"]
  const isNUnit = !!obj["test-run"] || !!obj["test-suite"]
  const isJUnit = !!obj.testsuite || !!obj.testsuites

  const rows = []
  if (isTestNg) rows.push(...extractFromTestNg(obj))
  if (isNUnit) rows.push(...extractFromNUnit(obj))
  if (!isTestNg && !isNUnit && isJUnit) rows.push(...extractFromJUnit(obj))

  if (rows.length > 0) return rows

  // Fallback: one generic bundle row.
  return [
    {
      framework: isJUnit ? "junit" : isTestNg ? "testng" : isNUnit ? "nunit" : "xml",
      testName: originalFilename || "Uploaded XML report",
      status: "failed",
      location: "{}",
      traceOrTimeline: clip(JSON.stringify(obj, null, 2)),
      attachments: ""
    }
  ]
}

module.exports = {
  extractFailuresFromXml
}

