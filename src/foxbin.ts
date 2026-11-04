import * as fs from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import * as os from "node:os"
import { removeScratch, sweepScratchRoot } from "./scratch"

/**
 * FoxBin2Prg, used to turn a binary Visual FoxPro file into readable text and
 * back again.
 *
 * A .scx, .vcx, .frx, .mnx, .lbx and .pjx file cannot be read by a text
 * tool. Every one of them is paired with a memo file that holds the code:
 *
 *    frm_customer.scx  +  frm_customer.sct
 *    mylib.vcx         +  mylib.vct
 *
 * The direction comes from the extension in the file specification: a .vcx
 * becomes a .vc2 and a .vc2 becomes a .vcx.
 */

/** The text file of every binary kind. */
const TEXT_EXTENSION: Record<string, string> = {
  scx: "SC2",
  vcx: "VC2",
  frx: "FR2",
  mnx: "MN2",
  lbx: "LB2",
  pjx: "PJ2",
}

/** The memo file that holds the code of every binary kind. */
const MEMO_EXTENSION: Record<string, string> = {
  scx: "sct",
  vcx: "vct",
  frx: "frt",
  mnx: "mnt",
  lbx: "lbt",
  pjx: "pjt",
}

/** The kinds that are converted, in the order they are reported. */
export const KINDS = ["scx", "vcx", "frx", "mnx", "lbx", "pjx"] as const

export interface Conversion {
  ok: boolean
  /** The file that was made. */
  path?: string
  /** What went wrong, when something did. */
  error?: string
  /** The last lines the tool wrote to its log. */
  log?: string
}

/** The text extension of a binary file, or nothing when it has none. */
export function textExtension(file: string): string | undefined {
  return TEXT_EXTENSION[extname(file).replace(".", "").toLowerCase()]
}

/** The binary extension of a text file, or nothing when it has none. */
export function binaryExtension(file: string): string | undefined {
  const ext = extname(file).replace(".", "").toLowerCase()
  for (const [binary, text] of Object.entries(TEXT_EXTENSION)) {
    if (text.toLowerCase() === ext) return binary
  }
  return undefined
}

/** The text file that belongs to a binary file. */
export function textPathOf(binary: string): string | undefined {
  const text = textExtension(binary)
  if (!text) return undefined
  return join(dirname(binary), `${basename(binary, extname(binary))}.${text}`)
}

/** The binary file that belongs to a text file. */
export function binaryPathOf(text: string): string | undefined {
  const binary = binaryExtension(text)
  if (!binary) return undefined
  return join(dirname(text), `${basename(text, extname(text))}.${binary}`)
}

/** The memo file that holds the code of a binary file. */
export function memoPathOf(binary: string): string | undefined {
  const ext = extname(binary).replace(".", "").toLowerCase()
  const memo = MEMO_EXTENSION[ext]
  if (!memo) return undefined
  return join(dirname(binary), `${basename(binary, extname(binary))}.${memo}`)
}

function extname(file: string): string {
  const base = basename(file)
  const dot = base.lastIndexOf(".")
  return dot <= 0 ? "" : base.slice(dot)
}

function basename(file: string, ext?: string): string {
  const base = path.basename(file)
  if (ext && base.toLowerCase().endsWith(ext.toLowerCase())) {
    return base.slice(0, base.length - ext.length)
  }
  return base
}

function dirname(file: string): string {
  return path.dirname(file)
}

function join(...parts: string[]): string {
  return path.join(...parts)
}

/**
 * Looks for FoxBin2Prg. It is often shipped inside the project itself.
 */
