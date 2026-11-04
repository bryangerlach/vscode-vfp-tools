import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

/**
 * The marker that says which side of a file was changed.
 *
 * The times of the files are not enough, because FoxBin2Prg gives the file it
 * writes the time of the run. So a conversion of a form and a change of the
 * form in the designer look the same.
 *
 * The marker holds the mark of both files of every pair, as they were the
 * last time the two were seen together. When the text file is not the mark
 * it was, the text was changed and the binary file has to be built again.
 * When the binary file is not the mark it was, the form was changed in the
 * designer and the text has to catch up.
 *
 * The bridge on the Visual FoxPro side writes the same file, so the two know
 * what the other did.
 */

/** The folder the marker is in. The same one the bridge uses. */
export function bridgeFolder(): string {
  const local = process.env.LOCALAPPDATA
  const app = process.env.APPDATA
  const temp = process.env.TEMP
  const root = local || app || temp
  return root ? path.join(root, "opencode", "vfp") : path.join(os.tmpdir(), "opencode", "vfp")
}

/** The name of the marker file for a project. */
export function markerFile(project: string): string {
  const safe = path.basename(project).toLowerCase().replace(/\./g, "_") || "project"
  return path.join(bridgeFolder(), `sync_${safe}.txt`)
}

/**
 * The mark of a file: its size, the day it was written and the second of that
 * day.
 *
 * The bridge writes the mark in the same way, so the two can read each
 * other's file. Two things about this Visual FoxPro are worth knowing:
 *
 *   * DTOS() gives the day as YYYYMMDD, without the dashes.
 *   * ADIR() gives the time of a file rounded up to the next even second, so
 *     the mark is made the same way here.
 */
export function fingerprint(file: string): string {
  try {
    const info = fs.statSync(file)
    const when = new Date(info.mtimeMs)
    const day = `${when.getFullYear()}${String(when.getMonth() + 1).padStart(2, "0")}${String(
      when.getDate(),
    ).padStart(2, "0")}`
    const raw =
      when.getHours() * 3600 + when.getMinutes() * 60 + when.getSeconds()
    // The time is rounded up to the next even second, the way Visual FoxPro
    // keeps it. The part of the millisecond that is left over decides
    // whether the second is whole, because getMilliseconds() throws it away.
    const leftover = info.mtimeMs % 1000
    const seconds = Math.ceil((raw + (leftover > 0 ? 1 : 0)) / 2) * 2
    return `${info.size} ${day} ${String(seconds).padStart(6, "0")}`
  } catch {
    return ""
  }
}

/** What the marker holds for one file. */
export interface Marked {
  /** The mark of the text file. */
  text: string
  /** The mark of the binary file. */
  binary: string
}

/** The marker of every file of the project. */
export function readMarker(file: string): Map<string, Marked> {
  const marked = new Map<string, Marked>()
  let text: string
  try {
    text = fs.readFileSync(file, "latin1")
  } catch {
    return marked
  }
  for (const line of text.split(/\r?\n/)) {
    const entry = line.trim()
    if (!entry) continue
    const parts = entry.split("|")
    if (parts.length < 3) continue
    // The bridge ends every entry with a semicolon.
    marked.set(parts[0].toLowerCase(), {
      text: parts[1].trim(),
      binary: parts[2].replace(/;$/, "").trim(),
    })
  }
  return marked
}

/**
 * Writes the marker.
 *
 * The whole file is written again, because the bridge writes it as well and
 * the two have to agree.
 */
export function writeMarker(file: string, marked: Map<string, Marked>): void {
  const lines: string[] = []
  for (const [key, value] of marked) {
    lines.push(`${key}|${value.text}|${value.binary};`)
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, lines.join("\r\n") + "\r\n", "latin1")
  } catch {
    /* the marker is a convenience, not a must */
  }
}

/**
 * Marks one pair of files, so the two are known to be in step.
 *
 * The mark of the text file and the mark of the binary file are both taken
 * now, because they were made from each other.
 */
export function markPair(marker: string, text: string, binary: string): void {
  const marked = readMarker(marker)
  marked.set(text.toLowerCase(), { text: fingerprint(text), binary: fingerprint(binary) })
  writeMarker(marker, marked)
}

/**
 * Marks every pair of the project, so the two are known to be in step.
 *
 * This is what is done after a build, and after the text was made from the
 * binary file, because in both cases the two belong together.
 */
export function markAll(marker: string, pairs: Array<{ text: string; binary: string }>): void {
  const marked = readMarker(marker)
  for (const pair of pairs) {
    marked.set(pair.text.toLowerCase(), {
      text: fingerprint(pair.text),
      binary: fingerprint(pair.binary),
    })
  }
  writeMarker(marker, marked)
}

/** What the state of a pair is. */
export type State = "step" | "build" | "refresh" | "notext"

/**
 * The state of a pair of files.
 *
 * The marker says what was changed. When there is no mark for the file, the
 * times of the files are used, and that is the best that can be done.
 */
export function stateOf(
  text: string,
  binary: string,
  marked: Map<string, Marked>,
  textIsNewer: boolean,
): State {
  if (!fs.existsSync(text)) return "notext"
  const entry = marked.get(text.toLowerCase())
  if (!entry) {
    // Nothing is known about the file, so the times are used.
    return textIsNewer ? "build" : "step"
  }
  const nowText = fingerprint(text)
  const nowBinary = fingerprint(binary)
  if (entry.text === nowText) {
    if (entry.binary === nowBinary) return "step"
    // The binary file was changed, so the text is behind it.
    return "refresh"
  }
  // The text file was changed, so the binary file has to be built again.
  return "build"
}
