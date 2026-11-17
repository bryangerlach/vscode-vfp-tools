// Checks the terminal command: what it says, and what it refuses to do.
//
// The project is made in a scratch folder and the files are dummies: this test
// is about the reading of the command line and the state, not about FoxBin2Prg.
// A conversion needs the real tool and a real form, and test/build.mjs covers
// the build itself.
import { execFileSync } from "node:child_process"
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = join(dirname(fileURLToPath(import.meta.url)), "..")
const cli = join(here, "out", "cli.js")
const root = join(tmpdir(), "vfp-tools", "clitest")

let passed = 0
const failures = []
function check(what, ok, detail) {
  if (ok) {
    passed++
    return
  }
  failures.push(`${what}${detail ? `  --  ${detail}` : ""}`)
}

/** Runs the command, and gives back what it said and how it ended. */
function run(args) {
  const env = { ...process.env, FOXBIN2PRG: "" }
  try {
    const out = execFileSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    return { code: 0, out, err: "" }
  } catch (error) {
    return {
      code: error.status ?? 1,
      out: String(error.stdout ?? ""),
      err: String(error.stderr ?? ""),
    }
  }
}

rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })

// A project with one pair whose text is newer than the binary, one binary
// without a text file, and one file that the exclude list leaves alone.
writeFileSync(join(root, "demo.pjx"), "", "latin1")
writeFileSync(join(root, "demo.PJ2"), "text\r\n", "latin1")
writeFileSync(join(root, "frm_demo.scx"), "binary", "latin1")
writeFileSync(join(root, "frm_demo.SC2"), "text\r\n", "latin1")
writeFileSync(join(root, "frm_bare.scx"), "binary", "latin1")
writeFileSync(join(root, "frm_ignored.scx"), "binary", "latin1")
writeFileSync(join(root, "frm_ignored.SC2"), "text\r\n", "latin1")
writeFileSync(join(root, ".vfpignore"), "frm_ignored.scx\r\n", "latin1")

const old = new Date(2020, 0, 1)
utimesSync(join(root, "demo.pjx"), old, old)
utimesSync(join(root, "demo.PJ2"), old, old)
utimesSync(join(root, "frm_demo.scx"), old, old)
utimesSync(join(root, "frm_bare.scx"), old, old)
utimesSync(join(root, "frm_ignored.scx"), old, old)
utimesSync(join(root, "frm_ignored.SC2"), old, old)

// --- the help ---------------------------------------------------------------------
const help = run(["--help"])
check("the help is there", help.code === 0 && help.out.includes("vfp-tools"))
check("the help names the commands", help.out.includes("build-project") && help.out.includes("status"))

// --- the status, as text and as JSON ----------------------------------------------
const status = run(["status", "--root", root])
check("the project is named", status.out.includes("demo.pjx"), status.out)
check(
  "a text file that is newer is waiting to be built",
  status.out.includes("Waiting to be built (the text is newer): 1"),
  status.out,
)
check("a binary file without text is counted", status.out.includes("Without a text file: 1"), status.out)
check("the exclude list is counted", status.out.includes("On the exclude list: 1"), status.out)

const json = run(["status", "--json", "--root", root])
let state
try {
  state = JSON.parse(json.out)
} catch {
  state = undefined
}
check("the JSON is JSON", Boolean(state), json.out)
check(
  "the JSON names the same file",
  Boolean(state?.toBuild?.some((file) => file.toLowerCase().endsWith("frm_demo.scx"))),
  json.out,
)
check(
  "the JSON leaves the ignored file out of the work",
  Boolean(state?.ignored?.some((file) => file.toLowerCase().endsWith("frm_ignored.scx"))),
  json.out,
)
check(
  "the JSON keeps the file without text apart",
  Boolean(state?.missing?.some((file) => file.toLowerCase().endsWith("frm_bare.scx"))),
  json.out,
)

// --- the refusals -----------------------------------------------------------------
const noFile = run(["build", "--root", root])
check("a command without a file says so", noFile.code === 1 && noFile.err.includes("which file"), noFile.err)

const noTool = run(["build", join(root, "frm_demo.SC2"), "--root", root])
check(
  "a conversion without FoxBin2Prg says what is missing",
  noTool.code === 1 && noTool.err.includes("FoxBin2Prg was not found"),
  noTool.err,
)

const wrong = run(["frobnicate", "--root", root])
check("an unknown command is refused", wrong.code === 1 && wrong.err.includes("unknown command"), wrong.err)

rmSync(root, { recursive: true, force: true })

console.log("")
console.log(passed + " checks passed, " + failures.length + " failed.")
for (const failure of failures) console.log("  FAIL " + failure)
process.exit(failures.length === 0 ? 0 : 1)
