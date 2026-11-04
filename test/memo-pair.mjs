// Checks that a conversion writes BOTH the binary file and its memo.
//
// FoxBin2Prg makes the .scx and the .sct together, and they belong to each
// other. When only the .scx is put back, the form is broken: the .scx points
// into the memo, and the memo is the one that was there before.
//
// This check needs a real project. Set VFP_SAMPLE_PROJECT to its folder; the
// project itself is only read, never written to.
import { createRequire } from "node:module"
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sampleForm, sampleProject } from "./sample.mjs"

const require = createRequire(import.meta.url)
const { toBinary, toText, findTool } = require("../out/foxbin.js")

const root = sampleProject()
if (!root) process.exit(0)

const form = sampleForm(root)
if (!form) {
  console.log("skipped: the sample project has no form with a memo.")
  process.exit(0)
}

const tool = findTool(root)
if (!tool) {
  console.log("skipped: FoxBin2Prg was not found. Put foxbin2prg.exe in the project or set FOXBIN2PRG.")
  process.exit(0)
}

const work = join(tmpdir(), "opencode", "memotest")
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

// A form of the project, with its memo, in a folder of their own.
const binary = join(work, "frm_test.scx")
const memo = join(work, "frm_test.sct")
copyFileSync(form.binary, binary)
copyFileSync(form.memo, memo)

const first = toText(binary, tool)
if (!first.ok) {
  console.log("the text could not be made:", first.error)
  process.exit(1)
}

// The text is the master, so a change in it has to reach the binary file.
const text = first.path
let code = readFileSync(text, "latin1")
const changed = code.replace(/Height\s*=\s*\d+/, "Height = 727")
code = changed === code ? `${code}\r\n* changed by the test\r\n` : changed
writeFileSync(text, code, "latin1")

const beforeScx = statSync(binary).mtimeMs
const beforeSct = statSync(memo).mtimeMs

const result = toBinary(text, tool)
console.log("the build      :", result.ok ? "ok" : "FAILED " + result.error)

const afterScx = statSync(binary).mtimeMs
const afterSct = statSync(memo).mtimeMs

console.log("the .scx       :", afterScx === beforeScx ? "the same" : "written again")
console.log("the .SCT       :", afterSct === beforeSct ? "the same  <-- the memo was not written" : "written again")

// And the pair has to belong together, so the tool has to be able to read it.
const check = toText(binary, tool)
console.log("the pair reads :", check.ok ? "yes" : "NO " + check.error)
if (check.ok) {
  const made = readFileSync(check.path, "latin1")
  console.log("the change is in there:", made.includes("Height = 727") || made.includes("changed by the test"))
}

rmSync(work, { recursive: true, force: true })

if (!result.ok || !check.ok || afterScx === beforeScx || afterSct === beforeSct) {
  console.log("\nthe memo pair was not written together")
  process.exit(1)
}
console.log("\nthe binary file and its memo went back together")
