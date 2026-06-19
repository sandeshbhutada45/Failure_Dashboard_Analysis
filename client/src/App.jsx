import { useEffect, useMemo, useState } from "react"
import toast, { Toaster } from "react-hot-toast"

import {
Upload,
AlertTriangle,
ShieldAlert,
Bug,
Sparkles,
Download,
Trash2,
Brain,
Server,
FileSearch
} from "lucide-react"

import { saveAs } from "file-saver"

/** How often the idle-results quip rotates (1 minute). */
const IDLE_QUIP_INTERVAL_MS = 60_000

/** Max Playwright report files per batch (client + server). */
const MAX_REPORT_FILES = 10

/** Must match server multer `fileSize` default (5 GiB). */
const MAX_REPORT_FILE_BYTES =
  5 * 1024 * 1024 * 1024

const fileDedupeKey = (f) =>
`${f.name}\0${f.size}\0${f.lastModified}`

/** Display / scroll order for summary cards and detail sections. */
const MAIN_CATEGORIES_ORDER = [

"Automation Script Issue",

"Product Defect",

"Flaky",

"Semantic",

"Uncategorized",

"Environment"
]

const categorySectionId = (mainCategory) =>

`rca-cat-${
String(mainCategory || "unknown")
.replace(/[^a-zA-Z0-9]+/g, "-")
.replace(/^-|-$/g, "")
.toLowerCase()
}`

const DEFAULT_SUMMARY_THEME = {
  summarySurface:
    "border border-slate-200 bg-white shadow-md shadow-slate-200/50",
  summaryHover:
    "hover:border-violet-300 hover:shadow-lg hover:shadow-violet-200/35",
  summaryIcon:
    "bg-gradient-to-br from-slate-500 to-slate-700 text-white shadow-md ring-1 ring-slate-300/40",
  summaryTitle: "text-slate-800",
  summaryCount: "text-slate-900",
  subCategoryChip:
    "border border-slate-300 bg-slate-100 text-slate-800 ring-slate-300/60"
}

/**
 * Colours per failure category: summary tiles + section chrome + table header tint.
 */
function categoryPalette(category) {
  const c = String(category || "")

  switch (c) {

  case "Automation Script Issue":

	return {
	  sectionBar: "border-l-4 border-l-indigo-500",
	  sectionHeader:
		"bg-gradient-to-r from-indigo-600 via-violet-600 to-purple-600 shadow-md shadow-indigo-300/35",
	  sectionHeaderSub: "text-indigo-50",
	  tableHead:
		"border-b border-indigo-200 bg-gradient-to-r from-indigo-50 via-violet-50 to-white",
	  tableHeadText: "text-indigo-950",
	  summarySurface:
		"border border-slate-200 border-l-4 border-l-indigo-500 bg-gradient-to-br from-white to-indigo-50/90 shadow-md shadow-slate-200/50",
	  summaryHover:
		"hover:border-indigo-300 hover:shadow-lg hover:shadow-indigo-200/40",
	  summaryIcon:
		"bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-md ring-1 ring-indigo-300/40",
	  summaryTitle: "text-slate-800",
	  summaryCount: "text-slate-900",
	  subCategoryChip:
		"border border-indigo-300 bg-indigo-50 text-indigo-950 ring-indigo-200/80"
	}

  case "Product Defect":

	return {
	  sectionBar: "border-l-4 border-l-rose-500",
	  sectionHeader:
		"bg-gradient-to-r from-rose-600 via-red-600 to-orange-600 shadow-md shadow-rose-300/40",
	  sectionHeaderSub: "text-rose-50",
	  tableHead:
		"border-b border-rose-200 bg-gradient-to-r from-rose-50 via-orange-50 to-white",
	  tableHeadText: "text-rose-950",
	  summarySurface:
		"border border-slate-200 border-l-4 border-l-rose-500 bg-gradient-to-br from-white to-rose-50/90 shadow-md shadow-slate-200/50",
	  summaryHover:
		"hover:border-rose-300 hover:shadow-lg hover:shadow-rose-200/40",
	  summaryIcon:
		"bg-gradient-to-br from-rose-500 to-red-600 text-white shadow-md ring-1 ring-rose-300/40",
	  summaryTitle: "text-slate-800",
	  summaryCount: "text-slate-900",
	  subCategoryChip:
		"border border-rose-300 bg-rose-50 text-rose-950 ring-rose-200/80"
	}

  case "Flaky":

	return {
	  sectionBar: "border-l-4 border-l-amber-500",
	  sectionHeader:
		"bg-gradient-to-r from-amber-500 via-yellow-500 to-orange-500 shadow-md shadow-amber-300/35",
	  sectionHeaderSub: "text-amber-950/90",
	  tableHead:
		"border-b border-amber-200 bg-gradient-to-r from-amber-50 via-yellow-50 to-white",
	  tableHeadText: "text-amber-950",
	  summarySurface:
		"border border-slate-200 border-l-4 border-l-amber-400 bg-gradient-to-br from-white to-amber-50/90 shadow-md shadow-slate-200/50",
	  summaryHover:
		"hover:border-amber-300 hover:shadow-lg hover:shadow-amber-200/40",
	  summaryIcon:
		"bg-gradient-to-br from-amber-400 to-yellow-500 text-amber-950 shadow-md ring-1 ring-amber-200/50",
	  summaryTitle: "text-amber-950",
	  summaryCount: "text-amber-950",
	  subCategoryChip:
		"border border-amber-400 bg-amber-50 text-amber-950 ring-amber-200/90"
	}

  case "Semantic":

	return {
	  sectionBar: "border-l-4 border-l-sky-500",
	  sectionHeader:
		"bg-gradient-to-r from-sky-600 via-cyan-600 to-teal-600 shadow-md shadow-cyan-300/35",
	  sectionHeaderSub: "text-sky-50",
	  tableHead:
		"border-b border-sky-200 bg-gradient-to-r from-sky-50 via-cyan-50 to-white",
	  tableHeadText: "text-sky-950",
	  summarySurface:
		"border border-slate-200 border-l-4 border-l-sky-500 bg-gradient-to-br from-white to-sky-50/90 shadow-md shadow-slate-200/50",
	  summaryHover:
		"hover:border-sky-300 hover:shadow-lg hover:shadow-sky-200/40",
	  summaryIcon:
		"bg-gradient-to-br from-sky-500 to-cyan-600 text-white shadow-md ring-1 ring-sky-300/40",
	  summaryTitle: "text-slate-800",
	  summaryCount: "text-slate-900",
	  subCategoryChip:
		"border border-sky-300 bg-sky-50 text-sky-950 ring-sky-200/80"
	}

  case "Uncategorized":

	return {
	  sectionBar: "border-l-4 border-l-slate-400",
	  sectionHeader:
		"bg-gradient-to-r from-slate-600 via-zinc-600 to-neutral-700 shadow-md shadow-slate-400/30",
	  sectionHeaderSub: "text-slate-100",
	  tableHead:
		"border-b border-slate-200 bg-gradient-to-r from-slate-100 via-zinc-50 to-white",
	  tableHeadText: "text-slate-900",
	  summarySurface:
		"border border-slate-200 border-l-4 border-l-slate-400 bg-gradient-to-br from-white to-slate-50 shadow-md shadow-slate-200/50",
	  summaryHover:
		"hover:border-slate-300 hover:shadow-lg hover:shadow-slate-200/50",
	  summaryIcon:
		"bg-gradient-to-br from-slate-500 to-zinc-700 text-white shadow-md ring-1 ring-slate-300/40",
	  summaryTitle: "text-slate-800",
	  summaryCount: "text-slate-900",
	  subCategoryChip:
		"border border-slate-300 bg-slate-100 text-slate-900 ring-slate-200/80"
	}

  case "Environment":

	return {
	  sectionBar: "border-l-4 border-l-emerald-500",
	  sectionHeader:
		"bg-gradient-to-r from-emerald-600 via-teal-600 to-cyan-600 shadow-md shadow-emerald-300/35",
	  sectionHeaderSub: "text-emerald-50",
	  tableHead:
		"border-b border-emerald-200 bg-gradient-to-r from-emerald-50 via-teal-50 to-white",
	  tableHeadText: "text-emerald-950",
	  summarySurface:
		"border border-slate-200 border-l-4 border-l-emerald-500 bg-gradient-to-br from-white to-emerald-50/90 shadow-md shadow-slate-200/50",
	  summaryHover:
		"hover:border-emerald-300 hover:shadow-lg hover:shadow-emerald-200/40",
	  summaryIcon:
		"bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-md ring-1 ring-emerald-300/40",
	  summaryTitle: "text-slate-800",
	  summaryCount: "text-slate-900",
	  subCategoryChip:
		"border border-emerald-300 bg-emerald-50 text-emerald-950 ring-emerald-200/80"
	}

  default:

	return {
	  sectionBar: "border-l-4 border-l-blue-500",
	  sectionHeader:
		"bg-gradient-to-r from-blue-600 to-indigo-600 shadow-md shadow-blue-300/35",
	  sectionHeaderSub: "text-blue-50",
	  tableHead:
		"border-b border-blue-200 bg-gradient-to-r from-blue-50 via-indigo-50 to-white",
	  tableHeadText: "text-blue-950",
	  summarySurface:
		"border border-slate-200 border-l-4 border-l-blue-500 bg-gradient-to-br from-white to-blue-50/90 shadow-md shadow-slate-200/50",
	  summaryHover:
		"hover:border-blue-300 hover:shadow-lg hover:shadow-blue-200/40",
	  summaryIcon:
		"bg-gradient-to-br from-blue-500 to-indigo-600 text-white shadow-md ring-1 ring-blue-300/40",
	  summaryTitle: "text-slate-800",
	  summaryCount: "text-slate-900",
	  subCategoryChip:
		"border border-blue-300 bg-blue-50 text-blue-950 ring-blue-200/80"
	}
  }
}