export function findTool(root: string | undefined, configured?: string): string | undefined {
  if (configured && fs.existsSync(configured)) return path.resolve(configured)
  const fromEnv = process.env.FOXBIN2PRG
  if (fromEnv && fs.existsSync(fromEnv)) return path.resolve(fromEnv)
  if (root) {
    for (const name of ["foxbin2prg.exe", "FoxBin2Prg.exe", "FOXBIN2PRG.EXE"]) {
      const candidate = path.join(root, name)
      if (fs.existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * The memo file that belongs to one of the files.
 *
 * The memo holds the code of a binary file. The binary file is a .scx, .vcx,
 * .frx, .mnx, .lbx or a .pjx, and the memo is the .sct, .vct, .frt, .mnt,
 * .lbt or the .pjt beside it. The text file is a .SC2, .VC2 and so on, and
 * it has no memo of its own.
 *
 * Both files are looked at, because one of them is the binary file and the
 * other is the text file, and the memo belongs to the binary file.
 */
function memoOf(...files: string[]): string | undefined {
  for (const file of files) {
    const memo = memoPathOf(file)
    if (memo && fs.existsSync(memo)) return memo
  }
  return undefined
}

/**
 * The file in a folder with that name, whatever the case of it is.
 *
 * The tool names the files it makes with the extension in capitals, and the
 * name of the file on disk can be in any case.
 */
function findIn(folder: string, name: string): string | undefined {
  let entries: string[]
  try {
    entries = fs.readdirSync(folder)
  } catch {
    return undefined
  }
  for (const entry of entries) {
    if (entry.toLowerCase() === name.toLowerCase()) return path.join(folder, entry)
  }
  return undefined
}

/**
 * Runs FoxBin2Prg on one file.
 *
 * The file is copied to a scratch folder first, and the result is copied
 * back. The tool writes a log file and a backup file next to the file it
 * works on, and it can also rewrite the file it reads, because it recompiles
 * the form to get at the code. None of that belongs in the project of the
 * user, so the tool never sees the real folder.
 *
 * The scratch folder is thrown away when the tool is done, and the file that
 * comes back is only put in place when the tool really made it.
 */
export function runTool(
  tool: string,
  source: string,
  wanted: string,
  direction: "binary" | "text",
): Conversion {
  const scratch = path.join(os.tmpdir(), "vfp-tools", `${Date.now()}-${Math.random().toString(36).slice(2)}`)
  void sweepScratchRoot(path.dirname(scratch))
  fs.mkdirSync(scratch, { recursive: true })
  try {
    const sourceName = basename(source)
    const wantedName = basename(wanted)
    fs.copyFileSync(source, path.join(scratch, sourceName))
    // The file that is made is put there as well. The tool takes the name of
    // the file it replaces, and it keeps a copy of it.
    if (fs.existsSync(wanted)) {
      fs.copyFileSync(wanted, path.join(scratch, wantedName))
    }
    // The memo file holds the code of the form. It belongs to the binary
    // file, so it is the memo of the binary file that is wanted, and not the
    // memo of the text file, which has none.
    const memo = memoOf(source, wanted)
    if (memo) {
      fs.copyFileSync(memo, path.join(scratch, basename(memo)))
    }

    // The file the tool made.
    const madePath = path.join(scratch, wantedName)

    spawnSync(tool, [path.join(scratch, sourceName), "0", "0", "0", "1", "1"], {
      cwd: scratch,
      windowsHide: true,
      encoding: "utf8",
    })

    const log = readLog(scratch)
    const problem = readError(scratch)
    if (!fs.existsSync(madePath)) {
      return {
        ok: false,
        error: `FoxBin2Prg did not make ${wantedName}.${log ? ` It said: ${lastLines(log)}` : ""}`,
        log,
      }
    }
    // The tool does not write the file when it is the same as the one that is
    // already there. That is not a failure, it means that nothing changed.
    // The tool recompiles the form to get at its code. When that fails, the
    // file it made has no code in it, and the file and its memo do not belong
    // to each other. The file is not put in place then.
    if (problem) {
      return {
        ok: false,
        error: `FoxBin2Prg could not read the code of ${wantedName}: ${problem}`,
        log,
      }
    }

    const target = path.resolve(dirname(source), wantedName)
    fs.copyFileSync(madePath, target)

    // The memo file holds the code. When the binary file is built, the memo
    // is written again and it goes back with the binary file, because the two
    // belong to each other. When only the text is wanted, the memo stays as
    // it is, because the tool recompiles the form on the way and the memo it
    // leaves behind does not belong to the binary file that was there.
    if (direction === "binary") {
      const memoFile = memoPathOf(wanted)
      if (memoFile) {
        // The tool names the file the way it wants, so the file is looked for
        // in the scratch folder by its name and not by its case.
        const madeMemo = findIn(scratch, basename(memoFile))
        if (madeMemo) {
          try {
            fs.copyFileSync(madeMemo, path.resolve(dirname(wanted), basename(memoFile)))
          } catch {
            /* the memo is part of the file, but the copy is a convenience */
          }
        }
      }
    }

    // The tool keeps a copy of the file it replaces. It belongs next to the
    // file, so the work can be undone.
    const backup = path.join(scratch, `${wantedName}.bak`)
    if (fs.existsSync(backup)) {
      try {
        fs.copyFileSync(backup, `${target}.bak`)
      } catch {
        /* the backup is a convenience */
      }
    }

    return { ok: true, path: target, log }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    void removeScratch(scratch)
  }
}

/** The log the tool leaves in the scratch folder. */
function readLog(folder: string): string | undefined {
  for (const name of fs.readdirSync(folder)) {
    if (!name.toUpperCase().endsWith(".LOG")) continue
    try {
      const text = fs.readFileSync(path.join(folder, name), "utf8")
      if (text) return text
    } catch {
      /* the log is only for telling the user what went wrong */
    }
  }
  return undefined
}

/**
 * The error the tool left behind.
 *
 * FoxBin2Prg recompiles a form to get at its code, and it writes the recompiled
 * form back. When the form has a code error, the recompile fails and the .scx
 * and its .sct are left without each other. The tool leaves an .ERR file
 * behind when that happens, and that file has to be looked at, because the
 * file it made looks fine but is not.
 */
function readError(folder: string): string | undefined {
  for (const name of fs.readdirSync(folder)) {
    if (!name.toUpperCase().endsWith(".ERR")) continue
    try {
      const text = fs.readFileSync(path.join(folder, name), "utf8")
      const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("ENDPROC"))
      if (lines.length) return lines.slice(0, 3).join(" | ")
    } catch {
      /* the error file is only for telling the user what went wrong */
    }
  }
  return undefined
}

function lastLines(text: string, count = 3): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith(">"))
  return lines.slice(-count).join(" | ")
}

/** Turns a binary file into its readable text file. */
export function toText(binary: string, tool: string): Conversion {
  const text = textPathOf(binary)
  if (!text) return { ok: false, error: `${basename(binary)} is not a Visual FoxPro binary file.` }
  if (!fs.existsSync(binary)) return { ok: false, error: `${binary} is not there.` }
  return runTool(tool, binary, text, "text")
}

/** Turns a text file back into its binary file. */
export function toBinary(text: string, tool: string): Conversion {
  const binary = binaryPathOf(text)
  if (!binary) return { ok: false, error: `${basename(text)} is not a Visual FoxPro text file.` }
  if (!fs.existsSync(text)) return { ok: false, error: `${text} is not there.` }
  return runTool(tool, text, binary, "binary")
}

/** A mark of a file that changes when the file changes. */
export function stampOf(file: string): string {
  try {
    const info = fs.statSync(file)
    return `${info.size} ${Math.round(info.mtimeMs)}`
  } catch {
    return ""
  }
}

/** Every file of a kind under a folder, with its full path. */
export function filesOfKind(root: string, kind: string): string[] {
  const found: string[] = []
  const walk = (folder: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(folder, entry.name)
      if (entry.isDirectory()) {
        // The folders that hold the build output are not part of the source.
        if (/^(bin|obj|node_modules|\.git)$/i.test(entry.name)) continue
        walk(full)
      } else if (entry.name.toLowerCase().endsWith(`.${kind}`)) {
        found.push(full)
      }
    }
  }
  walk(root)
  return found.sort()
}
