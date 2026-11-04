import * as fs from "node:fs"
import * as path from "node:path"
import * as vscode from "vscode"
import {
  KINDS,
  binaryPathOf,
  filesOfKind,
  findTool,
  textPathOf,
  toBinary,
  toText,
} from "./foxbin"
import { findVfp, ideIsRunning, openCommand, runInIde, runProgram } from "./vfp"
import { VfpEntry, VfpNode, VfpTree } from "./tree"
import { markAll, markPair, markerFile, readMarker, stateOf } from "./marker"
import { IGNORE_NAME, ignoreFile, readIgnore, starterIgnore } from "./ignore"
import { FORM_TEXT, VIEW_TYPE, activatePreview, followPreview, togglePreview } from "./preview"
import { definitionsAt, forgetIndex } from "./goto"

/**
 * Visual FoxPro Tools.
 *
 * A .scx, .vcx, .frx, .mnx, .lbx and .pjx file is binary and cannot be read
 * by a text editor. FoxBin2Prg turns it into the matching .sc2, .vc2, .fr2,
 * .mn2, .lb2 and .pj2 file, which holds the same thing as text.
 *
 * The text file is the master and the binary file is the build, the same way
 * a program is the master and the compiled form is the build. So:
 *
 *   * "Rebuild the binary files from the text files" builds the .scx from the
 *     .sc2, and that is what a build needs.
 *   * "Rebuild the text files from the binary files" makes the .sc2 from the
 *     .scx, and that is what is needed after a form was changed in the
 *     designer.
 *
 * The project of the user is found from the folder of the workspace, and the
 * Visual FoxPro that is running is used to open a file in the designer.
 */

/** The project file of the workspace, when it can be found. */
interface Project {
  /** The folder of the project. */
  root: string
  /** The project file, for example myproject.pjx. */
  file: string
}

/** What the extension found in the workspace. */
interface Workspace {
  project?: Project
  /** The folder the extension works in. */
  root: string
  /** The program that builds the project. */
  buildProgram?: string
}
let status: vscode.StatusBarItem
let output: vscode.OutputChannel
let tree: VfpTree

