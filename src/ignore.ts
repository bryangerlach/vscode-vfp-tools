import * as fs from "node:fs"
import * as path from "node:path"
import { stampOf } from "./foxbin"

/**
 * The files that are never converted with FoxBin2Prg.
 *
 * Some files are never edited by hand, so there is no reason to turn them into
 * text at all, and no reason for them to be counted as being out of step. A
 * file that is listed in `.vfpignore` is left alone: it is not turned into
 * text, its text file is not turned back into it, and the panel says so.
 *
 * The list is one pattern a line, in a file called `.vfpignore` in the project
 * folder, next to the `.pjx`. All three of the things that convert files read
 * it: the extension, the OpenCode plugin and the Visual FoxPro bridge.
 *
 *     # a comment
 *     forms/frm_old.scx          one file, in the forms folder
 *     frm_never_touched.frx      any file with this name, in any folder
 *     reports/legacy/            everything in that folder
 *     *.vcx                      every class library
 *     forms/frm_keep.*           this one is left alone...
 *     !forms/frm_keep.scx        ...but this one is used
 *
 * The rules are the ones `.gitignore` uses:
 *
 *   * A pattern with no `/` in it matches the name of the file, wherever it
 *     is. A pattern with a `/` in it is measured from the folder of the
 *     project.
 *   * `*` stands for any run of characters that does not cross a folder.
 *   * `**` stands for any run of characters, folders and all. A pair of stars
 *     with a slash straight after it may stand for no folder at all, so a
 *     pattern of the forms folder, two stars, a slash and `x.scx` also
 *     matches `forms/x.scx`.
 *   * `?` stands for one character that is not a folder.
 *   * A pattern that ends with `/` is a folder, and everything in it.
 *   * A pattern that starts with `!` takes a file off the list again. The last
 *     pattern that matches is the one that counts.
 *   * The case of the letters does not matter, because Windows does not care.
 *
 * A form and its code and its text are one thing, so a pattern that names one
 * of them names all of them: `frm_old.scx`, `frm_old.sct` and `frm_old.SC2`
 * are the same file as far as the list is concerned.
 */

/** The name of the list, in the project folder. */
export const IGNORE_NAME = ".vfpignore"

/**
 * The text and memo files that are the same file as a binary file.
 *
 * A pattern about any one of them is a pattern about the binary file, because
 * the pair is never split up: the binary file and its memo are one thing, and
 * the text file is its readable form.
 */
const SAME_AS: Record<string, string> = {
  sc2: "scx",
  sct: "scx",
  vc2: "vcx",
  vct: "vcx",
  fr2: "frx",
  frt: "frx",
  mn2: "mnx",
  mnt: "mnx",
  lb2: "lbx",
  lbt: "lbx",
  pj2: "pjx",
  pjt: "pjx",
}

/** The list of files that are left alone. */
export interface Ignore {
  /** The file the list was read from. */
  file: string
  /** Whether the list is there at all. */
  present: boolean
  /** How many patterns there are. */
  count: number
  /** The patterns as they were written, for the report. */
  patterns: string[]
  /** Whether a file is left alone. */
  ignores(file: string): boolean
}

/** One line of the list. */
interface Pattern {
  /** The line as it was written. */
  source: string
  /** Whether the line takes a file off the list again. */
  negated: boolean
  /** Whether the pattern is about the file as it is named. */
  match(relative: string, name: string): boolean
}

/** The name of a file, in the form the list talks about. */
function sameBinary(name: string): string {
  const dot = name.lastIndexOf(".")
  if (dot < 0) return name
  const ext = name.slice(dot + 1).toLowerCase()
  const binary = SAME_AS[ext]
  return binary ? `${name.slice(0, dot)}.${binary}` : name
}

/** Turns a pattern into a regular expression. The rules are the `.gitignore` ones. */
function toRegex(glob: string): RegExp {
  let out = "^"
  for (let at = 0; at < glob.length; at++) {
    const letter = glob[at]
    if (letter === "*") {
      if (glob[at + 1] === "*") {
        if (glob[at + 2] === "/") {
          // "**/" may stand for no folder at all.
          out += "(?:.*/)?"
          at += 2
        } else {
          out += ".*"
          at += 1
        }
      } else {
        out += "[^/]*"
      }
    } else if (letter === "?") {
      out += "[^/]"
    } else {
      out += letter.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    }
  }
  return new RegExp(`${out}$`, "i")
}

