// Checks which files .vfpignore leaves alone.
//
// Three things turn Visual FoxPro files into text with FoxBin2Prg, and all
// three read the same list, so all three have to agree about it:
//
//   * the extension, src/ignore.ts
//   * the plugin,    vfp-opencode/plugin/vfp/ignore.ts
//   * the bridge,    vfp-opencode/vfp/vfpoc_ignore.prg
//
// The rules are checked one by one against a table of paths, and then the same
// paths are put in front of the other two when their repository is next to
// this one. Set VFP_OPENCODE_HOME to its folder when it is somewhere else.
//
// Run it with:
//   node node_modules/typescript/bin/tsc -p ./
//   node test/ignore.mjs
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const require = createRequire(import.meta.url)
const here = join(dirname(fileURLToPath(import.meta.url)), "..")
const { readIgnore } = require(join(here, "out", "ignore.js"))
const { findVfp, runProgram } = require(join(here, "out", "vfp.js"))

const companion = process.env.VFP_OPENCODE_HOME || join(here, "..", "vfp-opencode")
const bridge = join(companion, "vfp", "vfpoc.prg")
const pluginSource = join(companion, "plugin", "vfp", "ignore.ts")

const root = join(tmpdir(), "opencode", "ignoretest")

// --- the list ----------------------------------------------------------------------
const list = [
  "# the exclude list for the test",
  "",
  "   ",
  "forms/frm_old.scx",
  "frm_anywhere.frx",
  "reports/legacy/",
  "legacy/",
  "/strict/menu.mnx",
  "**/deep/inner.lbx",
  "forms/frm_keep.*",
  "!forms/frm_keep.scx",
  "*.vc2",
].join("\r\n")

// --- what the rules mean, one case each ---------------------------------------------
const cases = [
  ["forms/frm_old.scx", 1, "one file, measured from the folder of the project"],
  ["forms/frm_old.SC2", 1, "the text file of a file that is left alone"],
  ["forms/frm_old.sct", 1, "the memo file of a file that is left alone"],
  ["other/frm_old.scx", 0, "the same name in another folder is another file"],
  ["frm_anywhere.frx", 1, "a pattern with no slash is about the name, wherever it is"],
  ["deep/down/frm_anywhere.frx", 1, "the same, further down"],
  ["reports/legacy/old.frx", 1, "a pattern that ends with a slash is a folder"],
  ["reports/legacy2/old.frx", 0, "a folder whose name only begins the same is not it"],
  ["other/legacy/old.frx", 1, "a folder pattern with no slash is about any folder of that name"],
  ["strict/menu.mnx", 1, "a leading slash means the folder of the project"],
  ["other/strict/menu.mnx", 0, "so the same path further down is not it"],
  ["deep/inner.lbx", 1, "**/ may stand for no folder at all"],
  ["a/deep/inner.lbx", 1, "or for one"],
  ["deep/more/inner.lbx", 0, "but the rest of the pattern still has to fit"],
  ["forms/frm_keep.scx", 0, "the last pattern that matches is the one that counts"],
  ["forms/frm_keep.SC2", 0, "which holds for the text file as well"],
  ["forms/frm_keep.frx", 1, "and the pattern before it counts for the others"],
  ["anything/x.VC2", 1, "a pattern about the text file is a pattern about the binary file"],
  ["ANYTHING/NESTED/X.VCX", 1, "and the case of the letters does not matter"],
]

// --- the project folder, with the files in it ---------------------------------------
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })
writeFileSync(join(root, ".vfpignore"), list, "latin1")
for (const [file] of cases) {
  const full = join(root, file)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, "", "latin1")
}

// --- 1. the rules, checked against the extension ------------------------------------
const ignore = readIgnore(root)
console.log("the list      :", ignore.file)
console.log("it is there   :", ignore.present)
console.log("the patterns  :", ignore.count, "->", JSON.stringify(ignore.patterns))
console.log("")
let extensionWrong = 0
for (const [file, wanted, why] of cases) {
  const got = ignore.ignores(join(root, file)) ? 1 : 0
  const mark = got === wanted ? "ok  " : "WRONG"
  if (got !== wanted) extensionWrong++
  console.log(`${mark} ${got} (wanted ${wanted})  ${file}`)
  console.log(`           ${why}`)
}
console.log("")
console.log("the extension:", extensionWrong === 0 ? "every rule holds" : `${extensionWrong} WRONG`)