export function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel("VFP")
  context.subscriptions.push(output)

  // The files of the project, in the explorer.
  tree = new VfpTree()
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("vfp.files", tree),
    vscode.window.createTreeView("vfp.files", {
      treeDataProvider: tree,
      showCollapseAll: true,
    }),
  )

  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  status.command = "vfp.menu"
  context.subscriptions.push(status)

  // The form as a picture, in an editor of its own.
  activatePreview(context)

  const pick = async (what: string) => {
    const setting =
      what === "the build program"
        ? "buildProgram"
        : what === "the project file"
          ? "projectFile"
          : "foxbin2prg"
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: what,
      title: what,
      filters:
        setting === "projectFile"
          ? { "Visual FoxPro projects": ["pjx"] }
          : setting === "foxbin2prg"
            ? { "FoxBin2Prg": ["exe"] }
            : { "Visual FoxPro programs": ["prg"] },
    })
    if (picked?.[0]) {
      const config = vscode.workspace.getConfiguration("vfp")
      await config.update(setting, picked[0].fsPath, true)
      refreshStatus()
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("vfp.buildProject", guard(() => buildProject())),
    vscode.commands.registerCommand("vfp.rebuildBinaries", guard(() => rebuildBinaries())),
    vscode.commands.registerCommand("vfp.rebuildText", guard(() => rebuildText())),
    vscode.commands.registerCommand("vfp.syncProject", guard(() => syncProject())),
    vscode.commands.registerCommand("vfp.resolveAll", guard(() => resolveAll())),
    vscode.commands.registerCommand("vfp.checkProject", guard(() => checkProject())),
    vscode.commands.registerCommand("vfp.openInIde", guard((file?: vscode.Uri | VfpNode) => openInIde(file))),
    vscode.commands.registerCommand("vfp.previewForm", guard((file?: vscode.Uri | VfpNode) => previewForm(file))),
    vscode.commands.registerCommand("vfp.togglePreview", guard((file?: vscode.Uri | VfpNode) => togglePreview(fileOf(file)))),
    vscode.commands.registerCommand("vfp.selectBuildProgram", guard(() => pick("the build program"))),
    vscode.commands.registerCommand("vfp.selectFoxBin2Prg", guard(() => pick("FoxBin2Prg"))),
    vscode.commands.registerCommand("vfp.menu", guard(() => showMenu())),
    vscode.commands.registerCommand("vfp.rebuildOne", guard((file?: vscode.Uri | VfpNode) => rebuildOne(file))),
    vscode.commands.registerCommand("vfp.refreshOne", guard((file?: vscode.Uri | VfpNode) => refreshOne(file))),
    vscode.commands.registerCommand("vfp.selectProjectFile", guard(() => pick("the project file"))),
    vscode.commands.registerCommand("vfp.editIgnore", guard(() => editIgnore())),
  )

  // The preview follows the form text that is being edited, so the picture and
  // the code stay together the way the designer and the code window do.
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(guard((editor) => followPreview(editor))),
  )

  // Go to Definition, F12 and Ctrl+click. A name that is in the project is
  // answered by goto.ts; a name that is not is left unanswered, because it can
  // be in a DLL or an APP that has no text to go to.
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(
      { language: "vfp", scheme: "file" },
      {
        provideDefinition(document, position) {
          const targets = definitionsAt(
            {
              file: document.uri.fsPath,
              text: document.getText(),
              line: position.line + 1,
              column: position.character + 1,
              root: projectFolder(),
            },
            sourceText,
          )
          return targets.map(
            (one) =>
              new vscode.Location(vscode.Uri.file(one.file), new vscode.Position(one.line - 1, 0)),
          )
        },
      },
    ),
  )

  // What was found in the folders is dropped when a file is written or added,
  // so a procedure that was just made is found straight away.
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(() => forgetIndex()),
    vscode.workspace.onDidCreateFiles(() => forgetIndex()),
    vscode.workspace.onDidDeleteFiles(() => forgetIndex()),
    vscode.workspace.onDidRenameFiles(() => forgetIndex()),
  )

  /**
   * Wraps a command so that anything unforeseen becomes a message.
   *
   * A command that throws is reported by Visual Studio Code as "A system error
   * occurred", with whatever the error says, and there is nothing to be done
   * with that. The commands here say what went wrong instead, and they never
   * leave the extension in a state where nothing can be done about it.
   */
  function guard<A extends unknown[]>(run: (...args: A) => unknown): (...args: A) => Promise<void> {
    return async (...args: A) => {
      try {
        await run(...args)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        output.appendLine(`the command did not go through: ${message}`)
        void vscode.window.showErrorMessage(`VFP: ${message}`)
      }
    }
  }

  // A text file that is saved is built into its binary file again, when that
  // is what the user wants.
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (document) => {
      // The exclude list itself is worth looking at again as soon as it is
      // saved, so a file that was taken off the list shows up straight away.
      if (path.basename(document.uri.fsPath).toLowerCase() === IGNORE_NAME) {
        refreshStatus()
        return
      }
      if (!vscode.workspace.getConfiguration("vfp").get<boolean>("buildOnSave", false)) return
      try {
        const binary = binaryPathOf(document.uri.fsPath)
        if (!binary) return
        if (isIgnored(binary)) return
        const tool = findTool(workspace()?.project?.root, vscode.workspace.getConfiguration("vfp").get<string>("foxbin2prg"))
        if (!tool) return
        const result = toBinary(document.uri.fsPath, tool)
        if (result.ok) {
          output.appendLine(`built ${path.basename(binary)} from ${path.basename(document.uri.fsPath)}`)
        } else {
          output.appendLine(`could not build ${path.basename(binary)}: ${result.error ?? ""}`)
        }
        refreshStatus()
      } catch (error) {
        // A file that is saved must never be the reason a message about a
        // scratch folder turns up.
        const message = error instanceof Error ? error.message : String(error)
        output.appendLine(`could not build ${path.basename(document.uri.fsPath)}: ${message}`)
      }
    }),
  )

  // The status bar follows the files that are open.
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => refreshStatus()),
    vscode.workspace.onDidSaveTextDocument(() => refreshStatus()),
    vscode.workspace.onDidChangeConfiguration(() => refreshStatus()),
  )

  refreshStatus()
}

