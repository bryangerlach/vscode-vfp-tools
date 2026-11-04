import * as fs from "node:fs"
import * as path from "node:path"
import { Procedure, Sc2Class, ancestryOf, methodsOf, parseSc2 } from "./form"

/**
 * Going to the code of a name.
 *
 * Visual FoxPro code says a lot with a name and no path:
 *
 *   DO myreport            runs myreport.prg
 *   DO addtotal IN tools   runs a procedure of tools.prg
 *   SET PROCEDURE TO tools another program holds the procedures
 *   DO FORM frm_customer   runs a form
 *   THISFORM.Refresh        calls a method of the form
 *   THISFORM.cmdOK.Click    calls an event of a control
 *
 * The editor can put the caret on any of those names and go to where the code
 * is, which is what "Go to Definition" does. Nothing here is Visual FoxPro: the
 * text files are read as text, and a name that cannot be found is simply not
 * answered, without a message, because a name can be in a DLL, an APP or a
 * program that is not in the project.
 *
 * The text file is the master of a form, so a form is opened as its .sc2 text
 * and never as the .scx binary.
 */

/** Where a name is defined: a file, and a line counted from 1. */
export interface Target {
  file: string
  line: number
}

/** The file that is open, and where the caret is. */
export interface Request {
  /** The file that is open. */
  file: string
  /** Its text, which can be newer than the file on the disk. */
  text: string
  /** The line of the caret, counted from 1. */
  line: number
  /** The column of the caret, counted from 1. */
  column: number
  /** The folder of the project, where the other files are looked for. */
  root: string
}

/** A way to read a file that is open, so what is being edited is what is read. */
export type Reader = (file: string) => string | undefined

/** One word, or one quoted name, of a line of code. */
interface Token {
  /** The word without its quotes. */
  text: string
  /** Where it starts in the line, from 0. */
  start: number
  /** Where it ends in the line, which is one past the last character. */
  end: number
  /** Whether it was written as a string, as in DO "myreport". */
  quoted: boolean
}

/** What was found in the folders of the project. */
interface Index {
  root: string
  /** The name of a program, in lower case, and the files that have it. */
  programs: Map<string, string[]>
  /** The name of a procedure, in lower case, and where it is. */
  procedures: Map<string, Target[]>
  /** The name of a form, in lower case, and the text file of it. */
  forms: Map<string, string>
}

/** The folders that never hold a Visual FoxPro program, or hold far too many. */
const SKIP = new Set([".git", ".hg", ".svn", "node_modules", ".vscode", ".vscode-oss", "obj", "bin"])

/** How long what was found is kept, in milliseconds. */
const KEEP_MS = 2000

let cached: { at: number; index: Index } | undefined

/** Forgets the files of the project, so the next question reads the folders again. */
export function forgetIndex(): void {
  cached = undefined
}

/**
 * Everything that can be gone to from where the caret is.
 *
 * The answer is one line, or nothing. A name that is written twice is answered
 * by the one that Visual FoxPro would run, which is the nearest one.
 */
export function definitionsAt(request: Request, read?: Reader): Target[] {
  const lines = request.text.split(/\r?\n/)
  const line = lines[request.line - 1] ?? ""
  const column = Math.max(1, Math.min(request.column, line.length + 1))
  const tokens = tokensOf(line)
  const token = tokenAt(tokens, column)
  if (!token) return []

  // THISFORM.Foo and THIS.Foo first, because a line of code can hold a word
  // that looks like a command of Visual FoxPro but is not one.
  const chain = chainOf(tokens, token, column)
  if (chain) {
    const classes = parseSc2(request.text)
    const cls = classAt(classes, request.line)
    if (!cls) return []
    // THIS is the object whose method the caret is in; THISFORM is the form.
    const start = chain.base === "this" ? currentPath(cls, request.line) : []
    const object = [...start, ...chain.rest.slice(0, -1)].join(".")
    const event = chain.rest[chain.rest.length - 1]
    if (!event) return []
    return methodTargets(request, cls, object, event)
  }

  const clause = clauseOf(tokens, token)
  if (!clause) return []

  const index = indexOf(request.root)
  if (clause.kind === "form") {
    const file = resolveForm(clause.name, request.file, request.root, index)
    return file ? [{ file, line: 1 }] : []
  }
  if (clause.kind === "procedure") {
    const file = resolveProgram(clause.name, request.file, request.root, index)
    return file ? [{ file, line: 1 }] : []
  }
  return programTargets(clause.name, clause.inFile, request, index, read)
}

/** What the caret is on: a program, a form, or the file of a SET PROCEDURE. */
interface Clause {
  kind: "program" | "form" | "procedure"
  name: string
  /** The file of a DO name IN file. */
  inFile?: string
}

