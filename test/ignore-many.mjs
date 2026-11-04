// Checks the exclude list on a folder with many files, through the bridge.
//
// The bridge is given the paths one by one, so it reads the same .vfpignore
// that the extension reads and answers for every file. This is the same
// matching code that the project walk uses, on a folder large enough to
// notice a rule that is too broad.
//
// The companion repository is found next to this one, or through
// VFP_OPENCODE_HOME.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const here = join(dirname(fileURLToPath(import.meta.url)), "..")
const { findVfp, runProgram } = require(join(here, "out", "vfp.js"))

const companion = process.env.VFP_OPENCODE_HOME || join(here, "..", "vfp-opencode")
const bridge = join(companion, "vfp", "vfpoc.prg")
if (!existsSync(bridge)) {
  console.log("skipped: the bridge was not found. Set VFP_OPENCODE_HOME to the vfp-opencode folder.")
  process.exit(0)
}

const FORMS = 30
const REPORTS = 30
const root = join(tmpdir(), "opencode", "ignoremany")

rmSync(root, { recursive: true, force: true })
mkdirSync(join(root, "forms"), { recursive: true })
mkdirSync(join(root, "reports"), { recursive: true })

function fill(folder, ext, memo, textExt, prefix, count) {
  const names = []
  for (let i = 1; i <= count; i++) {
    const base = `${prefix}_${String(i).padStart(3, "0")}`
    const name = `${base}.${ext}`
    names.push(name)
    writeFileSync(join(root, folder, name), "", "latin1")
    writeFileSync(join(root, folder, `${base}.${memo}`), "", "latin1")
    writeFileSync(join(root, folder, `${base}${textExt}`), "", "latin1")
  }
  return names
}

const forms = fill("forms", "scx", "sct", ".SC2", "form", FORMS)
const reports = fill("reports", "frx", "frt", ".FR2", "report", REPORTS)
console.log("the test folder:", root)
console.log("the forms      :", forms.length)
console.log("the reports    :", reports.length)

const leftAlone = ["forms/" + forms[0].toLowerCase(), ...reports.map((name) => "reports/" + name.toLowerCase())]
const list = ["# for the test", leftAlone[0], "reports/*.frx", ""].join("\r\n")
writeFileSync(join(root, ".vfpignore"), list, "latin1")

// Every binary file of the folder, in the form that .vfpignore uses.
const paths = [...forms.map((name) => "forms/" + name), ...reports.map((name) => "reports/" + name)]
const pathsFile = join(root, "paths.txt")
writeFileSync(pathsFile, paths.join("\r\n"), "latin1")

const probe = join(root, "probe.prg")
writeFileSync(
  probe,
  [
    "* Asks the bridge which of these files are left alone.",
    "SET SAFETY OFF",
    `SET DEFAULT TO ("${root}")`,
    `DO ("${bridge}") WITH "ignore", "${pathsFile}"`,
    "QUIT",
    "",
  ].join("\r\n"),
  "latin1",
)

const vfp = findVfp("")
console.log("")
console.log("the Visual FoxPro:", vfp ?? "not found")
if (!vfp) {
  console.log("skipped: Visual FoxPro was not found.")
  rmSync(root, { recursive: true, force: true })
  process.exit(0)
}

rmSync(pathsFile + ".out", { force: true })
const started = Date.now()
const result = runProgram(vfp, probe, root)
console.log("the bridge      :", result.ok ? "ok" : "FAILED " + result.error)
console.log("the seconds     :", Math.round((Date.now() - started) / 1000))

const answer = pathsFile + ".out"
if (!result.ok || !existsSync(answer)) {
  const log = join(tmpdir(), "vfpoc_errors.log")
  if (existsSync(log)) console.log("the errors      :", readFileSync(log, "utf8").slice(-1200))
  rmSync(root, { recursive: true, force: true })
  console.log("\nthe bridge did not answer")
  process.exit(1)
}

const said = new Map()
for (const line of readFileSync(answer, "utf8").split(/\r?\n/).filter(Boolean)) {
  const [file, value] = line.split("\t")
  said.set(file.replace(/\\/g, "/").toLowerCase(), value.trim())
}

let wrong = 0
for (const file of paths) {
  const wanted = leftAlone.includes(file.toLowerCase()) ? "1" : "0"
  if (said.get(file.toLowerCase()) !== wanted) wrong++
}

console.log("")
console.log("the files asked :", paths.length)
console.log("the files kept  :", [...said.values()].filter((value) => value === "1").length)
console.log("the bridge      :", wrong === 0 ? "agrees about every file" : `${wrong} WRONG`)

rmSync(root, { recursive: true, force: true })

console.log("")
console.log(wrong === 0 ? "the folder is walked the right way." : "THE FOLDER IS NOT WALKED THE RIGHT WAY.")
process.exit(wrong === 0 ? 0 : 1)
