// Checks the pane that follows the form: which previews are open, which one is
// turned off, and which file the picture moves to when another form is opened.
//
// The code that does this is the part of the extension that talks to Visual
// Studio Code, so the editor is stood in for here: the tabs, the open previews
// and the command that opens one are all faked, and what the extension does to
// them is checked. Nothing is started, and no form is drawn.
//
// Run it with:
//   cd extension
//   node node_modules/typescript/bin/tsc -p ./
//   node test/preview.mjs
import Module from "node:module"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = join(dirname(fileURLToPath(import.meta.url)), "..")
const require = createRequire(import.meta.url)

// --- a stand-in for the editor ------------------------------------------------------
const VIEW = "vfp.formPreview"
const commands = []
const messages = []
const focused = []

class Uri {
  constructor(fsPath) {
    this.fsPath = fsPath
    this.scheme = "file"
    this.toString = () => `file:///${fsPath.replace(/\\/g, "/")}`
  }
  static file(file) {
    return new Uri(file)
  }
}

class TabInputCustom {
  constructor(viewType, uri) {
    this.viewType = viewType
    this.uri = uri
  }
}

class TabInputText {
  constructor(uri) {
    this.uri = uri
  }
}

const groups = {
  all: [],
  activeTabGroup: { activeTab: undefined },
  close(tab) {
    for (const group of groups.all) {
      const at = group.tabs.indexOf(tab)
      if (at >= 0) {
        group.tabs.splice(at, 1)
        // A group with nothing in it is closed by the editor as well.
        groups.all = groups.all.filter((one) => one.tabs.length > 0)
        groups.activeTabGroup = groups.all[0] ?? { activeTab: undefined }
        if (groups.activeTabGroup.tabs?.length) groups.activeTabGroup.activeTab = groups.activeTabGroup.tabs[0]
        return Promise.resolve(true)
      }
    }
    return Promise.resolve(false)
  },
}

let registered

const fake = {
  Uri,
  TabInputCustom,
  TabInputText,
  ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 },
  window: {
    tabGroups: groups,
    activeTextEditor: undefined,
    showInformationMessage: async (message) => {
      messages.push(message)
    },
    showTextDocument: async (document, options) => {
      focused.push({ file: document.uri.fsPath, column: options?.viewColumn })
    },
    registerCustomEditorProvider: (viewType, provider, options) => {
      registered = { viewType, provider, options }
      return { dispose() {} }
    },
    onDidChangeActiveTextEditor: () => ({ dispose() {} }),
  },
  commands: {
    executeCommand: async (command, ...args) => {
      commands.push({ command, args })
      if (command !== "vscode.openWith") return
      // What the editor does with the request: a preview tab in the column that
      // was asked for, or beside the group that has the focus.
      const [uri, viewType, column] = args
      const focus = groups.activeTabGroup.viewColumn ?? fake.window.activeTextEditor?.viewColumn ?? 1
      const at = column === undefined || column === fake.ViewColumn.Beside ? focus + 1 : column
      let group = groups.all.find((one) => one.viewColumn === at)
      if (!group) {
        group = { viewColumn: at, tabs: [] }
        groups.all.push(group)
        groups.all.sort((one, two) => one.viewColumn - two.viewColumn)
      }
      const tab = { input: new TabInputCustom(viewType, uri), label: uri.fsPath, group }
      group.tabs.push(tab)
      groups.activeTabGroup = group
      group.activeTab = tab
    },
  },
  workspace: {},
}

const load = Module._load
Module._load = function (request, parent, isMain) {
  if (request === "vscode") return fake
  return load.call(this, request, parent, isMain)
}

const preview = require(join(here, "out", "preview.js"))