/** The word at the caret, when there is one. */
function tokenAt(tokens: Token[], column: number): Token | undefined {
  const at = column - 1
  return tokens.find((one) => one.start <= at && at <= one.end)
}

/**
 * The words of a line, and the strings, with comments left out.
 *
 * A dot is a part of a word, so "thisform.cmdOK.Click" is one word, and so is
 * "tools.prg". That is what makes it possible to know which part of a name the
 * caret is on without looking at the characters again.
 */
function tokensOf(line: string): Token[] {
  const stop = commentAt(line)
  const tokens: Token[] = []
  let i = 0
  while (i < stop) {
    const char = line[i]
    if (/\s/.test(char)) {
      i++
      continue
    }
    if (char === '"' || char === "'") {
      const start = i
      const quote = char
      i++
      let text = ""
      while (i < stop) {
        const one = line[i]
        if (one === quote) {
          // A quote inside a string is written twice.
          if (line[i + 1] === quote) {
            text += quote
            i += 2
            continue
          }
          i++
          break
        }
        text += one
        i++
      }
      tokens.push({ text, start, end: i, quoted: true })
      continue
    }
    if (/[A-Za-z_$]/.test(char)) {
      const start = i
      while (i < stop && /[A-Za-z0-9_$.]/.test(line[i])) i++
      // A dot that is not followed by a name, as in "COUNT(*).", is not part of
      // the word.
      while (i > start && line[i - 1] === ".") i--
      tokens.push({ text: line.slice(start, i), start, end: i, quoted: false })
      continue
    }
    if (/[0-9]/.test(char)) {
      const start = i
      while (i < stop && /[0-9.]/.test(line[i])) i++
      tokens.push({ text: line.slice(start, i), start, end: i, quoted: false })
      continue
    }
    i++
  }
  return tokens
}

/** Where a comment starts on a line, or the length of the line. */
function commentAt(line: string): number {
  // A whole line is a comment when it starts with an asterisk.
  if (/^\s*\*/.test(line)) return line.indexOf("*")
  let quote: string | undefined
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (quote) {
      if (char === quote) {
        if (line[i + 1] === quote) i++
        else quote = undefined
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === "&" && line[i + 1] === "&") return i
  }
  return line.length
}

/**
 * The THISFORM or THIS name at the caret.
 *
 * THISFORM is the form, so what comes after it starts at the form. THIS is the
 * object whose method the caret is in, which is the form in a form method and a
 * control in a control method.
 */
function chainOf(
  tokens: Token[],
  token: Token,
  column: number,
): { base: "this" | "thisform"; rest: string[] } | undefined {
  const at = tokens.indexOf(token)
  if (at < 0 || token.quoted) return undefined
  const parts = token.text.split(".")
  const first = parts[0].toLowerCase()
  if (first !== "this" && first !== "thisform") return undefined
  if (parts.length < 2) return undefined
  // On THISFORM itself there is nothing to go to; a method is a later part.
  if (segmentAt(token, column) < 1) return undefined
  return { base: first, rest: parts.slice(1) }
}

/** Which part of a dotted word the caret is on, counted from 0. */
function segmentAt(token: Token, column: number): number {
  const offset = Math.max(0, Math.min(column - 1 - token.start, token.text.length))
  let segment = 0
  for (let i = 0; i < offset; i++) if (token.text[i] === ".") segment++
  return segment
}

/** The class whose DEFINE CLASS block holds a line. */
function classAt(classes: Sc2Class[], line: number): Sc2Class | undefined {
  let found: Sc2Class | undefined
  for (const cls of classes) {
    if (cls.line > line || line > cls.end) continue
    if (!found || cls.line > found.line) found = cls
  }
  return found
}

/** The path of the object whose method holds a line, or [] for the class. */
function currentPath(cls: Sc2Class, line: number): string[] {
  let found: Procedure | undefined
  for (const procedure of cls.procedures) {
    if (procedure.line > line) break
    if (procedure.end && line > procedure.end) continue
    found = procedure
  }
  return found?.path ?? []
}

/**
 * The code of a method of an object of a form.
 *
 * The method can be written in the form itself or anywhere along the class
 * library chain that the form, or the control, is made from. The nearest one is
 * what Visual FoxPro runs, so that is the one that is answered.
 */
function methodTargets(request: Request, cls: Sc2Class, object: string, event: string): Target[] {
  const wanted = event.toLowerCase()
  const wantedPath = object.toLowerCase()

  // What was written on the form itself, and in the classes it is made from.
  for (const one of ancestryOf(request.file, cls.name, request.text)) {
    for (const procedure of one.cls.procedures) {
      if (procedure.path.join(".").toLowerCase() !== wantedPath) continue
      if (procedure.event.toLowerCase() !== wanted) continue
      return [{ file: one.file, line: procedure.line }]
    }
  }

  // An instance of a class of the project also has the code of that class, and
  // the code is written there without the path of the control.
  if (wantedPath) {
    const lookup = methodsOf(request.file, request.text, cls.name, object)
    for (const one of lookup.methods) {
      if (one.procedure.event.toLowerCase() !== wanted) continue
      return [{ file: one.file, line: one.procedure.line }]
    }
  }

  return []
}

