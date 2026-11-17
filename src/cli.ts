#!/usr/bin/env node
import * as fs from "node:fs"
import * as path from "node:path"
import {
  KINDS,
  binaryPathOf,
  filesOfKind,
  findTool,
  textPathOf,
  toBinary,
  toText,
} from "./foxbin"
import { readIgnore } from "./ignore"
import { markAll, markerFile, readMarker, stateOf } from "./marker"
import { findVfp, runProgram, startProgram } from "./vfp"

/**
 * The same work the extension does, from a terminal.
 *
 * An agent can read and write the text files of a project, but it cannot click
 * a button in the editor. This command is how it turns a text file back into
 * the binary file, puts the project in step, and starts a build — the things
 * the VFP commands in the palette do.
 *
 *   vfp-tools status
 *   vfp-tools open  forms/frm_customer.scx
 *   vfp-tools build forms/frm_customer.SC2
 *   vfp-tools build-project
 *   vfp-tools run   main.prg
 */

/** The places Visual FoxPro is usually installed in. */
const HELP = `vfp-tools — the Visual FoxPro commands, from a terminal

  vfp-tools status [--json]     what is out of step
  vfp-tools open <file>         binary -> text (.scx -> .SC2)
  vfp-tools build <file>        text -> binary (.SC2 -> .scx)
  vfp-tools sync                build the binaries whose text changed
  vfp-tools refresh             make the text of the binaries that changed
  vfp-tools resolve             both directions, in the safe order
  vfp-tools build-project       put the project in step, then run the build
  vfp-tools run <file.prg>      run the program in a Visual FoxPro of its own

Options
  --project <file.pjx>       the project (default: the nearest .pjx)
  --root <folder>            the folder to work in (default: the project)
  --foxbin2prg <path>        FoxBin2Prg, when it is not in the project
  --vfp <path>               Visual FoxPro, when it is not in the usual place
  --build-program <path>     the program that builds the project
  --json                     print the status as JSON
  -h, --help                 this text

The text file is the master. Edit .SC2, .VC2, .FR2, .MN2, .LB2 and .PJ2, and
build the binary file from them; never edit the .scx, .vcx, .frx, .mnx, .lbx or
.pjx files by hand.
`

interface Options {
  command: string
  file?: string
  project?: string
  root?: string
  foxbin?: string
  vfp?: string
  buildProgram?: string
  json: boolean
}

interface Project {
  /** The folder of the project, or the folder the command was run in. */
  root: string
  /** The .pjx file, when one was found. */
  file?: string
  settings: Settings
}

type Settings = Record<string, unknown>

interface Pair {
  binary: string
  text: string
}

type EntryState = "step" | "build" | "refresh" | "notext" | "ignored"

interface Entry extends Pair {
  state: EntryState
}

/** Reads the command line. */
function parse(argv: string[]): Options {
  const options: Options = { command: "", json: false }
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case "--json":
        options.json = true
        break
      case "--project":
        options.project = valueOf(argv, ++i, arg)
        break
      case "--root":
        options.root = valueOf(argv, ++i, arg)
        break
      case "--foxbin2prg":
        options.foxbin = valueOf(argv, ++i, arg)
        break
      case "--vfp":
        options.vfp = valueOf(argv, ++i, arg)
        break
      case "--build-program":
        options.buildProgram = valueOf(argv, ++i, arg)
        break
      case "-h":
      case "--help":
        options.command = "help"
        break
      default:
        if (arg.startsWith("-")) throw new Error(`unknown option ${arg}`)
        rest.push(arg)
    }
  }
  if (!options.command) options.command = rest.shift() ?? "help"
  options.file = rest.shift()
  if (rest.length) throw new Error(`too many arguments: ${rest.join(" ")}`)
  return options
}

/** The value of an option that needs one. */
function valueOf(argv: string[], at: number, option: string): string {
  const value = argv[at]
  if (!value) throw new Error(`${option} needs a value`)
  return value
}

/** The settings of a folder, with the comments that the editor allows. */
function readSettings(folder: string): Settings {
  try {
    const text = fs.readFileSync(path.join(folder, ".vscode", "settings.json"), "utf8")
    return JSON.parse(withoutComments(text)) as Settings
  } catch {
    return {}
  }
}