/** The extension is not needed when no Visual FoxPro file is in sight. */
export function deactivate() {
  /* nothing to clean up */
}

/** The workspace of the user, and what was found in it. */
function workspace(): Workspace {
  const folders = vscode.workspace.workspaceFolders
  const root = folders?.[0]?.uri.fsPath ?? ""
  const config = vscode.workspace.getConfiguration("vfp")

  let project: Project | undefined
  const configured = config.get<string>("projectFile", "")
  if (configured) {
    const file = path.isAbsolute(configured) ? configured : path.join(root, configured)
    if (fs.existsSync(file)) {
      project = { root: path.dirname(file), file }
    }
  }
  if (!project) {
    const found = findProject(root)
    if (found) project = found
  }

  let buildProgram: string | undefined = config.get<string>("buildProgram", "")
  if (buildProgram && !path.isAbsolute(buildProgram)) {
    buildProgram = path.join(root, buildProgram)
  }
  if (buildProgram && !fs.existsSync(buildProgram)) {
    buildProgram = undefined
  }
  if (!buildProgram && project) {
    buildProgram = findBuildProgram(project.root)
  }

  return { project, root, buildProgram }
}

/** Looks for the project file of a folder. */
function findProject(root: string): Project | undefined {
  if (!root) return undefined
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!entry.name.toLowerCase().endsWith(".pjx")) continue
    return { root, file: path.join(root, entry.name) }
  }
  return undefined
}

/** Looks for the program that builds the project. */
/**
 * Looks for the program that builds the project.
 *
 * A program that builds a project holds a BUILD EXE or a BUILD PROJECT
 * command, so the programs of the project are looked at for one. The names
 * that are used most often are tried first, because they are the ones a
 * person is most likely to want.
 */
function findBuildProgram(root: string): string | undefined {
  const names = [
    "build_it.prg",
    "build.prg",
    "build_project.prg",
    "buildproject.prg",
  ]
  const folders = [path.join(root, "progs"), root, path.join(root, "build")]
  for (const folder of folders) {
    for (const name of names) {
      const candidate = path.join(folder, name)
      if (fs.existsSync(candidate)) return candidate
    }
  }
  // Then every program that holds a build command.
  for (const folder of folders) {
    for (const file of prgFiles(folder)) {
      try {
        const text = fs.readFileSync(file, "utf8")
        if (/\bBUILD\s+(EXE|PROJECT|APP|DLL)\b/i.test(text)) return file
      } catch {
        /* a program that cannot be read is not the one */
      }
    }
  }
  return undefined
}

/** The programs of a folder, and of the folders in it. */
function prgFiles(folder: string): string[] {
  const found: string[] = []
  const walk = (where: string, depth: number) => {
    if (depth > 2) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(where, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(where, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (entry.name.toLowerCase().endsWith(".prg")) found.push(full)
    }
  }
  walk(folder, 0)
  return found
}

/** The FoxBin2Prg program, when it can be found. */
function tool(): string | undefined {
  const config = vscode.workspace.getConfiguration("vfp")
  return findTool(workspace().project?.root ?? workspace().root, config.get<string>("foxbin2prg", ""))
}

/** The files of the project that have both a binary and a text form. */
function pairs(): Array<{ binary: string; text: string }> {
  const project = workspace().project
  if (!project) return []
  const found: Array<{ binary: string; text: string }> = []
  for (const kind of KINDS) {
    for (const binary of filesOfKind(project.root, kind)) {
      const text = textPathOf(binary)
      if (!text) continue
      found.push({ binary, text })
    }
  }
  return found
}

/**
 * What is out of step.
 *
 * The text file is the master, so a text file that is newer than its binary
 * file is waiting to be built. A binary file that is newer than its text
 * file was changed in the designer, and the text has to catch up.
 */
function survey(): { toBuild: string[]; toRefresh: string[]; missing: string[] } {
  const toBuild: string[] = []
  const toRefresh: string[] = []
  const missing: string[] = []
  for (const entry of entries()) {
    if (entry.state === "build") toBuild.push(entry.binary)
    else if (entry.state === "refresh") toRefresh.push(entry.binary)
    else if (entry.state === "notext") missing.push(entry.binary)
  }
  return { toBuild, toRefresh, missing }
}

/** The files of the project, with the state of each one. */
function entries(): VfpEntry[] {
  const found: VfpEntry[] = []
  const marked = readMarker(marker())
  const ignore = readIgnore(projectRoot())
  for (const pair of pairs()) {
    // A file that is on the exclude list is not converted, so it is not said
    // to be out of step either. It is shown, and it is left alone.
    if (ignore.ignores(pair.binary)) {
      found.push({ binary: pair.binary, text: pair.text, state: "ignored" })
      continue
    }
    const textIsNewer = newerThan(pair.text, pair.binary)
    const state = stateOf(pair.text, pair.binary, marked, textIsNewer)
    found.push({ binary: pair.binary, text: pair.text, state })
  }
  return found
}

/** The folder of the project, or the folder of the workspace. */
function projectRoot(): string {
  const state = workspace()
  return state.project?.root ?? state.root
}

/**
 * The folder of the project, without looking for the build program.
 *
 * Go to Definition is asked on every F12 and every Ctrl+click, so it only needs
 * the folder, which is the first folder of the workspace or the folder of the
 * project file when one was chosen.
 */
function projectFolder(): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ""
  const configured = vscode.workspace.getConfiguration("vfp").get<string>("projectFile", "")
  if (configured) {
    const file = path.isAbsolute(configured) ? configured : path.join(root, configured)
    if (fs.existsSync(file)) return path.dirname(file)
  }
  return root
}