/**
 * The DO, DO FORM or SET PROCEDURE TO clause that the caret is in.
 *
 * Only the name of the clause counts: a word after WITH is an argument, not a
 * name that can be gone to.
 */
function clauseOf(tokens: Token[], token: Token): Clause | undefined {
  const at = tokens.indexOf(token)
  if (at < 0) return undefined
  const lower = tokens.map((one) => one.text.toLowerCase())

  // SET PROCEDURE TO a, b ADDITIVE
  for (let i = 1; i < lower.length - 1; i++) {
    if (lower[i] !== "procedure" || lower[i - 1] !== "set" || lower[i + 1] !== "to") continue
    if (at <= i + 1 || lower[at] === "additive") continue
    return { kind: "procedure", name: token.text }
  }

  // DO name [IN file], or DO FORM name.
  for (let i = at - 1; i >= 0; i--) {
    if (lower[i] !== "do") continue
    let nameAt = i + 1
    let form = false
    if (lower[nameAt] === "form") {
      form = true
      nameAt++
    }
    const name = lower[nameAt]
    if (!name || (!form && isDoKeyword(name))) return undefined
    if (at === nameAt) return form ? { kind: "form", name: token.text } : { kind: "program", name: token.text }
    if (!form && at === nameAt + 2 && lower[nameAt + 1] === "in") {
      return { kind: "program", name: tokens[nameAt].text, inFile: token.text }
    }
    return undefined
  }
  return undefined
}

/** The words that can follow DO and are not a program. */
function isDoKeyword(word: string): boolean {
  return word === "while" || word === "case" || word === "events" || word === "form"
}

/** Where a DO name is. */
function programTargets(name: string, inFile: string | undefined, request: Request, index: Index, read?: Reader): Target[] {
  if (inFile) {
    const file = resolveProgram(inFile, request.file, request.root, index)
    if (!file) return []
    const line = procedureLineIn(file, name, read) ?? 1
    return [{ file, line }]
  }

  // A program with that name is what Visual FoxPro runs first.
  const program = resolveProgram(name, request.file, request.root, index)
  if (program) return [{ file: program, line: 1 }]

  // A procedure in the program that is open, which is where it is written when
  // the file is a procedure file.
  const here = procedureLine(request.text, name)
  if (here) return [{ file: request.file, line: here }]

  // A procedure in one of the files of SET PROCEDURE TO.
  for (const file of setProcedureFiles(request, index)) {
    const line = procedureLineIn(file, name, read)
    if (line) return [{ file, line }]
  }

  // A procedure with that name anywhere in the project.
  const found = index.procedures.get(name.toLowerCase())?.[0]
  return found ? [{ file: found.file, line: found.line }] : []
}

/** The files of the SET PROCEDURE TO lines of the program that is open. */
function setProcedureFiles(request: Request, index: Index): string[] {
  const files: string[] = []
  for (const line of request.text.split(/\r?\n/)) {
    const found = /^\s*SET\s+PROCEDURE\s+TO\s+(.*)$/i.exec(line)
    if (!found) continue
    for (const one of found[1].replace(/\bADDITIVE\b/gi, "").split(",")) {
      const name = cleanName(one)
      if (!name) continue
      const file = resolveProgram(name, request.file, request.root, index)
      if (file && !files.some((other) => samePath(other, file))) files.push(file)
    }
  }
  return files
}

/** The line of a PROCEDURE or FUNCTION in a file, when the file can be read. */
function procedureLineIn(file: string, name: string, read?: Reader): number | undefined {
  const text = read?.(file) ?? readFile(file)
  return text === undefined ? undefined : procedureLine(text, name)
}

/** The line of a PROCEDURE or FUNCTION in a text, or nothing. */
function procedureLine(text: string, name: string): number | undefined {
  const wanted = name.toLowerCase()
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const found = /^\s*(?:PROCEDURE|FUNCTION)\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(lines[i])
    if (found && found[1].toLowerCase() === wanted) return i + 1
  }
  return undefined
}

/** A file that can be read, or nothing. */
function readFile(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

/** A name with the quotes and the last semicolon of a continued line taken off. */
function cleanName(text: string): string {
  return text
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/;$/, "")
    .trim()
}

