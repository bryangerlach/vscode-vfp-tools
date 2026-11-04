// Checks the marker that says which side of a text/binary pair changed.
//
// The marker is the contract between the extension and the Visual FoxPro
// bridge: both write the same file, so both have to read the same states.
// This test is self-contained; it makes a pair of files in a temporary folder.
import { createRequire } from "node:module"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"

const require = createRequire(import.meta.url)
const { markerFile, markPair, readMarker, stateOf } = require("../out/marker.js")

const root = mkdtempSync(join(tmpdir(), "vfp-marker-"))
const marker = join(root, "sync_test.txt")
const text = join(root, "frm_test.SC2")
const binary = join(root, "frm_test.scx")

let passed = 0
const failures = []
function check(what, ok, detail) {
  if (ok) {
    passed++
    return
  }
  failures.push(`${what}${detail ? `  --  ${detail}` : ""}`)
}
function same(what, got, wanted) {
  check(what, got === wanted, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(wanted)}`)
}

writeFileSync(text, "Height = 200\r\n", "latin1")
writeFileSync(binary, "binary one", "latin1")

// Before anything is marked, the times decide. The text was written last.
same("an unmarked pair uses the times", stateOf(text, binary, new Map(), true), "build")

markPair(marker, text, binary)
let marked = readMarker(marker)
same("the marker holds the pair", marked.size, 1)
same("the key is the text file in lower case", [...marked.keys()][0], text.toLowerCase())
same("a marked pair is in step", stateOf(text, binary, marked, false), "step")

// A change to the text means the binary file has to be built.
writeFileSync(text, "Height = 2400\r\n", "latin1")
same("a changed text file has to be built", stateOf(text, binary, marked, true), "build")

markPair(marker, text, binary)
marked = readMarker(marker)

// A change to the binary file means the text is behind it.
writeFileSync(binary, "binary two, changed", "latin1")
same("a changed binary file needs its text refreshed", stateOf(text, binary, marked, false), "refresh")

markPair(marker, text, binary)
marked = readMarker(marker)
same("marking again puts them back in step", stateOf(text, binary, marked, false), "step")

// A pair whose text file is gone is its own state.
rmSync(text)
same("a pair without a text file says so", stateOf(text, binary, marked, false), "notext")

// The marker name is derived from the project file and is neutral.
same(
  "the marker is named after the project",
  basename(markerFile(join(root, "myproject.pjx"))),
  "sync_myproject_pjx.txt",
)

rmSync(root, { recursive: true, force: true })

if (failures.length) {
  for (const failure of failures) console.log(`  FAILED  ${failure}`)
  console.log("")
  console.log(`${passed} checks passed, ${failures.length} FAILED`)
  process.exit(1)
}
console.log(`${passed} checks passed, nothing failed.`)