/** The exclude list of the project. */
function ignoreList() {
  return readIgnore(projectRoot())
}

/** Whether a file is on the exclude list, by either of its two names. */
function isIgnored(file: string): boolean {
  const list = ignoreList()
  if (list.ignores(file)) return true
  const binary = binaryPathOf(file)
  return binary ? list.ignores(binary) : false
}

/** Says that a file is on the exclude list, and where the list is. */
function refuseIgnored(file: string): void {
  const list = ignoreFile(projectRoot())
  output.appendLine(`${path.basename(file)} is on the exclude list, so it is left alone: ${list}`)
  void vscode.window.showInformationMessage(
    `${path.basename(file)} is on the exclude list (.vfpignore) and is never converted. Take it off the list to use it.`,
  )
}

/** The marker file of the project. */
function marker(): string {
  const project = workspace().project
  return markerFile(project ? path.basename(project.file) : "project")
}

/** Whether the first file was written after the second one. */
function newerThan(one: string, two: string): boolean {
  try {
    return fs.statSync(one).mtimeMs > fs.statSync(two).mtimeMs
  } catch {
    return false
  }
}

/** Shows what is out of step, and does nothing else. */
async function checkProject() {
  const state = survey()
  const excluded = entries().filter((entry) => entry.state === "ignored").length
  const list = ignoreList()
  const lines = [
    `Project: ${workspace().project?.file ?? "not found"}`,
    `Waiting to be built (the text is newer): ${state.toBuild.length}`,
    `Behind (the binary is newer): ${state.toRefresh.length}`,
    `Without a text file: ${state.missing.length}`,
    `On the exclude list: ${excluded}${list.present ? ` (${list.count} pattern(s) in ${list.file})` : ""}`,
  ]
  for (const file of state.toBuild.slice(0, 20)) lines.push(`  to build: ${file}`)
  for (const file of state.toRefresh.slice(0, 20)) lines.push(`  to refresh: ${file}`)
  for (const file of state.missing.slice(0, 20)) lines.push(`  no text: ${file}`)
  if (state.toBuild.length > 20 || state.toRefresh.length > 20 || state.missing.length > 20) {
    lines.push("  ...")
  }
  output.appendLine(lines.join("\n"))
  output.show(true)
  void vscode.window.showInformationMessage(
    `${state.toBuild.length} to build, ${state.toRefresh.length} to refresh, ${state.missing.length} without text`,
  )
  refreshStatus()
}

/**
 * Opens the exclude list, and writes it first when it is not there.
 *
 * The list is a file in the project folder, so the three things that convert
 * files all read the same one: the extension, the OpenCode plugin and the
 * Visual FoxPro bridge.
 */
