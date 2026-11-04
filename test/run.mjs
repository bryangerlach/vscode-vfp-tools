// Checks that a program can be run in a Visual FoxPro of its own.
//
// The program writes down the folder it ran in, so the check says both that
// Visual FoxPro started it and that it started it where the project is.
// A program that opens a form waits for the user, so the editor does not wait
// for the program at all; that part is why the call has no result to wait on.
import { createRequire } from "node:module"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const require = createRequire(import.meta.url)
const { findVfp, startProgram } = require("../out/vfp.js")

const vfp = findVfp("")
console.log("the Visual FoxPro:", vfp ?? "not found")
if (!vfp) {
  console.log("skipped: Visual FoxPro was not found.")
  process.exit(0)
}

const root = join(tmpdir(), "vfp-tools", "runtest")
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })

const program = join(root, "runme.prg")
const marker = join(root, "ran.txt")
writeFileSync(
  program,
  [
    "* Writes down that it ran, and in which folder.",
    '=STRTOFILE(FULLPATH("."), "ran.txt", 0)',
    "QUIT",
    "",
  ].join("\r\n"),
  "latin1",
)

const started = startProgram(vfp, program, root)
console.log("the start       :", started.ok ? "ok" : "FAILED " + started.error)

// Visual FoxPro takes a moment to start, and longer on a busy machine.
let ran = false
for (let i = 0; i < 300; i++) {
  if (existsSync(marker)) {
    ran = true
    break
  }
  await new Promise((resolve) => setTimeout(resolve, 100))
}

const where = ran ? readFileSync(marker, "utf8").trim() : ""
console.log("it ran          :", ran ? "yes" : "no")
console.log("in the folder   :", where || "(nothing was written)")

rmSync(root, { recursive: true, force: true })

const good = started.ok && ran && where.toLowerCase().startsWith(root.toLowerCase())
console.log("")
console.log(good ? "the program ran in the project folder" : "THE PROGRAM DID NOT RUN")
process.exit(good ? 0 : 1)