/** One line of the list, ready to be asked about a file. */
function compile(line: string): Pattern | undefined {
  const source = line.trim()
  if (!source || source.startsWith("#")) return undefined

  let wanted = source
  let negated = false
  if (wanted.startsWith("!")) {
    negated = true
    wanted = wanted.slice(1).trim()
    if (!wanted) return undefined
  }

  // The list may have been written on Windows, where a path is written with
  // backslashes, and in the list a folder is always a slash.
  wanted = wanted.replace(/\\/g, "/")

  // A leading slash means the same as a slash somewhere in the middle: the
  // pattern is measured from the folder of the project.
  if (wanted.startsWith("/")) wanted = wanted.slice(1)

  let folder = false
  if (wanted.endsWith("/")) {
    folder = true
    wanted = wanted.replace(/\/+$/, "")
  }
  if (!wanted) return undefined

  // A pattern about the text file is a pattern about the binary file.
  wanted = sameBinary(wanted)

  // A pattern with no slash is about the name, wherever the file is. A pattern
  // with a slash is measured from the folder of the project, and so is a
  // folder pattern, because where the folder is matters as well.
  const hasSlash = wanted.includes("/")
  const rooted = hasSlash || folder
  const glob = folder ? `${hasSlash ? wanted : `**/${wanted}`}/**` : wanted

  if (!/[*?]/.test(glob)) {
    const fixed = glob.toLowerCase()
    return {
      source,
      negated,
      match: (relative, name) => (rooted ? relative : name) === fixed,
    }
  }

  const regex = toRegex(glob)
  return {
    source,
    negated,
    match: (relative, name) => regex.test(rooted ? relative : name),
  }
}

class IgnoreFile implements Ignore {
  readonly patterns: string[] = []
  private readonly rules: Pattern[] = []

  constructor(
    readonly root: string,
    readonly file: string,
    readonly present: boolean,
  ) {
    let text = ""
    if (present) {
      try {
        text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")
      } catch {
        text = ""
      }
    }
    for (const line of text.split(/\r?\n/)) {
      const rule = compile(line)
      if (rule) {
        this.rules.push(rule)
        this.patterns.push(rule.source)
      }
    }
  }

  get count(): number {
    return this.rules.length
  }

  ignores(file: string): boolean {
    let relative = path.relative(this.root, file).replace(/\\/g, "/")
    if (!relative || relative.startsWith("..")) return false
    relative = sameBinary(relative).toLowerCase()
    const name = relative.slice(relative.lastIndexOf("/") + 1)
    let leftAlone = false
    // The last pattern that matches is the one that counts, the way the list
    // is read from the top.
    for (const rule of this.rules) {
      if (rule.match(relative, name)) leftAlone = !rule.negated
    }
    return leftAlone
  }
}

/** The list of the project, which is read again when it changes. */
let kept: { file: string; stamp: string; ignore: Ignore } | undefined

/** Reads the list of the project. */
export function readIgnore(root: string): Ignore {
  const file = path.join(root, IGNORE_NAME)
  const stamp = stampOf(file)
  if (kept && kept.file === file && kept.stamp === stamp) return kept.ignore
  const ignore = new IgnoreFile(root, file, fs.existsSync(file))
  kept = { file, stamp, ignore }
  return ignore
}

/** The list of the project, whether it is there or not. */
export function ignoreFile(root: string): string {
  return path.join(root, IGNORE_NAME)
}

/**
 * The list a project starts with.
 *
 * The rules are written down in it, because a file that says what it is for is
 * worth more than a line in a manual that is somewhere else.
 */
export function starterIgnore(): string {
  return [
    "# .vfpignore",
    "#",
    "# The files that are never turned into text with FoxBin2Prg, and never",
    "# built back from it. One pattern a line. Everything in the project is",
    "# used when this file is empty.",
    "#",
    "#   forms/frm_old.scx     one file, in the forms folder",
    "#   frm_never.frx         any file with this name, in any folder",
    "#   reports/legacy/       everything in that folder",
    "#   *.vcx                 every class library",
    "#",
    "# A form, its code and its text are one thing: naming the .scx also names",
    "# the .sct and the .SC2.",
    "#",
    "# A pattern that starts with ! takes a file off the list again, and the",
    "# last pattern that matches is the one that counts.",
    "",
  ].join("\r\n")
}