async function editIgnore() {
  const file = ignoreFile(projectRoot())
  if (!fs.existsSync(file)) {
    try {
      fs.writeFileSync(file, starterIgnore(), "utf8")
      output.appendLine(`wrote ${file}`)
    } catch (error) {
      void vscode.window.showErrorMessage(
        `The exclude list could not be written: ${error instanceof Error ? error.message : String(error)}`,
      )
      return
    }
  }
  await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(file))
  refreshStatus()
}

/**
 * Builds every binary file again from its text file.
 *
 * This is not the same as putting the files in step: every pair that has a text
 * file is built, whether or not it is out of step. The text file is the master,
 * so nothing that was written by hand can be lost, and a binary file that got
 * out of shape is put back the way it should be.
 */
async function rebuildBinaries() {
  const pairs = entries().filter((entry) => entry.state !== "ignored" && entry.state !== "notext")
  if (!pairs.length) {
    void vscode.window.showInformationMessage("There is no text file to build a binary file from.")
    return
  }
  const answer = await vscode.window.showInformationMessage(
    `Build ${pairs.length} binary file(s) again from their text file(s)?`,
    "Build them",
    "Cancel",
  )
  if (answer !== "Build them") return
  await convert(
    pairs.map((entry) => entry.binary),
    "binary",
  )
}

/** Makes the text files from the binary files. */
async function rebuildText() {
  const state = survey()
  const todo = [...state.toRefresh, ...state.missing]
  if (!todo.length) {
    void vscode.window.showInformationMessage("Every text file is in step with its binary file.")
    return
  }
  await convert(todo, "text")
}

/** Builds the binary files of the files that are out of step. */
async function syncProject() {
  const state = survey()
  if (!state.toBuild.length) {
    void vscode.window.showInformationMessage("Every binary file is in step with its text file.")
    return
  }
  await convert(state.toBuild, "binary")
}

/**
 * Puts every file in step, whichever way it is out of step.
 *
 * Three things can be waiting, and all three are dealt with here, so that one
 * button is enough after a session of work.
 *
 * A text file that was changed is built into its binary file, because the text
 * file is the master. A binary file that was changed is turned into its text
 * file again, and that is safe, because the marker only calls a file behind
 * when its text file was not touched since the two were last in step. A binary
 * file that has no text file at all is made into one.
 *
 * Nothing that was written by hand can be lost, whatever the three lists hold,
 * so the whole lot can be done without looking at the files one by one.
 */
async function resolveAll() {
  const state = survey()
  const waiting = state.toBuild.length + state.toRefresh.length + state.missing.length
  if (!waiting) {
    void vscode.window.showInformationMessage("Every file is in step.")
    return
  }
  const answer = await vscode.window.showInformationMessage(
    `${state.toBuild.length} to build, ${state.toRefresh.length} to refresh, ` +
      `${state.missing.length} without a text file. Do it?`,
    "Do it",
    "Cancel",
  )
  if (answer !== "Do it") return
  // The text files are the master, so those are built into their binary files
  // first. What is left is the other direction.
  if (state.toBuild.length) {
    await convert(state.toBuild, "binary")
  }
  const make = [...state.toRefresh, ...state.missing]
  if (make.length) {
    await convert(make, "text")
  }
}

/** Turns files from one form into the other. */
async function convert(files: string[], direction: "binary" | "text") {
  // A file that is on the exclude list is never converted, whatever asked for
  // it. This is the last gate before the tool is run.
  const leftAlone = files.filter((file) => isIgnored(file))
  if (leftAlone.length) {
    output.appendLine(`${leftAlone.length} file(s) are on the exclude list and were left alone.`)
    files = files.filter((file) => !isIgnored(file))
  }
  if (!files.length) {
    void vscode.window.showInformationMessage("There is nothing to do: the rest is on the exclude list.")
    return
  }
  const foxbin = tool()
  if (!foxbin) {
    void vscode.window.showErrorMessage(
      "FoxBin2Prg was not found. Put foxbin2prg.exe in the project folder, or run the VFP: Choose the FoxBin2Prg program command.",
    )
    return
  }
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: direction === "binary" ? "Building the binary files" : "Making the text files",
      cancellable: false,
    },
    async (report) => {
      let done = 0
      let failed = 0
      const marked: Array<{ text: string; binary: string }> = []
      for (const file of files) {
        report.report({ message: `${++done} of ${files.length}: ${path.basename(file)}` })
        const result =
          direction === "binary" ? toBinary(textPathOf(file)!, foxbin) : toText(file, foxbin)
        if (result.ok) {
          output.appendLine(`${direction === "binary" ? "built" : "made"} ${path.basename(file)}`)
          // The two were made from each other, so the marker says so.
          const text = textPathOf(file)
          if (text) marked.push({ text, binary: file })
        } else {
          failed++
          output.appendLine(`could not do ${path.basename(file)}: ${result.error ?? ""}`)
        }
      }
      // The marker is written once, at the end, so it does not have to be read
      // and written again for every file.
      if (marked.length) markAll(marker(), marked)
      refreshStatus()
      const message =
        failed === 0
          ? `${files.length} file(s) done.`
          : `${files.length - failed} of ${files.length} done, ${failed} failed. The log says why.`
      void vscode.window.showInformationMessage(message)
      if (failed) output.show(true)
    },
  )
}