// --- 2. the bridge, asked about the same paths --------------------------------------
let bridgeWrong = 0
let bridgeChecked = false
if (!existsSync(bridge)) {
  console.log("")
  console.log("the bridge    : not next to this repo, so it was not checked")
} else {
  const paths = join(root, "paths.txt")
  writeFileSync(paths, cases.map(([file]) => file).join("\r\n"), "latin1")
  const runner = join(root, "ask.prg")
  writeFileSync(
    runner,
    [
      "* Asks the bridge about the paths in paths.txt and puts the current folder back.",
      "LOCAL lcHere",
      "lcHere = FULLPATH('.')",
      "SET SAFETY OFF",
      `SET DEFAULT TO ("${root}")`,
      `DO ("${bridge}") WITH "ignore", "${paths}"`,
      "SET DEFAULT TO (m.lcHere)",
      "",
    ].join("\r\n"),
    "latin1",
  )

  const vfp = findVfp("")
  console.log("")
  console.log("the Visual FoxPro:", vfp ?? "not found")
  if (!vfp) {
    console.log("the bridge    : skipped, Visual FoxPro was not found")
  } else {
    bridgeChecked = true
    const answer = join(root, "paths.txt.out")
    rmSync(answer, { force: true })
    const result = runProgram(vfp, runner, root)
    console.log("the bridge    :", result.ok ? "ok" : "FAILED " + result.error)
    if (!existsSync(answer)) {
      console.log("the bridge did not answer.")
      const log = join(tmpdir(), "vfpoc_errors.log")
      if (existsSync(log)) console.log("the errors    :", readFileSync(log, "utf8").slice(-800))
      bridgeWrong = 1
    } else {
      const said = new Map()
      for (const line of readFileSync(answer, "utf8").split(/\r?\n/).filter(Boolean)) {
        const [file, value] = line.split("\t")
        said.set(file.replace(/\\/g, "/").toLowerCase(), value.trim())
      }
      for (const [file, wanted] of cases) {
        const got = said.get(file.toLowerCase())
        if (got !== String(wanted)) bridgeWrong++
      }
      console.log("the bridge    :", bridgeWrong === 0 ? "agrees with the extension" : `${bridgeWrong} WRONG`)
    }
  }
}

// --- 3. the plugin, asked about the same paths --------------------------------------
let pluginWrong = 0
let pluginChecked = false
if (!existsSync(pluginSource)) {
  console.log("")
  console.log("the plugin    : not next to this repo, so it was not checked")
} else {
  const pluginOut = join(tmpdir(), "opencode", "ignoretest-plugin")
  try {
    // tsc is run through node itself: a .cmd cannot be started directly.
    const tsc = join(here, "node_modules", "typescript", "bin", "tsc")
    execFileSync(
      process.execPath,
      [
        tsc,
        "ignore.ts",
        "--outDir",
        pluginOut,
        "--module",
        "esnext",
        "--target",
        "es2022",
        "--moduleResolution",
        "bundler",
        "--skipLibCheck",
      ],
      { cwd: join(companion, "plugin", "vfp"), encoding: "utf8", stdio: "pipe" },
    )
    pluginChecked = true
    const plugin = await import(pathToFileURL(join(pluginOut, "ignore.js")).href)
    const pluginIgnore = plugin.readIgnore(root)
    for (const [file, wanted] of cases) {
      const got = pluginIgnore.ignores(join(root, file)) ? 1 : 0
      if (got !== wanted) pluginWrong++
    }
    console.log("")
    console.log("the plugin    :", pluginWrong === 0 ? "agrees with the extension" : `${pluginWrong} WRONG`)
  } catch (error) {
    console.log("")
    console.log("the plugin could not be checked:", error instanceof Error ? error.message : String(error))
    pluginWrong = 1
  } finally {
    rmSync(pluginOut, { recursive: true, force: true })
  }
}

rmSync(root, { recursive: true, force: true })

const good = extensionWrong === 0 && (!bridgeChecked || bridgeWrong === 0) && (!pluginChecked || pluginWrong === 0)
console.log("")
console.log(good ? "the copies agree about every path." : "THE COPIES DO NOT AGREE.")
process.exit(good ? 0 : 1)
