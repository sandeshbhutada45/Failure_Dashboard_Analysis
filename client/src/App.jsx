import { useMemo, useState } from "react"
import axios from "axios"
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
Server
} from "lucide-react"

import { saveAs } from "file-saver"

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

export default function App() {

const [files, setFiles] = useState([])
const [loading, setLoading] = useState(false)
const [results, setResults] = useState([])

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

const analyzeUrl =
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

try {

setLoading(true)

const formData = new FormData()

for (const file of files) {

formData.append(
  "reports",
  file
)
}

const response = await axios.post(analyzeUrl, formData, {
  // Let the browser set multipart boundary. Large uploads: no axios timeout.
  timeout: 0
})

setResults(response.data)

toast.success(
"Analysis completed successfully"
)

} catch (err) {

const detail =
  err?.response?.data?.error
    ? typeof err.response.data.error === "string"
      ? err.response.data.error
      : JSON.stringify(err.response.data.error).slice(0, 220)
    : err?.response?.status
      ? `HTTP ${err.response.status}${err.response.statusText ? ` ${err.response.statusText}` : ""}`
      : err?.code === "ERR_NETWORK" ||
          (err?.message || "").includes("Network Error")
        ? `Cannot reach ${analyzeUrl} — start the API (node server.js in PWA-RCA/server) or set VITE_API_BASE_URL when using a separate dev client.`
        : (err?.message || "Unknown error").slice(0, 220)

toast.error(`Analysis failed: ${detail}`)

console.error(err)
} finally {

setLoading(false)
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

<div className="min-h-screen bg-slate-100 p-3 text-sm">

<Toaster />

{/* HEADER */}

<div className="bg-gradient-to-r from-blue-700 to-indigo-700 rounded-2xl shadow-xl p-4 mb-4 text-white">

<div className="flex items-center gap-4">

  <div className="bg-white/20 p-3 rounded-2xl shrink-0">

	<Sparkles size={22} className="text-white" />

  </div>

  <div className="min-w-0">

	<h1 className="text-xl font-bold tracking-tight sm:text-2xl">

	  Failure Analysis Dashboard
	</h1>

<p className="mt-1 text-xs text-blue-100 sm:text-sm">
	  AI Powered Playwright Failure Classification Dashboard
	</p>
  </div>
</div>
</div>

{/* UPLOAD SECTION */}

<div className="bg-white rounded-2xl shadow-lg p-3 mb-4 border border-slate-200">
<h2 className="text-lg font-bold text-slate-800 mb-3 sm:text-xl">

  Upload Playwright Reports
</h2>

<p className="text-[11px] text-slate-500 mb-2 sm:text-xs">
  Bulk select multiple HTML/ZIP reports (up to{" "}
  {MAX_REPORT_FILES} total, up to 5 GB each). Duplicates are skipped.
</p>

<div className="flex flex-wrap gap-2 items-center">

  <label
	title={
	  files.length >= MAX_REPORT_FILES
		? `Maximum ${MAX_REPORT_FILES} files — remove one to add more`
		: `Add reports (${files.length}/${MAX_REPORT_FILES})`
	}
	className={`px-3 py-2 rounded-xl flex items-center gap-2 border text-xs font-medium sm:text-sm sm:px-4 sm:py-2.5 ${
	  files.length >= MAX_REPORT_FILES
		? "cursor-not-allowed border-slate-200 bg-slate-50 text-slate-400"
		: "cursor-pointer border-slate-300 bg-slate-100 hover:bg-slate-200 transition-all"
	}`}
  >

	<Upload size={16} />

	Choose Reports

	<input
	  type="file"
	  hidden
	  multiple
	  accept=".html,.htm,.json,.zip,application/json,text/html,application/zip"
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
	className="bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white px-4 py-2 rounded-xl text-xs font-semibold shadow-md transition-all sm:text-sm sm:px-5 sm:py-2.5"
  >
	{
	  loading
		? "Analyzing..."
		: "Analyze Failures"
	}
  </button>

  {
	results.length > 0 && (

	  <button
		onClick={exportCSV}
		className="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-xl text-xs font-semibold flex items-center gap-1.5 shadow-md sm:text-sm sm:px-5 sm:py-2.5"
	  >
		<Download size={16} />

		Download CSV
	  </button>
	)
  }
</div>

{/* FILE LIST */}

{
  files.length > 0 && (

	<div className="mt-4">

	  <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600 mb-2 sm:text-sm">

		Uploaded Files ({files.length}/{MAX_REPORT_FILES})
	  </h3>

	  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">

		{
		  files.map((file, index) => (

			<div
			  key={index}
			  className="flex justify-between items-center gap-2 bg-slate-100 border border-slate-300 rounded-xl px-3 py-2"
			>

			  <div className="font-medium text-slate-800 truncate text-xs sm:text-sm">

				📄 {file.name}
			  </div>

			  <button
				onClick={() =>
				  removeFile(index)
				}
				className="bg-red-500 hover:bg-red-600 text-white p-1.5 rounded-lg transition-all shrink-0"
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

{/* SUMMARY */}

{
results.length > 0 && (

  <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3 mb-6 items-start">

	<SummaryCard
	  title="Automation Script Issue"
	  count={categoryCount(
		"Automation Script Issue"
	  )}
	  subBreakdown={subcategoryCounts(
		"Automation Script Issue"
	  )}
	  icon={<ShieldAlert size={20} />}
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
sortedCategorySections.map(

  ([category, items]) => (

	<div
	  key={category}
	  id={categorySectionId(
		category
	  )}
	  className="bg-white rounded-2xl shadow-lg overflow-hidden mb-6 border border-slate-200 scroll-mt-4"
	>

	  <div className="bg-slate-800 text-white px-4 py-3 sm:px-5">

		<h2 className="text-base font-bold sm:text-lg">

		  {category}
		</h2>

		<p className="text-slate-300 mt-0.5 text-xs sm:text-sm">

		  Total Failures: {items.length}
		</p>
	  </div>

	  <div className="overflow-x-auto max-h-[800px]">

		 <table
		  className={`${
			showSourceReportColumn
			  ? "min-w-[2200px]"
			  : "min-w-[2000px]"
		  } w-full table-fixed border-collapse text-xs sm:text-sm`}
		 >

		 <thead className="bg-slate-100">

<tr>

<th className="w-[70px] px-2 py-2 text-left font-semibold text-slate-600">
Sr.No
</th>

{
showSourceReportColumn && (

<th className="w-[200px] px-2 py-2 text-left font-semibold text-slate-600">
Source report
</th>
)
}

<th className="w-[400px] px-2 py-2 text-left font-semibold text-slate-600">
Test Name
</th>

<th className="w-[220px] px-2 py-2 text-left font-semibold text-slate-600">
Sub Category
</th>

<th className="w-[120px] px-2 py-2 text-left font-semibold text-slate-600">
Confidence
</th>

<th className="w-[350px] px-2 py-2 text-left font-semibold text-slate-600">
Evidence
</th>

<th className="w-[250px] px-2 py-2 text-left font-semibold text-slate-600">
What Needs To Be Fixed
</th>

<th className="w-[500px] px-2 py-2 text-left font-semibold text-slate-600">
Reason
</th>

</tr>

</thead>

		  <tbody>
{
items.map((item, index) => (

<tr
key={index}
className="border-t align-top hover:bg-slate-50"
>

<td className="px-2 py-2 align-top font-medium text-slate-600">
{index + 1}
</td>

{
showSourceReportColumn && (

<td className="px-2 py-2 align-top">
<div className="break-words whitespace-normal text-slate-600 text-[11px] leading-snug" title={item.sourceReportPath || ""}>
  {item.sourceReportFolder || item.sourceReportPath || "—"}
</div>
</td>
)
}

<td className="px-2 py-2 align-top">
<div className="break-words whitespace-normal font-semibold text-slate-800">
  {cleanTestName(item.testName)}
</div>
</td>

<td className="px-2 py-2 align-top">
<div className="break-words whitespace-normal text-slate-700">
  {item.subCategory}
</div>
</td>

<td className="px-2 py-2 align-top font-semibold text-blue-700">
{item.confidence}
</td>

<td className="px-2 py-2 align-top">
<div className="break-words whitespace-pre-wrap text-slate-700 text-[11px] leading-snug sm:text-xs sm:leading-5">
  {formatEvidenceText(item)}
</div>
</td>

<td className="px-2 py-2 align-top">
<div className="break-words whitespace-normal text-slate-700">
  {getFixSuggestion(item)}
</div>
</td>

<td className="px-2 py-2 align-top">
<div className="break-words whitespace-pre-wrap text-slate-700 text-[11px] leading-snug sm:text-xs sm:leading-6">
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
)
}
</div>
)
}

function SummaryCard({
title,
count,
icon,
subBreakdown,
onActivate
}) {

const clickable =
count > 0 &&
typeof onActivate ===
"function"

const CardInner = (

<>
<div className="flex justify-between items-start gap-2">

<div className="min-w-0">

  <p className="text-slate-900 text-[11px] font-bold leading-tight sm:text-xs">
	{title}
  </p>

  <h2 className="text-2xl font-bold mt-1 tabular-nums text-slate-800 sm:text-3xl">
	{count}
  </h2>
</div>

<div className="bg-slate-100 p-2.5 rounded-xl text-slate-700 shrink-0 sm:p-3">

  {icon}
</div>
</div>

{
  subBreakdown &&
  subBreakdown.length >
  0 && (

	<div className="mt-2 pt-2 border-t border-slate-100">

	  <p className="text-[9px] font-bold uppercase tracking-wide text-slate-600 mb-1 sm:text-[10px]">

		Sub categories
	  </p>

	  <ul className="max-h-[5.75rem] overflow-y-auto space-y-0.5 pr-0.5 min-h-0">

		{
		  subBreakdown
			.slice(
			  0,
			  8
			)
			.map(([sub, n]) => (

			  <li
				key={`${title}-${sub}`}
				className="flex justify-between gap-2 text-[10px] leading-tight text-slate-600 sm:text-[11px]"
			  >

				<span
				  className="truncate min-w-0"
				  title={sub}
				>
				  {sub}
				</span>

				<span className="tabular-nums font-semibold text-slate-800 shrink-0">

				  {n}
				</span>
			  </li>
			))
		}
	  </ul>

	  {
		subBreakdown.length >
		8 && (

		  <p className="text-[9px] text-slate-400 mt-0.5 sm:text-[10px]">

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
  className="w-full h-auto text-left bg-white rounded-2xl shadow-md p-3 border border-slate-200 transition-all cursor-pointer hover:shadow-lg hover:border-blue-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
  onClick={onActivate}
  title={`Scroll to ${title} table`}
>

  {CardInner}
</button>
)
}

return (

<div className="h-auto bg-white rounded-2xl shadow-md p-3 border border-slate-200 opacity-80">

  {CardInner}
</div>
)
}