/** Builds the project. */
async function buildProject() {
  const state = workspace()
  if (!state.project) {
    void vscode.window.showErrorMessage("No Visual FoxPro project was found. Set vfp.projectFile in the settings.")
    return
  }

  // The binary files are built from the text files first, because the build
  // uses the binary files and the text files are the master.
  const surveyState = survey()
  if (surveyState.toBuild.length) {
    const answer = await vscode.window.showInformationMessage(
      `${surveyState.toBuild.length} file(s) have a text file that is newer than the binary file. Build them first?`,
      "Build them",
      "Build without",
    )
    if (answer === "Build them") {
      await convert(surveyState.toBuild, "binary")
    }
  }

  const program = state.buildProgram
  if (!program) {
    void vscode.window.showErrorMessage(
      "No build program was found. Set vfp.buildProgram in the settings, or run the VFP: Choose the program that builds the project command.",
    )
    return
  }

  const vfp = findVfp(vscode.workspace.getConfiguration("vfp").get<string>("vfpExe", ""))
  if (!vfp) {
    void vscode.window.showErrorMessage("Visual FoxPro was not found.")
    return
  }

  output.appendLine(`building with ${program}`)
  output.show(true)
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Building the project", cancellable: false },
    async () => runProgram(vfp, program, path.dirname(program)),
  )
  if (result.ok) {
    output.appendLine("the build is done.")
    void vscode.window.showInformationMessage("The project is built.")
  } else {
    output.appendLine(`the build failed: ${result.error ?? ""}`)
    void vscode.window.showErrorMessage("The build failed. The log says why.")
  }
  refreshStatus()
}

/** Opens a file in the Visual FoxPro IDE. */
async function openInIde(file?: vscode.Uri | VfpNode) {
  const target = fileOf(file)
  if (!target) {
    void vscode.window.showErrorMessage("There is no file to open.")
    return
  }
  if (!ideIsRunning()) {
    const answer = await vscode.window.showInformationMessage(
      "Visual FoxPro is not running. Start it and try again?",
      "Start it",
    )
    if (answer !== "Start it") return
    const vfp = findVfp(vscode.workspace.getConfiguration("vfp").get<string>("vfpExe", ""))
    if (!vfp) {
      void vscode.window.showErrorMessage("Visual FoxPro was not found.")
      return
    }
    require("node:child_process").spawn(vfp, [], { detached: true, stdio: "ignore" }).unref()
    void vscode.window.showInformationMessage("Visual FoxPro is starting. Run the command again in a moment.")
    return
  }
  const result = runInIde(openCommand(target))
  if (!result.ok) {
    void vscode.window.showErrorMessage(`Visual FoxPro did not take the command: ${result.error ?? ""}`)
  }
}

/**
 * Shows the form of a text file as a picture, beside the text.
 *
 * The picture is drawn from the text file, so what is seen is the text and
 * nothing else. A form that has no text file yet is turned into one first,
 * because there is nothing to draw otherwise.
 */