// --- a way to say what is wrong ----------------------------------------------------
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
  check(what, JSON.stringify(got) === JSON.stringify(wanted), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(wanted)}`)
}

/** Puts the tabs that are open in place, and forgets what was asked for. */
function open(...entries) {
  const byColumn = new Map()
  for (const entry of entries) {
    const column = entry.column ?? 1
    if (!byColumn.has(column)) byColumn.set(column, { viewColumn: column, tabs: [] })
    const input =
      entry.kind === "text"
        ? new TabInputText(Uri.file(entry.file))
        : new TabInputCustom(entry.viewType ?? VIEW, Uri.file(entry.file))
    byColumn.get(column).tabs.push({ input, label: entry.file, group: byColumn.get(column) })
  }
  groups.all = [...byColumn.values()].sort((one, two) => one.viewColumn - two.viewColumn)
  groups.activeTabGroup = groups.all[0] ?? { activeTab: undefined }
  if (groups.activeTabGroup.tabs?.length) groups.activeTabGroup.activeTab = groups.activeTabGroup.tabs[0]
  fake.window.activeTextEditor = undefined
  commands.length = 0
  messages.length = 0
  focused.length = 0
}

/** An editor of a text file, in a column. */
function editor(file, column = 1, scheme = "file") {
  const uri = new Uri(file)
  uri.scheme = scheme
  return { document: { uri }, viewColumn: column }
}

/** The previews that are in place, as a plain list. */
function shown() {
  return groups.all.map((group) => ({ column: group.viewColumn, files: group.tabs.map((tab) => tab.input.uri.fsPath) }))
}

// --- the preview editor itself ------------------------------------------------------
console.log("the preview as an editor")

{
  preview.activatePreview({ subscriptions: [] })
  same("it is registered for its own editor", registered?.viewType, VIEW)
  same("more than one form can be drawn at once", registered?.options?.supportsMultipleEditorsPerDocument, true)
  same("the form text stays as text", preview.FORM_TEXT.test("a.sc2") && preview.FORM_TEXT.test("B.VC2"), true)
  same("a program is not a form", preview.FORM_TEXT.test("a.prg"), false)
}

// --- which previews are open --------------------------------------------------------
console.log("")
console.log("the previews that are open")

{
  open(
    { file: "a.sc2", column: 1, kind: "text" },
    { file: "b.sc2", column: 2 },
    { file: "other.txt", column: 2, viewType: "other.editor" },
  )
  same(
    "only the previews of this extension are counted",
    preview.shownPreviews(),
    [{ file: "b.sc2", column: 2 }],
  )
  same("the file that is drawn is the file of the preview", preview.shownPreviews()[0].file, "b.sc2")

  open({ file: "a.sc2", column: 1, kind: "text" })
  same("a text editor is not a preview", preview.shownPreviews(), [])
}

// --- closing them -------------------------------------------------------------------
console.log("")
console.log("turning the preview off")

{
  open(
    { file: "a.sc2", column: 2 },
    { file: "b.sc2", column: 3 },
    { file: "c.SC2", column: 3 },
    { file: "a.sc2", column: 1, kind: "text" },
  )
  await preview.closePreviews("C.sc2")
  same(
    "only the preview of the file that was asked for goes",
    shown().map((group) => group.files),
    [["a.sc2"], ["a.sc2"], ["b.sc2"]],
  )

  await preview.closePreviews()
  same("all of them go when no file is asked for", shown().map((group) => group.files), [["a.sc2"]])
  same("and the text editor is left alone", groups.all[0].tabs[0].input.uri.fsPath, "a.sc2")
}

// --- opening one --------------------------------------------------------------------
console.log("")
console.log("showing a form")

{
  open({ file: "a.sc2", column: 1, kind: "text" })
  await preview.showPreview("b.sc2")
  same("it opens with the preview editor", commands[0]?.command, "vscode.openWith")
  same("of the file that was asked for", commands[0]?.args?.[0]?.fsPath, "b.sc2")
  same("and it is drawn beside the text", commands[0]?.args?.slice(1), [VIEW, -2])

  open({ file: "a.sc2", column: 1, kind: "text" })
  await preview.showPreview("b.sc2", 3)
  same("the column it was asked for is used", commands[0]?.args?.[2], 3)
}

// --- the key and the button ---------------------------------------------------------
console.log("")
console.log("the key that shows and hides the preview")

{
  open({ file: "a.sc2", column: 1, kind: "text" })
  fake.window.activeTextEditor = editor("a.sc2", 1)
  await preview.togglePreview()
  same("a press opens the preview of the form in the code window", commands[0]?.args?.[0]?.fsPath, "a.sc2")
  same("beside it", commands[0]?.args?.[2], -2)
  same("and the typing stays in the code", focused, [{ file: "a.sc2", column: 1 }])

  open({ file: "a.sc2", column: 1, kind: "text" }, { file: "a.sc2", column: 2 })
  fake.window.activeTextEditor = editor("a.sc2", 1)
  await preview.togglePreview("a.sc2")
  same("a second press hides it", shown().map((group) => group.files), [["a.sc2"]])
  same("and nothing is opened", commands, [])

  open({ file: "a.sc2", column: 2 }, { file: "b.sc2", column: 1, kind: "text" })
  await preview.togglePreview("b.sc2")
  same(
    "another form is drawn in the preview that is open",
    groups.all.find((one) => one.viewColumn === 2)?.tabs.map((tab) => tab.input.uri.fsPath),
    ["b.sc2"],
  )
  same("in the column it was in", commands[0]?.args?.[2], 2)

  open({ file: "a.sc2", column: 1, kind: "text" })
  await preview.togglePreview("a.prg")
  same("a program is not a form", commands, [])
  same("and the message says so", /form text file/.test(messages[0] ?? ""), true)

  // When the preview has the tab that is in front and no text editor has the
  // focus, the key still knows which form is drawn.
  open({ file: "a.sc2", column: 2 })
  groups.activeTabGroup = groups.all[0]
  groups.activeTabGroup.activeTab = groups.activeTabGroup.tabs[0]
  await preview.togglePreview()
  same("a press on the preview itself hides it", shown().map((group) => group.files), [])
}

// --- following what is edited -------------------------------------------------------
console.log("")
console.log("the preview following the code")

{
  open({ file: "a.sc2", column: 2 })
  await preview.followPreview(editor("b.sc2", 1))
  same("opening another form moves the picture to it", shown().map((group) => group.files), [["b.sc2"]])
  same("and the preview stays where it was", commands[0]?.args?.[2], 2)
  same("and the typing is left in the code", focused, [{ file: "b.sc2", column: 1 }])

  open({ file: "a.sc2", column: 2 })
  await preview.followPreview(editor("a.sc2", 1))
  same("the form that is already drawn is left alone", commands, [])
  same("and the picture stays", shown().map((group) => group.files), [["a.sc2"]])

  open({ file: "a.sc2", column: 2 })
  await preview.followPreview(editor("a.prg", 1))
  same("a program is not a form", commands, [])

  open({ file: "a.sc2", column: 1, kind: "text" })
  await preview.followPreview(editor("b.sc2", 1))
  same("a preview that is not open is not opened by a form", commands, [])

  // The text has been opened in the column the preview was in, so the picture
  // must not be put on top of it.
  open({ file: "a.sc2", column: 2 }, { file: "b.sc2", column: 2, kind: "text" })
  await preview.followPreview(editor("b.sc2", 2))
  same("the picture goes beside the text instead of over it", commands[0]?.args?.[2], -2)

  open({ file: "a.sc2", column: 2 })
  await preview.followPreview(editor("b.sc2", 1, "untitled"))
  same("a file that is not on the disk is not followed", commands, [])
}

// --- the answer -------------------------------------------------------------------
console.log("")
if (failures.length) {
  for (const failure of failures) console.log(`  FAILED  ${failure}`)
  console.log("")
  console.log(`${passed} checks passed, ${failures.length} FAILED`)
  process.exit(1)
}
console.log(`${passed} checks passed, nothing failed.`)