/** Reads the settings of more than one folder, the later one winning. */
function mergedSettings(...folders: string[]): Settings {
  const all: Settings = {}
  for (const folder of folders) Object.assign(all, readSettings(folder))
  return all
}

/** Removes the comments and the trailing commas of a settings file. */
function withoutComments(text: string): string {
  let out = ""
  let inString = false
  let i = 0
  while (i < text.length) {
    const char = text[i]
    if (inString) {
      out += char
      if (char === "\\" && i + 1 < text.length) {
        i++
        out += text[i]
      } else if (char === '"') {
        inString = false
      }
      i++
      continue
    }
    if (char === '"') {
      inString = true
      out += char
      i++
      continue
    }
    if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++
      continue
    }
    if (char === "/" && text[i + 1] === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++
      i += 2
      continue
    }
    out += char
    i++
  }
  return withoutTrailingCommas(out)
}

/** Removes a comma that is followed by the end of an object or an array. */
function withoutTrailingCommas(text: string): string {
  let out = ""
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (inString) {
      out += char
      if (char === "\\" && i + 1 < text.length) {
        i++
        out += text[i]
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      out += char
      continue
    }
    if (char === ",") {
      let next = i + 1
      while (next < text.length && /\s/.test(text[next])) next++
      if (text[next] === "}" || text[next] === "]") continue
    }
    out += char
  }
  return out
}

/** A setting that is a string. */
function textSetting(settings: Settings, key: string): string | undefined {
  const value = settings[key]
  return typeof value === "string" && value ? value : undefined
}

/** The setting as a path, measured from the folder of the project. */
function pathSetting(settings: Settings, key: string, root: string): string | undefined {
  const value = textSetting(settings, key)
  if (!value) return undefined
  return path.isAbsolute(value) ? value : path.join(root, value)
}

/** Finds the project, and the settings that go with it. */
function locate(options: Options): Project {
  const base = options.root ? path.resolve(options.root) : process.cwd()
  const baseSettings = readSettings(base)

  let file: string | undefined
  const configured = pathSetting(baseSettings, "vfp.projectFile", base)
  if (configured && fs.existsSync(configured)) file = configured
  if (!file && options.project) {
    const candidate = path.resolve(options.project)
    if (!fs.existsSync(candidate)) throw new Error(`${options.project} is not there.`)
    file = candidate
  }
  if (!file) file = findProject(base)

  const root = file ? path.dirname(file) : base
  const settings = root === base ? baseSettings : mergedSettings(base, root)
  return { root, file, settings }
}

/** Looks for a .pjx file, here and in the folders above. */
function findProject(start: string): string | undefined {
  let folder = path.resolve(start)
  for (;;) {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true })
    } catch {
      return undefined
    }
    const project = entries.find(
      (entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".pjx"),
    )
    if (project) return path.join(folder, project.name)
    const above = path.dirname(folder)
    if (above === folder) return undefined
    folder = above
  }
}