async function previewForm(file?: vscode.Uri | VfpNode) {
  const chosen = fileOf(file)
  if (!chosen) {
    void vscode.window.showInformationMessage("Open a form first, or pick one in the panel.")
    return
  }
  const text = FORM_TEXT.test(chosen) ? chosen : textPathOf(chosen)
  const binary = text ? binaryPathOf(text) : undefined
  if (!text || !binary) {
    void vscode.window.showInformationMessage("That is not a form. A .sc2 or a .vc2 file can be drawn.")
    return
  }
  if (isIgnored(binary)) {
    refuseIgnored(binary)
    return
  }
  if (!fs.existsSync(text)) {
    const answer = await vscode.window.showInformationMessage(
      `${path.basename(binary)} has no text file yet. Make it and show the form?`,
      "Make it",
    )
    if (answer !== "Make it") return
    const program = tool()
    if (!program) {
      void vscode.window.showWarningMessage("FoxBin2Prg was not found. Choose it first.")
      return
    }
    const made = toText(binary, program)
    if (!made.ok) {
      output.appendLine(`could not make the text of ${path.basename(binary)}: ${made.error ?? ""}`)
      void vscode.window.showErrorMessage("The text file could not be made. The log says why.")
      output.show(true)
      return
    }
  }
  await vscode.commands.executeCommand(
    "vscode.openWith",
    vscode.Uri.file(text),
    VIEW_TYPE,
    vscode.ViewColumn.Beside,
  )
}

/**
 * The menu of the extension.
 *
 * It is what the status bar opens, and it holds every command, so that
 * nobody has to remember a name.
 */
async function showMenu() {
  const state = survey()
  const items: (vscode.QuickPickItem & { command?: string })[] = [
    {
      label: "$(check-all) Put everything in step",
      description:
        state.toBuild.length || state.toRefresh.length || state.missing.length
          ? `${state.toBuild.length} to build, ${state.toRefresh.length} to refresh, ${state.missing.length} without a text file`
          : "nothing to do",
      command: "vfp.resolveAll",
    },
    {
      label: "$(tools) Bring the binary files in step with the text files",
      description: state.toBuild.length ? `${state.toBuild.length} to build` : "nothing to do",
      command: "vfp.syncProject",
    },
    {
      label: "$(file-binary) Rebuild the binary files from the text files",
      description: "every file, whether or not it is out of step",
      command: "vfp.rebuildBinaries",
    },
    {
      label: "$(file-text) Rebuild the text files from the binary files",
      command: "vfp.rebuildText",
    },
    {
      label: "$(check) Show what is out of step",
      description: state.toRefresh.length ? `${state.toRefresh.length} behind` : "",
      command: "vfp.checkProject",
    },
    {
      label: "$(gear) Build the project",
      command: "vfp.buildProject",
    },
    {
      label: "$(preview) Show the form of the file in the editor",
      command: "vfp.previewForm",
    },
    {
      label: "$(preview) Show or hide the form preview beside the code",
      command: "vfp.togglePreview",
    },
    {
      label: "$(window) Open the file in the Visual FoxPro IDE",
      command: "vfp.openInIde",
    },
    { label: "$(settings) Choose the program that builds the project", command: "vfp.selectBuildProgram" },
    { label: "$(settings) Choose the FoxBin2Prg program", command: "vfp.selectFoxBin2Prg" },
    { label: "$(circle-slash) Edit the exclude list (.vfpignore)", command: "vfp.editIgnore" },
  ]
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "Visual FoxPro",
    title: "Visual FoxPro",
  })
  if (picked?.command) {
    await vscode.commands.executeCommand(picked.command)
  }
}

/**
 * Rebuilds the binary file of one text file.
 *
 * This is what the tree and the menus of a file use.
 */