function confidenceBadgeClass(confidence) {
  const s = String(confidence || "").toLowerCase()

  if (
	s.includes(
	  "high"
	)
  ) {

	return "bg-emerald-100 text-emerald-900 ring-emerald-400/50"
  }

  if (
	s.includes(
	  "low"
	)
  ) {

	return "bg-slate-100 text-slate-700 ring-slate-400/55"
  }

  return "bg-amber-100 text-amber-950 ring-amber-400/50"
}

/** Rotating one-liners: QA automation, office drama, meme energy (workplace-safe). */
const IDLE_RESULT_QUIPS = [

"Stand-up: 'No blockers.' Narrator: There were blockers.",

"PO: 'Can we automate everything?' QA: We automated saying 'we need more time' in three languages.",

"When the flaky test passes on retry #3 so you drop a 'fixed' GIF in Slack like you earned a PhD.",

"DEV: 'Works on my machine.' QA: 'Your machine is not in the release notes.' DEV: 'It should be.'",

"Merge Friday + deploy freeze = the crossover episode HR warned you about.",

"Manager: 'We need quality at speed.' Translation: same deadline, new font on the slide.",

"This is fine. — you, opening Jenkins, surrounded by red squares (it's a meme, not a fire drill).",

"HR scheduled team bonding. QA bonded with the XPath that changed overnight without filing paperwork.",

"Epic says 5 story points. Reality says 'have you tried counting in timeouts?'",

"Someone moved my locator and all I got was this lousy stack trace.",

"'Quick sanity' is office slang for 'we will learn about the universe together.'",

"SELECT * FROM builds WHERE mood = 'cautiously optimistic'; -- 0 rows returned",

"PO asked for an executive dashboard. We heard 'exec, wait—my dashboard?'",

"The 'Run full regression' button is the office equivalent of pulling the fire alarm, politely.",

"You don't skip leg day. You skip waiting for the spinner. Same energy. Different burn.",

"Calendar invite: '15-minute sync.' Reality: 45 minutes and a new priority matrix in Excel."
]

const LOADING_QUIPS = [

"Convincing the model that 'environment' isn't the answer to every cosmic mystery…",

"Reading stack traces so your future self can blame the past self with citations…",

"Asking the pipeline to stop gaslighting the assertion layer…",

"Negotiating with a timeout that thinks it's the main character…",

"Translating 'works locally' into 'repro steps' for the drama department…",

"Reticulating test data—HR said we can't say 'splines' in sprint review anymore…",

"Almost done—just waiting for one more selector to finish its identity crisis…"
]

