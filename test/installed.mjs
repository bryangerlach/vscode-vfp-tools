// Checks that the extension that is installed is the one that was built, with
// all of its commands and its grammar.
//
// The folder is named after the version, so the version is read from the
// manifest of the extension that was built and not written down here: an
// extension that is installed under another version is not the one that was
// just built, and that is worth knowing.
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = join(dirname(fileURLToPath(import.meta.url)), "..")
const built = JSON.parse(readFileSync(join(here, "package.json"), "utf8"))

const home = process.env.USERPROFILE
const folder = join(home, ".vscode-oss", "extensions", `${built.publisher}.${built.name}-${built.version}`)

let good = true
function check(name, ok, note = "") {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${note ? "  " + note : ""}`)
  if (!ok) good = false
}

check("the extension is installed", existsSync(folder), folder)
if (!existsSync(folder)) process.exit(1)

const manifest = JSON.parse(readFileSync(join(folder, "package.json"), "utf8"))
const code = readFileSync(join(folder, manifest.main), "utf8")

check("it is the version that was built", manifest.version === built.version, manifest.version)
console.log("the name           :", manifest.displayName)
console.log("the languages      :", manifest.contributes.languages.map((l) => l.id).join(", "))
console.log("the grammar        :", manifest.contributes.grammars.map((g) => g.path).join(", "))
check("the grammar is there", existsSync(join(folder, manifest.contributes.grammars[0].path)))
check("the code is there", existsSync(join(folder, manifest.main)))

console.log("the commands       :")
for (const command of manifest.contributes.commands) {
  // Every command the manifest offers has to be registered in the code, or it
  // does nothing when it is picked.
  const registered = code.includes(`"${command.command}"`)
  console.log(`   ${registered ? " " : "!"} ${command.command.padEnd(26)} ${command.title}`)
  if (!registered) good = false
}
check("every command in the manifest is in the code", good)

// The buttons the user sees are the ones in the menus, so a command that is in
// none of them is not reachable.
const menus = manifest.contributes.menus ?? {}
const inMenus = new Set()
for (const items of Object.values(menus)) {
  for (const item of items) inMenus.add(item.command)
}
const unreachable = manifest.contributes.commands
  .map((c) => c.command)
  .filter((c) => !inMenus.has(c) && !(manifest.contributes.commandPalette ?? []).some((p) => p.command === c))
console.log("not in any menu    :", unreachable.length ? unreachable.join(", ") : "none")

// The preview is turned on from the form itself, so the button has to be on the
// title bar of a form text file, and the key has to be free of other files.
const title = (menus["editor/title"] ?? []).filter((item) => item.command === "vfp.togglePreview")
check(
  "the preview has a button on a form",
  title.length === 1 && /sc2/.test(title[0].when ?? "") && /vc2/.test(title[0].when ?? ""),
  title[0]?.when,
)
const keys = (manifest.contributes.keybindings ?? []).filter((one) => one.command === "vfp.togglePreview")
check("the preview has its own key", keys.length === 1 && keys[0].key === "ctrl+k v", keys[0]?.key)

// Go to Definition is a command of the editor, so it is registered in the code
// rather than in the manifest, and the file that does the work has to be there.
check(
  "Go to Definition is registered",
  code.includes("registerDefinitionProvider") && existsSync(join(folder, "out", "goto.js")),
)

// A button on the title bar is an icon, with its title in the tooltip; a long
// caption there takes the room that belongs to the code.
const captions = (menus["editor/title"] ?? []).filter((item) => {
  const command = manifest.contributes.commands.find((one) => one.command === item.command)
  return !command?.icon
})
check(
  "every button on the title bar is an icon",
  captions.length === 0,
  captions.map((one) => one.command).join(", "),
)

console.log(good ? "\nthe installed extension is the one that was built" : "\nthe installed extension is NOT the one that was built")
process.exit(good ? 0 : 1)