async function rebuildOne(file?: vscode.Uri | VfpNode) {
  const target = fileOf(file)
  if (!target) {
    void vscode.window.showErrorMessage("There is no file to build.")
    return
  }
  if (isIgnored(target)) {
    refuseIgnored(target)
    return
  }
  const foxbin = tool()
  if (!foxbin) {
    void vscode.window.showErrorMessage(
      "FoxBin2Prg was not found. Put foxbin2prg.exe in the project folder, or run the VFP: Choose the FoxBin2Prg program command.",
    )
    return
  }
  const text = target.toLowerCase().endsWith(".sc2") ||
    target.toLowerCase().endsWith(".vc2") ||
    target.toLowerCase().endsWith(".fr2") ||
    target.toLowerCase().endsWith(".mn2") ||
    target.toLowerCase().endsWith(".lb2") ||
    target.toLowerCase().endsWith(".pj2")
    ? target
    : textPathOf(target)
  if (!text || !fs.existsSync(text)) {
    void vscode.window.showErrorMessage(`${path.basename(target)} has no text file.`)
    return
  }
  const result = toBinary(text, foxbin)
  if (result.ok) {
    output.appendLine(`built ${path.basename(binaryPathOf(text) ?? "")} from ${path.basename(text)}`)
    markPair(marker(), text, binaryPathOf(text) ?? text)
    void vscode.window.showInformationMessage(`${path.basename(text)} is built into the binary file.`)
  } else {
    output.appendLine(`could not build ${path.basename(text)}: ${result.error ?? ""}`)
    void vscode.window.showErrorMessage(`The build failed. The log says why.`)
    output.show(true)
  }
  refreshStatus()
}

/**
 * Makes the text file of one binary file again.
 *
 * This is what the tree and the menus of a file use.
 */
async function refreshOne(file?: vscode.Uri | VfpNode) {
  const target = fileOf(file)
  if (!target) {
    void vscode.window.showErrorMessage("There is no file to refresh.")
    return
  }
  if (isIgnored(target)) {
    refuseIgnored(target)
    return
  }
  const foxbin = tool()
  if (!foxbin) {
    void vscode.window.showErrorMessage("FoxBin2Prg was not found.")
    return
  }
  const binary = target.toLowerCase().endsWith(".sc2") ||
    target.toLowerCase().endsWith(".vc2") ||
    target.toLowerCase().endsWith(".fr2") ||
    target.toLowerCase().endsWith(".mn2") ||
    target.toLowerCase().endsWith(".lb2") ||
    target.toLowerCase().endsWith(".pj2")
    ? binaryPathOf(target) ?? target
    : target
  const result = toText(binary, foxbin)
  if (result.ok) {
    output.appendLine(`made ${path.basename(result.path ?? "")} from ${path.basename(binary)}`)
    if (result.path) markPair(marker(), result.path, binary)
    void vscode.window.showInformationMessage(`${path.basename(result.path ?? "")} is made again.`)
  } else {
    output.appendLine(`could not make the text of ${path.basename(binary)}: ${result.error ?? ""}`)
    void vscode.window.showErrorMessage("The text could not be made. The log says why.")
    output.show(true)
  }
  refreshStatus()
}

/** The text of a file, from the editor when it is open, so unsaved code is seen. */
function sourceText(file: string): string | undefined {
  const open = vscode.workspace.textDocuments.find(
    (document) => document.uri.fsPath.toLowerCase() === file.toLowerCase(),
  )
  if (open) return open.getText()
  try {
    return fs.readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

/** The file that a command was called with. */
function fileOf(file?: vscode.Uri | VfpNode): string | undefined {  if (!file) return vscode.window.activeTextEditor?.document.uri.fsPath
  if (file instanceof VfpNode) return file.entry?.binary
  return file.fsPath
}
/** Shows in the status bar what is out of step. */
function refreshStatus() {
  if (!status) return
  const all = entries()
  if (tree) {
    tree.entries = all
    tree.refresh()
  }
  if (!vscode.workspace.getConfiguration("vfp").get<boolean>("showStatus", true)) {
    status.hide()
    return
  }
  const state = survey()
  const project = workspace().project
  if (!project) {
    status.text = "$(file-binary) no VFP project"
    status.tooltip = "No Visual FoxPro project was found in this workspace."
    status.show()
    return
  }
  const parts: string[] = []
  if (state.toBuild.length) parts.push(`$(tools) ${state.toBuild.length} to build`)
  if (state.toRefresh.length) parts.push(`$(warning) ${state.toRefresh.length} to refresh`)
  if (!parts.length) parts.push("$(check) in step")
  status.text = `$(file-binary) ${parts.join("  ")}`
  status.tooltip = [
    `Project: ${project.file}`,
    `Waiting to be built: ${state.toBuild.length}`,
    `Behind: ${state.toRefresh.length}`,
    `Without a text file: ${state.missing.length}`,
    `On the exclude list: ${all.filter((entry) => entry.state === "ignored").length}`,
    "",
    "Click to see the list.",
  ].join("\n")
  status.show()
}