function posixPathRca(p) {
  return String(p || "").replace(/\\/g, "/")
}

function isAllureResultFileClient(file) {
  const n = posixPathRca(file?.name || "").toLowerCase()

  return (
	n.endsWith("-result.json") ||
	(n.includes("/allure-results/") &&
	  n.endsWith(".json") &&
	  n.includes("result"))
  )
}

/** Mirrors server `isAllureResultsBundle` for `File` objects (folder uploads). */
function isAllureResultsBundleClient(files) {
  if (!Array.isArray(files) || files.length < 2) {
	return false
  }

  return (
	files.some((f) =>
	  posixPathRca(f.name || "")
		.toLowerCase()
		.includes("allure-results/")
	) || files.some((f) => isAllureResultFileClient(f))
  )
}

export default function App() {

const [files, setFiles] = useState([])
const [loading, setLoading] = useState(false)
const [results, setResults] = useState([])
const [analysisProgress, setAnalysisProgress] = useState(null)

const runAnalyzeStream = async (
analyzeUrlBase,
formData,
{
  partial = false,
  fileMeta = null
}
) => {

const q = new URLSearchParams()

q.set(
  "stream",
  "1"
)

if (partial) {

  q.set(
	"partial",
	"1"
  )
}

const url = `${analyzeUrlBase}?${q.toString()}`

const res = await fetch(
  url,
  {
	method: "POST",
	body: formData
  }
)

const ct = (
  res.headers.get("content-type") ||
	""
)
  .toLowerCase()

if (!res.ok) {

  const t = await res.text()

  let msg = t.slice(
	0,
	480
  )

  try {

	const j = JSON.parse(
	  t
	)

	if (j.error) {

	  msg =
		typeof j.error === "string"
		  ? j.error
		  : JSON.stringify(
			  j.error
			).slice(
			  0,
			  480
			)
	}
  } catch (_) {}

  throw new Error(
	msg ||
	  `HTTP ${res.status}`
  )
}

if (
  ct.includes(
	"application/json"
  )
) {

  const data = await res.json()

  if (!Array.isArray(data)) {

	throw new Error(
	  "Unexpected response from server"
	)
  }

  setAnalysisProgress(null)

  return data
}

const reader =
  res.body.getReader()

const decoder = new TextDecoder()

let buf = ""

let out = null

while (true) {

  const { done, value } = await reader.read()

  if (done) {

	break
  }

  buf +=
	decoder.decode(
	  value,
	  {
		stream: true
	  }
	)

  const lines = buf.split("\n")

  buf =
	lines.pop() ||
	""

  for (const line of lines) {

	if (!line.trim()) {

	  continue
	}

	let ev

	try {

	  ev = JSON.parse(
		line
	  )
	} catch {

	  continue
	}

	if (
	  ev.type ===
	  "parsed"
	) {

	  setAnalysisProgress({
		mode: "tests",
		totalFailed: ev.totalFailed,
		processed: 0,
		pending: ev.totalFailed,
		classified: 0,
		fileCurrent: fileMeta?.current,
		fileTotal: fileMeta?.total,
		fileName: fileMeta?.name,
		fileCount: fileMeta?.fileCount
	  })
	} else if (
	  ev.type ===
	  "progress"
	) {

	  setAnalysisProgress(
		(p) => ({
		  ...(
			p ||
			{}
		  ),
		  mode: "tests",
		  totalFailed: ev.totalFailed,
		  processed: ev.processed,
		  pending: ev.pending,
		  classified: ev.classified,
		  fileCurrent:
			fileMeta?.current ??
			p?.fileCurrent,
		  fileTotal:
			fileMeta?.total ??
			p?.fileTotal,
		  fileName:
			fileMeta?.name ??
			p?.fileName,
		  fileCount:
			fileMeta?.fileCount ??
			p?.fileCount
		})
	  )
	} else if (
	  ev.type ===
	  "done"
	) {

	  out = ev.results
	} else if (
	  ev.type ===
	  "error"
	) {

	  throw new Error(
		String(
		  ev.error ||
			"Analysis error"
		)
	  )
	}
  }
}

if (buf.trim()) {

  try {

	const ev = JSON.parse(
	  buf.trim()
	)

	if (
	  ev.type ===
	  "done"
	) {

	  out = ev.results
	} else if (
	  ev.type ===
	  "error"
	) {

	  throw new Error(
		String(
		  ev.error ||
			"Analysis error"
		)
	  )
	}
  } catch (_) {}
}

if (!Array.isArray(out)) {

  throw new Error(
	"Stream ended without results"
  )
}

return out
}

const [idleQuipIndex, setIdleQuipIndex] = useState(() =>
  Math.floor(
    Math.random() *
      IDLE_RESULT_QUIPS.length
  )
)

const [loadingQuipIndex] = useState(() =>
  Math.floor(
    Math.random() *
      LOADING_QUIPS.length
  )
)

useEffect(() => {

if (
  results.length >
    0 ||
  loading
) {

  return
}

const id = window.setInterval(() => {

setIdleQuipIndex(
  (i) =>
	(i + 1) %
	IDLE_RESULT_QUIPS.length
)
}, IDLE_QUIP_INTERVAL_MS)

return () =>
  window.clearInterval(
	id
  )
}, [results.length, loading])

// =========================================
// CLEAN TEST NAME
// =========================================

const cleanTestName = (name) => {

if (!name) return ""

return name
.replace(/@\w+\s/g, "")
.replace(/@guid:[^\s]+\s/g, "")
.trim()
}

// =========================================
// REMOVE FILE
// =========================================

const removeFile = (indexToRemove) => {

const updatedFiles =
files.filter(
(_, index) =>
  index !== indexToRemove
)

setFiles(updatedFiles)
}

// =========================================
// ADD REPORT FILES (bulk, max 10 total)
// =========================================

const addReportFiles = (incomingList) => {

const incoming =
incomingList?.length
  ? [...incomingList]
  : []

if (incoming.length === 0) {
  return
}

if (files.length >= MAX_REPORT_FILES) {

toast.error(
`Maximum ${MAX_REPORT_FILES} reports. Remove one to add more.`
)

return
}

let merged = [...files]

let skippedDuplicate = 0

let skippedOverLimit = 0

for (const f of incoming) {

if (
  merged.some(
	(m) =>
	  fileDedupeKey(m) ===
	  fileDedupeKey(f)
  )
) {

skippedDuplicate++

continue
}

if (
  f.size >
  MAX_REPORT_FILE_BYTES
) {

toast.error(
`${f.name}: file exceeds 5 GB limit (per file)`
)

continue
}

if (
  merged.length >=
  MAX_REPORT_FILES
) {

skippedOverLimit++

continue
}

merged.push(f)
}

setFiles(merged)

if (
skippedDuplicate > 0
) {

toast(
`${skippedDuplicate} duplicate file(s) ignored`
)
}

if (
skippedOverLimit > 0
) {

toast.error(
`Maximum ${MAX_REPORT_FILES} reports. ${skippedOverLimit} file(s) not added.`
)
}
}

// =========================================
// UPLOAD REPORTS
// =========================================

const uploadReports = async () => {

if (files.length === 0) {

toast.error("Please upload report")

return
}

const analyzeUrlBase =
  (
	import.meta.env
	  .VITE_API_BASE_URL ||
	""
  )
	.replace(
	  /\/+$/,
	  ""
	) +
  "/analyze"

const bundle = isAllureResultsBundleClient(files)

const multiFileNonBundle =
files.length > 1 &&
!bundle

try {

setLoading(true)

setAnalysisProgress(null)

if (
  !multiFileNonBundle
) {

  const formData = new FormData()

  for (const file of files) {

	formData.append(
	  "reports",
	  file
	)
  }

  const fileMeta = bundle
	? {
		current: 1,
		total: 1,
		name: "Allure bundle",
		fileCount: files.length
	  }
	: {
		current: 1,
		total: 1,
		name: files[0]?.name || "",
		fileCount: undefined
	  }

  setAnalysisProgress({
	mode: "tests",
	fileCurrent: fileMeta.current,
	fileTotal: fileMeta.total,
	fileName: fileMeta.name || "",
	fileCount: fileMeta.fileCount,
	totalFailed: null,
	processed: 0,
	pending: null,
	classified: 0
  })

  const data = await runAnalyzeStream(
	analyzeUrlBase,
	formData,
	{
	  partial: false,
	  fileMeta
	}
  )

  if (
	data.length ===
	0
  ) {

	toast.error(
	  "Could not extract failed tests from the uploaded file(s)."
	)

	setResults([])

	return
  }

  setResults(data)

  toast.success(
	"Analysis completed successfully"
  )

  return
}

const merged = []

for (let i = 0; i < files.length; i++) {

  setAnalysisProgress({
	mode: "tests",
	fileCurrent: i + 1,
	fileTotal: files.length,
	fileName: files[i].name || "",
	totalFailed: null,
	processed: 0,
	pending: null,
	classified: 0,
	fileCount: undefined
  })

  const formData = new FormData()

  formData.append(
	"reports",
	files[i]
  )

  const chunk = await runAnalyzeStream(
	analyzeUrlBase,
	formData,
	{
	  partial: true,
	  fileMeta: {
		current: i + 1,
		total: files.length,
		name: files[i].name || ""
	  }
	}
  )

  merged.push(...chunk)
}

if (merged.length === 0) {

  toast.error(
	"Could not extract failed tests from any of the uploaded files."
  )

  setResults([])

  return
}

setResults(merged)

toast.success(
  "Analysis completed successfully"
)
} catch (err) {

const fromAxios =
  err?.response?.data?.error
	? typeof err.response.data.error === "string"
	  ? err.response.data.error
	  : JSON.stringify(err.response.data.error).slice(0, 220)
	: null

const fromMsg =
  err?.message ||
  String(err)

const detail =
  fromAxios ||
  (err?.response?.status
	? `HTTP ${err.response.status}${err.response.statusText ? ` ${err.response.statusText}` : ""}`
	: null) ||
  (err?.code === "ERR_NETWORK" ||
	  (fromMsg || "").includes("Network Error")
	? `Cannot reach ${analyzeUrlBase} — start the API (node server.js in PWA-RCA/server) or set VITE_API_BASE_URL when using a separate dev client.`
	: fromMsg.slice(0, 320))

toast.error(`Analysis failed: ${detail}`)

console.error(err)
} finally {

setLoading(false)

setAnalysisProgress(null)
}
}

// =========================================
// CATEGORY COUNT
// =========================================

const categoryCount = (name) => {

return results.filter(

r =>
r.mainCategory === name

).length
}

// =========================================
// FIX SUGGESTION
// =========================================

const getFixSuggestion = (item) => {

const fromModel =
String(
  item.whatNeedsToBeFixed ??
  item.whatNeedsToBeFixedSuggestion ??
  ""
)
.trim()

if (fromModel) {

return fromModel
}

if (
item.mainCategory ===
"Automation Script Issue"
) {

return "Fix locator / assertion / wait strategy / navigation logic"
}

if (
item.mainCategory ===
"Product Defect"
) {

return "Application code fix required"
}

if (
item.mainCategory ===
"Flaky"
) {

return "Improve stability and synchronization handling"
}

if (
item.mainCategory ===
"Semantic"
) {

return "Review Helix GPT / LLM expectations and assertions"
}

if (
item.mainCategory ===
"Environment"
) {

return "Fix CI/environment configuration, URLs, secrets, or service availability"
}

return "Further investigation required"
}

// =========================================
// EVIDENCE / SOURCES (new API uses evidence[])
// =========================================

const formatEvidenceText = (item) => {

if (
  Array.isArray(item.evidence) &&
  item.evidence.length > 0
) {

return item.evidence.join("\n")
}

if (item.sources) {

return item.sources
}

return "—"
}

const formatEvidenceForCsv = (item) => {

if (
  Array.isArray(item.evidence) &&
  item.evidence.length > 0
) {

return item.evidence
.map(e =>
  String(e).replace(/"/g, "'")
)
.join("; ")
}

return (
  (item.sources || "")
.replace(/"/g, "'")
)
}

// =========================================
// SOURCE REPORT COLUMN (only when multiple bundles)
// =========================================

const sourceReportKey = (item) =>
String(
  item.sourceReportFolder ||
    item.sourceReportPath ||
    ""
)
  .trim()
  .toLowerCase()

const showSourceReportColumn =
useMemo(() => {

const keys = new Set()

for (const r of results) {

const k =
  sourceReportKey(
	r
  )

if (k) {

  keys.add(
	k
  )
}
}

return keys.size > 1
}, [results])

// =========================================
// CSV DOWNLOAD
// =========================================

const exportCSV = () => {

const headers = showSourceReportColumn
? [

"Sr.No",
"Source report",
"Test Name",
"Main Category",
"Sub Category",
"Confidence",
"Evidence",
"What Need To Be Fixed",
"Reason"
]
: [

"Sr.No",
"Test Name",
"Main Category",
"Sub Category",
"Confidence",
"Evidence",
"What Need To Be Fixed",
"Reason"
]

const rows = results.map(

(item, index) => {

const base = [

index + 1
]

if (
showSourceReportColumn
) {

base.push(

`"${(item.sourceReportFolder || item.sourceReportPath || "").replace(/"/g, "'")}"`
)
}

base.push(

`"${cleanTestName(item.testName)}"`,

`"${item.mainCategory || ""}"`,

`"${item.subCategory || ""}"`,

`"${item.confidence || ""}"`,

`"${formatEvidenceForCsv(item)}"`,

`"${getFixSuggestion(item)}"`,

`"${(item.reason || "").replace(/"/g, "'")}"`
)

return base
}
)

const csvContent = [

headers.join(","),

...rows.map(
row => row.join(",")
)

].join("\n")

const blob = new Blob(

[csvContent],

{
type: "text/csv;charset=utf-8;"
}
)

saveAs(
blob,
"PWA_Failure_Analysis.csv"
)
}

// =========================================
// GROUP BY CATEGORY (stable order for sections + scroll targets)
// =========================================

const sortedCategorySections =
useMemo(() => {

const grouped =
results.reduce((acc, item) => {

const key =
item.mainCategory ||
"Uncategorized"

if (!acc[key]) {

acc[key] = []
}

acc[key].push(item)

return acc

}, {})

const orderIdx = (name) => {

const i =
MAIN_CATEGORIES_ORDER.indexOf(
  name
)

return i === -1
  ? 999
  : i
}

return Object.entries(grouped)
.sort(
  (a, b) =>
	orderIdx(a[0]) -
	orderIdx(b[0])
)
}, [results])

const subcategoryCounts = (mainCategory) => {

const tallies =
new Map()

for (const r of results) {

if (r.mainCategory !== mainCategory) {

  continue
}

const sub =
  (r.subCategory || "")
	.trim() ||
  "—"

tallies.set(
  sub,
  (tallies.get(sub) || 0) + 1
)
}

return [...tallies.entries()]
.sort(
  (a, b) =>
	b[1] - a[1]
)
}

const scrollToCategorySection = (mainCategory) => {

const id =
categorySectionId(
  mainCategory
)

const el =
document.getElementById(
  id
)

if (el) {

el.scrollIntoView({
  behavior: "smooth",
  block: "start"
})

return
}

if (
categoryCount(
  mainCategory
) ===
0
) {

toast(
"No failures in this category for the current run."
)

return
}

toast.error(
"Section not found — try scrolling manually."
)
}

return (

<div className="min-h-screen bg-gradient-to-b from-slate-100 via-white to-violet-50/40 p-3 font-sans text-base leading-normal text-slate-900 antialiased sm:p-4">

<Toaster
  position="top-right"
  toastOptions={{
    duration: 4800,
    className:
      "!rounded-xl !border !border-slate-200 !bg-white !text-slate-800 !text-base !shadow-lg"
  }}
/>

{/* HEADER */}

<div className="mb-4 overflow-hidden rounded-2xl border border-slate-200/90 bg-white/90 p-4 shadow-sm backdrop-blur-sm sm:p-5">

<div className="flex items-center gap-4">

  <div className="shrink-0 rounded-xl bg-gradient-to-br from-violet-600 to-fuchsia-600 p-3 text-white shadow-md ring-1 ring-violet-200/80">

	<Sparkles size={22} />
  </div>

  <div className="min-w-0">

	<h1 className="bg-gradient-to-r from-violet-700 via-fuchsia-600 to-cyan-600 bg-clip-text text-2xl font-bold tracking-tight text-transparent sm:text-3xl">

	  Failure Analysis Dashboard
	</h1>
  </div>
</div>
</div>

{/* UPLOAD SECTION */}

<div className="mb-4 rounded-2xl border border-slate-200 bg-white/95 p-4 shadow-sm backdrop-blur-sm sm:p-5">
<h2 className="mb-2 text-lg font-bold text-slate-900 sm:text-xl">

  UPLOAD REPORTS
</h2>

<p className="mb-3 text-sm leading-relaxed text-slate-600">
  Select multiple files (HTML, ZIP, JSON, XML, TXT, LOG) — up to{" "}
  {MAX_REPORT_FILES} files, 5&nbsp;GB each. Duplicates are skipped automatically.
</p>

<div className="flex flex-wrap items-center gap-2">

  <label
	title={
	  files.length >= MAX_REPORT_FILES
		? `Maximum ${MAX_REPORT_FILES} files — remove one to add more`
		: `Add reports (${files.length}/${MAX_REPORT_FILES})`
	}
	className={`inline-flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-xs font-semibold transition-all sm:text-sm sm:px-4 sm:py-2.5 ${
	  files.length >= MAX_REPORT_FILES
		? "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400"
		: "border-slate-300 bg-white text-slate-800 shadow-sm hover:border-violet-400 hover:bg-violet-50/50"
	}`}
  >

	<Upload size={16} className="text-violet-600" />

	Choose reports

	<input
	  type="file"
	  hidden
	  multiple
	  accept=".html,.htm,.json,.zip,.xml,.txt,.log,application/json,text/html,application/zip,application/xml,text/plain"
	  disabled={files.length >= MAX_REPORT_FILES}
	  onChange={(e) => {

		addReportFiles(e.target.files)

		e.target.value = ""
	  }}
	/>
  </label>

  <button
	onClick={uploadReports}
	disabled={loading}
	className="rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 px-4 py-2 text-xs font-bold text-white shadow-md transition-all hover:from-violet-500 hover:to-fuchsia-500 disabled:opacity-60 sm:text-sm sm:px-5 sm:py-2.5"
  >
	{
	  loading
		? "Analyzing…"
		: "Analyze failures"
	}
  </button>

  {
	results.length > 0 && (

	  <button
		onClick={exportCSV}
		className="inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-800 shadow-sm transition-colors hover:border-violet-300 hover:bg-violet-50/60 sm:text-sm sm:px-5 sm:py-2.5"
	  >
		<Download size={16} className="text-violet-600" />

		Download CSV
	  </button>
	)
  }
</div>

{/* FILE LIST */}

{
  files.length > 0 && (

	<div className="mt-4">

	  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-600 sm:text-sm">

		Selected files ({files.length}/{MAX_REPORT_FILES})
	  </h3>

	  <div className="grid grid-cols-1 gap-2 md:grid-cols-2">

		{
		  files.map((file, index) => (

			<div
			  key={index}
			  className="flex items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2"
			>

			  <div className="truncate text-xs font-medium text-slate-800 sm:text-sm" title={file.name}>

				{file.name}
			  </div>

			  <button
				onClick={() =>
				  removeFile(index)
				}
				className="shrink-0 rounded-lg bg-gradient-to-br from-rose-500 to-orange-600 p-1.5 text-white transition-transform hover:scale-105"
				type="button"
				aria-label="Remove file"
			  >
				<Trash2 size={15} />
			  </button>
			</div>
		  ))
		}

	  </div>
	</div>
  )
}
</div>

{/* EMPTY / LOADING WORKSPACE — “classification deck” */}
{
results.length === 0 && (

  <div className="relative mb-6 overflow-hidden rounded-2xl border border-slate-200 bg-white rca-frame-pulse">

	<div
	  className="pointer-events-none absolute inset-0 rca-workspace-khatarnak rca-deck-anim"
	  aria-hidden
	/>

	<div
	  className="pointer-events-none absolute inset-0 rca-deck-aurora opacity-35"
	  aria-hidden
	/>

	<div
	  className="pointer-events-none absolute inset-0 bg-gradient-to-t from-slate-100/90 via-white/50 to-violet-100/25"
	  aria-hidden
	/>

	<div
	  className="pointer-events-none absolute inset-x-0 top-0 z-[5] h-px bg-gradient-to-r from-transparent via-cyan-500/70 to-transparent"
	  aria-hidden
	/>

	<div
	  className="pointer-events-none absolute -left-24 top-1/4 z-[5] h-72 w-72 rounded-full bg-violet-600/28 blur-3xl"
	  aria-hidden
	/>

	<div
	  className="pointer-events-none absolute -right-20 bottom-1/4 z-[5] h-64 w-64 rounded-full bg-cyan-500/22 blur-3xl"
	  aria-hidden
	/>

	<div
	  className="pointer-events-none absolute left-1/2 top-8 z-[5] h-40 w-40 -translate-x-1/2 rounded-full bg-indigo-500/12 blur-2xl"
	  aria-hidden
	/>

	<div
	  className="pointer-events-none absolute inset-0 z-[6] rca-scanlines"
	  aria-hidden
	/>

	<div className="relative z-10 flex flex-col items-center justify-center px-5 py-8 sm:px-8 sm:py-10">

	  {
		loading ? (

		  <>
			<div
			  className="h-12 w-12 animate-spin rounded-full border-2 border-violet-500/25 border-t-cyan-400 border-r-indigo-400"
			  aria-hidden
			/>

			<p className="mt-6 text-lg font-semibold text-slate-800 sm:text-xl">

			  Analyzing reports…
			</p>

			{
			  analysisProgress && (

				<div
				  className="mt-4 w-full max-w-md space-y-2 text-center"
				  aria-live="polite"
				>

				  {
					analysisProgress.fileTotal > 1 && (

					  <p className="text-xs font-bold uppercase tracking-wider text-slate-500">

						File{" "}
						{analysisProgress.fileCurrent}/{analysisProgress.fileTotal}
					  </p>
					)
				  }

				  {
					analysisProgress.fileCount > 1 &&
					analysisProgress.fileTotal === 1 && (

					  <p className="text-xs font-bold uppercase tracking-wider text-slate-500">

						Allure bundle · {analysisProgress.fileCount} files (one pass)
					  </p>
					)
				  }

				  {
					analysisProgress.fileName && (

					  <p
						className="truncate text-xs text-slate-500"
						title={analysisProgress.fileName}
					  >

						{analysisProgress.fileName}
					  </p>
					)
				  }

				  {
					analysisProgress.totalFailed != null && (

					  <>
						<p className="text-sm text-slate-600">

						  Failed tests in this batch:{" "}
						  <span className="font-bold tabular-nums text-slate-900">

							{analysisProgress.totalFailed}
						  </span>
						</p>

						<p className="text-3xl font-bold tabular-nums tracking-tight text-violet-600 sm:text-4xl">

						  {analysisProgress.processed}/{analysisProgress.totalFailed}
						</p>

						<p className="text-xs font-semibold uppercase tracking-wider text-slate-500">

						  Classified (model batches)
						</p>

						{
						  analysisProgress.pending != null && (

							<p className="text-sm font-medium text-amber-800">

							  {analysisProgress.pending} pending
							</p>
						  )
						}
					  </>
					)
				  }

				  {
					analysisProgress.totalFailed == null && (

					  <p className="text-sm text-slate-500">

						Reading report and extracting failures…
					  </p>
					)
				  }
				</div>
			  )
			}

			<p className="mt-2 max-w-md text-center text-sm leading-relaxed text-slate-600">

			  Sending your files to the server and running failure classification. Large archives may take a little while.
			</p>

			<p className="mt-4 max-w-md text-center text-sm italic leading-relaxed text-violet-700/90">

			  {LOADING_QUIPS[loadingQuipIndex]}
			</p>

			<div className="mt-10 w-full max-w-md space-y-3">

			  {
				[
				  92,
				  78,
				  88,
				  70,
				  82
				].map((w, i) => (

				  <div
					key={i}
					className="rca-shimmer h-2.5 rounded-full"
					style={{
					  width: `${w}%`,
					  marginLeft: i % 2 === 1 ? "auto" : 0
					}}
				  />
				))
			  }
			</div>
		  </>
		) : (

		  <>
			<div className="relative flex w-full max-w-2xl flex-col items-center">

			  <div className="flex items-center justify-center">

				<div className="rounded-2xl border border-slate-200 bg-white px-8 py-7 shadow-sm">

				  <FileSearch
					className="mx-auto text-slate-500"
					size={44}
					strokeWidth={1.25}
					aria-hidden
				  />
				</div>
			  </div>
			</div>

			<p className="mt-6 text-center text-xs font-bold uppercase tracking-[0.2em] text-slate-600 sm:mt-7">

			  Supported formats
			</p>

			<div className="mt-3 flex max-w-xl flex-wrap justify-center gap-2">

			  {[
				{
				  label: "Playwright",
				  ring: "ring-cyan-300/50",
				  border: "border-cyan-300",
				  text: "text-cyan-900"
				},
				{
				  label: "Cypress",
				  ring: "ring-teal-300/50",
				  border: "border-teal-300",
				  text: "text-teal-900"
				},
				{
				  label: "TestNG HTML",
				  ring: "ring-violet-300/50",
				  border: "border-violet-300",
				  text: "text-violet-900"
				},
				{
				  label: "JSON",
				  ring: "ring-amber-300/50",
				  border: "border-amber-300",
				  text: "text-amber-950"
				},
				{
				  label: "XML",
				  ring: "ring-sky-300/50",
				  border: "border-sky-300",
				  text: "text-sky-900"
				},
				{
				  label: "Logs",
				  ring: "ring-fuchsia-300/50",
				  border: "border-fuchsia-300",
				  text: "text-fuchsia-900"
				},
				{
				  label: "ZIP / Allure",
				  ring: "ring-rose-300/50",
				  border: "border-rose-300",
				  text: "text-rose-900"
				}
			  ].map((chip) => (

				<span
				  key={chip.label}
				  className={`rounded-lg border bg-white px-2.5 py-1.5 text-xs font-bold uppercase tracking-wide shadow-sm ring-1 backdrop-blur-sm ${chip.border} ${chip.ring} ${chip.text}`}
				>
				  {chip.label}
				</span>
			  ))}
			</div>

			<div className="mt-6 w-full max-w-lg rounded-2xl border border-amber-200 bg-gradient-to-br from-amber-50/90 via-violet-50/80 to-cyan-50/90 p-[1px] shadow-md shadow-slate-200/60">

			  <blockquote className="rounded-2xl bg-white/95 px-4 py-4 text-center text-sm italic leading-relaxed text-slate-700 ring-1 ring-slate-200/80">

				“{IDLE_RESULT_QUIPS[idleQuipIndex]}”
			  </blockquote>
			</div>
		  </>
		)
	  }
	</div>
  </div>
)
}

{/* SUMMARY */}

{
results.length > 0 && (

  <div className="mb-6 grid grid-cols-2 items-start gap-3 sm:grid-cols-3 xl:grid-cols-6 xl:gap-4">

	<SummaryCard
	  title="Automation Script Issue"
	  count={categoryCount(
		"Automation Script Issue"
	  )}
	  subBreakdown={subcategoryCounts(
		"Automation Script Issue"
	  )}
	  icon={<ShieldAlert size={20} />}
	  theme={categoryPalette(
		"Automation Script Issue"
	  )}
	  onActivate={() =>
		scrollToCategorySection(
		  "Automation Script Issue"
		)
	  }
	/>

	<SummaryCard
	  title="Product Defect"
	  count={categoryCount(
		"Product Defect"
	  )}
	  subBreakdown={subcategoryCounts(
		"Product Defect"
	  )}
	  icon={<Bug size={20} />}
	  theme={categoryPalette(
		"Product Defect"
	  )}
	  onActivate={() =>
		scrollToCategorySection(
		  "Product Defect"
		)
	  }
	/>

	<SummaryCard
	  title="Flaky"
	  count={categoryCount(
		"Flaky"
	  )}
	  subBreakdown={subcategoryCounts(
		"Flaky"
	  )}
	  icon={<AlertTriangle size={20} />}
	  theme={categoryPalette(
		"Flaky"
	  )}
	  onActivate={() =>
		scrollToCategorySection(
		  "Flaky"
		)
	  }
	/>

	<SummaryCard
	  title="Semantic"
	  count={categoryCount(
		"Semantic"
	  )}
	  subBreakdown={subcategoryCounts(
		"Semantic"
	  )}
	  icon={<Brain size={20} />}
	  theme={categoryPalette(
		"Semantic"
	  )}
	  onActivate={() =>
		scrollToCategorySection(
		  "Semantic"
		)
	  }
	/>

	<SummaryCard
	  title="Uncategorized"
	  count={categoryCount(
		"Uncategorized"
	  )}
	  subBreakdown={subcategoryCounts(
		"Uncategorized"
	  )}
	  icon={<Sparkles size={20} />}
	  theme={categoryPalette(
		"Uncategorized"
	  )}
	  onActivate={() =>
		scrollToCategorySection(
		  "Uncategorized"
		)
	  }
	/>

	<SummaryCard
	  title="Environment"
	  count={categoryCount(
		"Environment"
	  )}
	  subBreakdown={subcategoryCounts(
		"Environment"
	  )}
	  icon={<Server size={20} />}
	  theme={categoryPalette(
		"Environment"
	  )}
	  onActivate={() =>
		scrollToCategorySection(
		  "Environment"
		)
	  }
	/>
  </div>
)
}

{/* GROUPED TABLES */}

{
sortedCategorySections.map(([category, items]) => {
  const theme = categoryPalette(category)

  return (
	<div
	  key={category}
	  id={categorySectionId(
		category
	  )}
	  className={`mb-6 scroll-mt-4 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-lg shadow-slate-200/50 ring-1 ring-slate-100 backdrop-blur-sm ${theme.sectionBar}`}
	>

	  <div
		className={`border-b border-white/25 px-4 py-3 text-white sm:px-5 ${theme.sectionHeader}`}
	  >

		<h2 className="text-lg font-bold leading-snug sm:text-xl">

		  {category}
		</h2>

		<p
		  className={`mt-1 text-sm font-medium leading-snug ${theme.sectionHeaderSub}`}
		>

		  Total failures: {items.length}
		</p>
	  </div>

	  <div className="max-h-[800px] overflow-x-auto bg-slate-50/95">

		 <table
		  className={`${
			showSourceReportColumn
			  ? "min-w-[2200px]"
			  : "min-w-[2000px]"
		  } w-full table-fixed border-collapse text-sm leading-relaxed`}
		 >

		 <thead className={theme.tableHead}>

<tr>

<th
  className={`w-[70px] px-3 py-2.5 text-left text-sm font-semibold ${theme.tableHeadText}`}
>
Sr.No
</th>

{
showSourceReportColumn && (

<th
  className={`w-[200px] px-3 py-2.5 text-left text-sm font-semibold ${theme.tableHeadText}`}
>
Source report
</th>
)
}

<th
  className={`w-[400px] px-3 py-2.5 text-left text-sm font-semibold ${theme.tableHeadText}`}
>
Test name
</th>

<th
  className={`w-[220px] px-3 py-2.5 text-left text-sm font-semibold ${theme.tableHeadText}`}
>
Sub category
</th>

<th
  className={`w-[120px] px-3 py-2.5 text-left text-sm font-semibold ${theme.tableHeadText}`}
>
Confidence
</th>

<th
  className={`w-[350px] px-3 py-2.5 text-left text-sm font-semibold ${theme.tableHeadText}`}
>
Evidence
</th>

<th
  className={`w-[250px] px-3 py-2.5 text-left text-sm font-semibold ${theme.tableHeadText}`}
>
What needs to be fixed
</th>

<th
  className={`w-[500px] px-3 py-2.5 text-left text-sm font-semibold ${theme.tableHeadText}`}
>
Reason
</th>

</tr>

</thead>

		  <tbody>
{
items.map((item, index) => (

<tr
key={`${category}-${index}`}
className="border-t border-slate-200 align-top transition-colors hover:bg-violet-50/50"
>

<td className="px-3 py-3 align-top text-sm tabular-nums text-slate-600">
{index + 1}
</td>

{
showSourceReportColumn && (

<td className="px-3 py-3 align-top">
<div className="break-words whitespace-normal text-sm leading-snug text-slate-600" title={item.sourceReportPath || ""}>
  {item.sourceReportFolder || item.sourceReportPath || "—"}
</div>
</td>
)
}

<td className="px-3 py-3 align-top">
<div className="break-words whitespace-normal text-sm font-semibold leading-snug text-slate-900">
  {cleanTestName(item.testName)}
</div>
</td>

<td className="px-3 py-3 align-top">
<span
  className={`inline-block max-w-full break-words rounded-md px-2.5 py-1 text-sm font-semibold leading-snug ring-1 ring-inset ${theme.subCategoryChip}`}
>
  {(item.subCategory || "").trim() || "—"}
</span>
</td>

<td className="px-3 py-3 align-top">
<span
  className={`inline-block rounded-md px-2.5 py-1 text-sm font-semibold capitalize ring-1 ring-inset ${confidenceBadgeClass(item.confidence)}`}
>
{item.confidence}
</span>
</td>

<td className="px-3 py-3 align-top">
<div className="break-words whitespace-pre-wrap text-sm leading-relaxed text-slate-800">
  {formatEvidenceText(item)}
</div>
</td>

<td className="px-3 py-3 align-top">
<div className="break-words whitespace-normal text-sm leading-snug text-slate-800">
  {getFixSuggestion(item)}
</div>
</td>

<td className="px-3 py-3 align-top">
<div className="break-words whitespace-pre-wrap text-sm leading-relaxed text-slate-800">
  {item.reason}
</div>
</td>

</tr>

))
}
</tbody>
		</table>
	  </div>
	</div>
  )
})
}
</div>
)
}

function SummaryCard({
title,
count,
icon,
subBreakdown,
onActivate,
theme
}) {

const t = {
  ...DEFAULT_SUMMARY_THEME,
  ...(theme || {})
}

const clickable =
count > 0 &&
typeof onActivate ===
"function"

const CardInner = (

<>
<div className="flex items-start justify-between gap-2">

<div className="min-w-0">

  <p
	className={`text-sm font-semibold leading-snug ${t.summaryTitle}`}
  >
	{title}
  </p>

  <h2
	className={`mt-1 text-2xl font-bold tabular-nums sm:text-3xl ${t.summaryCount}`}
  >
	{count}
  </h2>
</div>

<div
  className={`shrink-0 rounded-xl p-2.5 sm:p-3 ${t.summaryIcon}`}
>

  {icon}
</div>
</div>

{
  subBreakdown &&
  subBreakdown.length >
  0 && (

	<div className="mt-2 border-t border-slate-200 pt-2">

	  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-600">

		Sub categories
	  </p>

	  <ul className="max-h-[5.75rem] min-h-0 space-y-0.5 overflow-y-auto pr-0.5">

		{
		  subBreakdown
			.slice(
			  0,
			  8
			)
			.map(([sub, n]) => (

			  <li
				key={`${title}-${sub}`}
				className="flex justify-between gap-2 text-xs leading-snug text-slate-700"
			  >

				<span
				  className="min-w-0 truncate"
				  title={sub}
				>
				  {sub}
				</span>

				<span className="shrink-0 font-semibold tabular-nums text-slate-800">

				  {n}
				</span>
			  </li>
			))
		}
	  </ul>

	  {
		subBreakdown.length >
		8 && (

		  <p className="mt-0.5 text-xs text-slate-600">

			+{subBreakdown.length - 8} more…
		  </p>
		)
	  }
	</div>
  )
}
</>
)

if (clickable) {

return (

<button
  type="button"
  className={`h-auto w-full rounded-2xl p-3 text-left transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500 ${t.summarySurface} ${t.summaryHover}`}
  onClick={onActivate}
  title={`Scroll to ${title} table`}
>

  {CardInner}
</button>
)
}

return (

<div
  className={`h-auto rounded-2xl p-3 opacity-80 ring-1 ring-slate-200 ${t.summarySurface}`}
>

  {CardInner}
</div>
)
}