/** Looks for the program that builds the project. */
function findBuildProgram(root: string): string | undefined {
  const names = ["build_it.prg", "build.prg", "build_project.prg", "buildproject.prg"]
  const folders = [path.join(root, "progs"), root, path.join(root, "build")]
  for (const folder of folders) {
    for (const name of names) {
      const candidate = path.join(folder, name)
      if (fs.existsSync(candidate)) return candidate
    }
  }
  // Then every program that holds a build command.
  for (const folder of folders) {
    for (const file of programFiles(folder)) {
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
function programFiles(folder: string): string[] {
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

/** Every pair of files in the project. */
function pairs(root: string): Pair[] {
  const found: Pair[] = []
  for (const kind of KINDS) {
    for (const binary of filesOfKind(root, kind)) {
      const text = textPathOf(binary)
      if (text) found.push({ binary, text })
    }
  }
  return found
}

/** The files of the project, with the state of each one. */
function entries(project: Project): Entry[] {
  const marked = readMarker(project.file ? markerFile(project.file) : "")
  const ignore = readIgnore(project.root)
  const found: Entry[] = []
  for (const pair of pairs(project.root)) {
    if (ignore.ignores(pair.binary)) {
      found.push({ ...pair, state: "ignored" })
      continue
    }
    const state = stateOf(pair.text, pair.binary, marked, newerThan(pair.text, pair.binary))
    found.push({ ...pair, state })
  }
  return found
}

/** Whether the first file was written after the second one. */
function newerThan(one: string, two: string): boolean {
  try {
    return fs.statSync(one).mtimeMs > fs.statSync(two).mtimeMs
  } catch {
    return false
  }
}

/** The FoxBin2Prg program. */
function foxbinTool(project: Project, options: Options): string {
  const configured = options.foxbin ?? pathSetting(project.settings, "vfp.foxbin2prg", project.root)
  const tool = findTool(project.root, configured)
  if (!tool) {
    throw new Error(
      "FoxBin2Prg was not found. Put foxbin2prg.exe in the project folder, or set vfp.foxbin2prg, or pass --foxbin2prg.",
    )
  }
  return tool
}

/** The Visual FoxPro program. */
function vfpTool(project: Project, options: Options): string {
  const configured = options.vfp ?? pathSetting(project.settings, "vfp.vfpExe", project.root)
  const vfp = findVfp(configured)
  if (!vfp) {
    throw new Error("Visual FoxPro was not found. Set vfp.vfpExe or pass --vfp.")
  }
  return vfp
}

/**
 * Turns files from one form into the other.
 *
 * The argument is always the binary file, whichever way the conversion goes,
 * because that is what the marker and the exclude list are kept by.
 */
function convert(
  files: string[],
  direction: "binary" | "text",
  project: Project,
  options: Options,
): number {
  const ignore = readIgnore(project.root)
  const leftAlone = files.filter((file) => ignore.ignores(file))
  const todo = files.filter((file) => !ignore.ignores(file))
  if (leftAlone.length) {
    console.error(`${leftAlone.length} file(s) are on the exclude list and were left alone.`)
  }
  if (!todo.length) {
    console.error("There is nothing to do: the rest is on the exclude list.")
    return 0
  }
  const tool = foxbinTool(project, options)
  const marked: Pair[] = []
  let failed = 0
  for (const binary of todo) {
    const text = textPathOf(binary)
    if (!text) {
      failed++
      console.error(`could not do ${path.basename(binary)}: it is not a Visual FoxPro binary file.`)
      continue
    }
    const result = direction === "binary" ? toBinary(text, tool) : toText(binary, tool)
    if (result.ok) {
      console.log(`${direction === "binary" ? "built" : "made"} ${path.basename(direction === "binary" ? text : binary)}`)
      marked.push({ text, binary })
    } else {
      failed++
      console.error(`could not do ${path.basename(binary)}: ${result.error ?? ""}`)
    }
  }
  if (marked.length && project.file) markAll(markerFile(project.file), marked)
  return failed
}

/** The file the command was given. */
function needed(options: Options): string {
  if (!options.file) {
    throw new Error("which file? pass one, for example: vfp-tools build forms/frm_customer.SC2")
  }
  return path.resolve(options.file)
}

/** Turns a binary file into its text file. */
function openFile(project: Project, options: Options): void {
  const target = needed(options)
  if (binaryPathOf(target)) {
    throw new Error(`${path.basename(target)} is already the text file.`)
  }
  if (!textPathOf(target)) {
    throw new Error(`${path.basename(target)} is not a Visual FoxPro binary file.`)
  }
  if (!fs.existsSync(target)) throw new Error(`${target} is not there.`)
  if (convert([target], "text", project, options)) throw new Error("the text file was not made.")
}

/** Turns a text file back into its binary file. */
function buildFile(project: Project, options: Options): void {
  const target = needed(options)
  const text = binaryPathOf(target) ? target : textPathOf(target)
  if (!text) throw new Error(`${path.basename(target)} is not a Visual FoxPro text file.`)
  if (!fs.existsSync(text)) {
    throw new Error(`there is no text file for ${path.basename(target)}.`)
  }
  const binary = binaryPathOf(text)
  if (!binary) throw new Error(`${path.basename(text)} is not a Visual FoxPro text file.`)
  if (convert([binary], "binary", project, options)) throw new Error("the binary file was not built.")
}

/** Says what is out of step. */
function status(project: Project, options: Options): void {
  const found = entries(project)
  const toBuild = found.filter((entry) => entry.state === "build").map((entry) => entry.binary)
  const toRefresh = found.filter((entry) => entry.state === "refresh").map((entry) => entry.binary)
  const missing = found.filter((entry) => entry.state === "notext").map((entry) => entry.binary)
  const ignored = found.filter((entry) => entry.state === "ignored").map((entry) => entry.binary)

  if (options.json) {
    console.log(
      JSON.stringify(
        { root: project.root, project: project.file ?? null, toBuild, toRefresh, missing, ignored },
        null,
        2,
      ),
    )
    return
  }
  console.log(`Project: ${project.file ?? "not found"}`)
  console.log(`Waiting to be built (the text is newer): ${toBuild.length}`)
  console.log(`Behind (the binary is newer): ${toRefresh.length}`)
  console.log(`Without a text file: ${missing.length}`)
  console.log(`On the exclude list: ${ignored.length}`)
  for (const file of toBuild) console.log(`  to build: ${file}`)
  for (const file of toRefresh) console.log(`  to refresh: ${file}`)
  for (const file of missing) console.log(`  no text: ${file}`)
}

/** Builds the binaries whose text was changed. */
function sync(project: Project, options: Options): void {
  const toBuild = entries(project)
    .filter((entry) => entry.state === "build")
    .map((entry) => entry.binary)
  if (!toBuild.length) {
    console.log("Every binary file is in step with its text file.")
    return
  }
  if (convert(toBuild, "binary", project, options)) throw new Error("some files could not be built.")
}

/** Makes the text of the binaries that were changed in the designer. */
function refresh(project: Project, options: Options): void {
  const behind = entries(project)
    .filter((entry) => entry.state === "refresh" || entry.state === "notext")
    .map((entry) => entry.binary)
  if (!behind.length) {
    console.log("Every text file is in step with its binary file.")
    return
  }
  if (convert(behind, "text", project, options)) throw new Error("some text files could not be made.")
}

/** Puts every file in step, whichever way it is out of step. */
function resolve(project: Project, options: Options): void {
  sync(project, options)
  refresh(project, options)
}

/** Puts the project in step and runs the program that builds it. */
function buildProject(project: Project, options: Options): void {
  const toBuild = entries(project)
    .filter((entry) => entry.state === "build")
    .map((entry) => entry.binary)
  if (toBuild.length) {
    console.log(`${toBuild.length} text file(s) are newer; building them first.`)
    if (convert(toBuild, "binary", project, options)) {
      throw new Error("the build stopped because a file could not be built.")
    }
  }

  const configured = options.buildProgram ?? pathSetting(project.settings, "vfp.buildProgram", project.root)
  let program = configured && fs.existsSync(configured) ? configured : undefined
  if (!program) program = findBuildProgram(project.root)
  if (!program) {
    throw new Error(
      "no build program was found. Set vfp.buildProgram, or pass --build-program.",
    )
  }

  console.log(`building with ${program}`)
  const result = runProgram(vfpTool(project, options), program, path.dirname(program))
  if (!result.ok) throw new Error(`the build failed: ${result.error ?? ""}`)
  console.log("the build is done.")
}

/** Runs a program in a Visual FoxPro of its own. */
function runFile(project: Project, options: Options): void {
  const target = needed(options)
  if (path.extname(target).toLowerCase() !== ".prg") {
    throw new Error(`${path.basename(target)} is not a program. Only a .prg file can be run.`)
  }
  if (!fs.existsSync(target)) throw new Error(`${target} is not there.`)
  const folder = project.file ? project.root : path.dirname(target)
  const result = startProgram(vfpTool(project, options), target, folder)
  if (!result.ok) throw new Error(`Visual FoxPro could not be started: ${result.error ?? ""}`)
  console.log(`running ${path.basename(target)} in ${folder}`)
}

async function main(): Promise<void> {
  const options = parse(process.argv.slice(2))
  if (options.command === "help") {
    console.log(HELP)
    return
  }
  const project = locate(options)
  switch (options.command) {
    case "status":
      status(project, options)
      break
    case "open":
      openFile(project, options)
      break
    case "build":
      buildFile(project, options)
      break
    case "sync":
      sync(project, options)
      break
    case "refresh":
      refresh(project, options)
      break
    case "resolve":
      resolve(project, options)
      break
    case "build-project":
      buildProject(project, options)
      break
    case "run":
      runFile(project, options)
      break
    default:
      throw new Error(`unknown command ${options.command}. Run vfp-tools --help.`)
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`vfp-tools: ${message}`)
  process.exitCode = 1
})