/**
 * The program that a name points at.
 *
 * A name without an extension is a .prg, which is what DO looks for. A name
 * with a folder in it is taken from the folder of the file that is open, and
 * then from the folder of the project. When the name is not written with a
 * folder, every program of the project is looked at.
 */
function resolveProgram(name: string, from: string, root: string, index: Index): string | undefined {
  const cleaned = cleanName(name)
  if (!cleaned) return undefined
  const ext = path.extname(cleaned).toLowerCase()
  if (ext && ext !== ".prg" && ext !== ".mpr") return undefined
  const base = ext ? cleaned.slice(0, -ext.length) : cleaned

  const candidates: string[] = []
  const add = (one: string) => {
    if (!candidates.includes(one)) candidates.push(one)
  }
  if (path.isAbsolute(base)) {
    if (ext) add(cleaned)
    else {
      add(base + ".prg")
      add(base + ".mpr")
    }
  } else {
    const folder = path.dirname(from)
    if (ext) {
      add(path.join(folder, cleaned))
      add(path.join(root, cleaned))
    } else {
      for (const one of [".prg", ".mpr"]) {
        add(path.join(folder, base + one))
        add(path.join(root, base + one))
      }
    }
  }
  for (const one of candidates) if (isFile(one)) return one

  const named = index.programs.get(path.basename(base).toLowerCase())
  if (!named?.length) return undefined
  return (
    named.find((one) => sameFolder(one, path.dirname(from))) ??
    named.find((one) => sameFolder(one, root)) ??
    named[0]
  )
}

/**
 * The text file of the form that a DO FORM points at.
 *
 * The text is the master, so the .sc2 is answered and never the .scx. A form
 * that has no text file yet is not answered, because opening the binary file in
 * a text editor would only show a file that cannot be read.
 */
function resolveForm(name: string, from: string, root: string, index: Index): string | undefined {
  const cleaned = cleanName(name)
  if (!cleaned) return undefined
  const ext = path.extname(cleaned).toLowerCase()
  if (ext && ext !== ".scx" && ext !== ".sc2") return undefined
  const base = ext ? cleaned.slice(0, -ext.length) : cleaned

  const candidates: string[] = []
  const add = (one: string) => {
    if (!candidates.includes(one)) candidates.push(one)
  }
  if (path.isAbsolute(base)) {
    add(base + ".sc2")
    add(base + ".SC2")
  } else {
    const folder = path.dirname(from)
    add(path.join(folder, base + ".sc2"))
    add(path.join(folder, base + ".SC2"))
    add(path.join(root, base + ".sc2"))
    add(path.join(root, base + ".SC2"))
  }
  for (const one of candidates) if (isFile(one)) return one

  return index.forms.get(path.basename(base).toLowerCase())
}

/** Whether a path is a file. */
function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/** Whether two paths point at the same file. */
function samePath(one: string, two: string): boolean {
  return path.resolve(one).toLowerCase() === path.resolve(two).toLowerCase()
}

/** Whether a file is in a folder. */
function sameFolder(file: string, folder: string): boolean {
  return path.resolve(path.dirname(file)).toLowerCase() === path.resolve(folder).toLowerCase()
}

/** What is in the folders of the project, which is read once and then kept. */
function indexOf(root: string): Index {
  const now = Date.now()
  if (cached && cached.index.root === root && now - cached.at < KEEP_MS) return cached.index
  const index: Index = { root, programs: new Map(), procedures: new Map(), forms: new Map() }
  walk(root, 0, index)
  cached = { at: now, index }
  return index
}

/** Reads one folder, and the folders in it. */
function walk(folder: string, depth: number, index: Index): void {
  if (depth > 8) return
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    // A link can point back at a folder that was already read.
    if (entry.isSymbolicLink()) continue
    const full = path.join(folder, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name.toLowerCase())) walk(full, depth + 1, index)
      continue
    }
    if (!entry.isFile()) continue

    const ext = path.extname(entry.name).toLowerCase()
    const base = entry.name.slice(0, entry.name.length - ext.length).toLowerCase()
    if (ext === ".prg" || ext === ".mpr") {
      const files = index.programs.get(base) ?? []
      files.push(full)
      index.programs.set(base, files)
      scanProcedures(full, index)
    } else if (ext === ".sc2" && !index.forms.has(base)) {
      index.forms.set(base, full)
    }
  }
}

/** Notes the PROCEDURE and FUNCTION lines of a program. */
function scanProcedures(file: string, index: Index): void {
  const text = readFile(file)
  if (text === undefined) return
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const found = /^\s*(?:PROCEDURE|FUNCTION)\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(lines[i])
    if (!found) continue
    const name = found[1].toLowerCase()
    const list = index.procedures.get(name) ?? []
    list.push({ file, line: i + 1 })
    index.procedures.set(name, list)
  }
}
