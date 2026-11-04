// Checks the way the extension starts a build: a Visual FoxPro of its own, the
// program is run, and Visual FoxPro closes again.
//
// The program is written into a scratch folder of its own, and it writes a file
// of its own, so the check says what happened and does not depend on anything
// left behind by an earlier run.
import { createRequire } from "node:module"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const require = createRequire(import.meta.url)
const { findVfp, runProgram } = require("../out/vfp.js")

const vfp = findVfp("")
console.log("the Visual FoxPro:", vfp ?? "not found")

const root = join(tmpdir(), "opencode", "buildtest")
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })

let wrong = 0

// a program that only writes a file
const program = join(root, "buildtest.prg")
const marker = join(root, "buildtest.txt")
writeFileSync(
  program,
  [
    "* writes down that it ran",
    `=STRTOFILE('the program ran', '${marker.replace(/\\/g, "/")}', 0)`,
    "",
  ].join("\r\n"),
  "latin1",
)

const started = Date.now()
const result = runProgram(vfp, program, root)
console.log("the result:", result.ok ? "ok" : "FAILED " + result.error)
console.log("the seconds:", Math.round((Date.now() - started) / 1000))
const wrote = existsSync(marker) ? readFileSync(marker, "utf8").trim() : ""
console.log("the marker  :", wrote || "not written")
if (!result.ok || wrote !== "the program ran") {
  console.log("WRONG       : a program that runs was not run")
  wrong++
}

// and a program that fails
const failing = join(root, "buildfail.prg")
writeFileSync(failing, 'ERROR "this program fails on purpose"', "latin1")
const second = runProgram(vfp, failing, root)
console.log("a program that fails:", second.ok ? "ok (that is wrong)" : "reported: " + second.error)
if (second.ok) {
  console.log("WRONG       : a program that fails was not reported")
  wrong++
}

console.log("")
if (wrong) {
  console.log(wrong + " thing(s) are wrong")
  process.exitCode = 1
} else {
  console.log("a program is run, and a failure is reported")
}
