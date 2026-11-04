// Checks which files .vfpignore leaves alone.
//
// The rules are checked one by one against a table of paths, and the files are
// made in a scratch folder of their own, so the list is read the way it is read
// in a real project.
//
// Run it with:
//   node node_modules/typescript/bin/tsc -p ./
//   node test/ignore.mjs
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const here = join(dirname(fileURLToPath(import.meta.url)), "..")
const { readIgnore } = require(join(here, "out", "ignore.js"))

const root = join(tmpdir(), "vfp-tools", "ignoretest")

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

// --- the rules ----------------------------------------------------------------------
const ignore = readIgnore(root)
console.log("the list      :", ignore.file)
console.log("it is there   :", ignore.present)
console.log("the patterns  :", ignore.count, "->", JSON.stringify(ignore.patterns))
console.log("")
let wrong = 0
for (const [file, wanted, why] of cases) {
  const got = ignore.ignores(join(root, file)) ? 1 : 0
  const mark = got === wanted ? "ok  " : "WRONG"
  if (got !== wanted) wrong++
  console.log(`${mark} ${got} (wanted ${wanted})  ${file}`)
  console.log(`           ${why}`)
}

rmSync(root, { recursive: true, force: true })

console.log("")
console.log(wrong === 0 ? "every rule holds." : `${wrong} WRONG`)
process.exit(wrong === 0 ? 0 : 1)
