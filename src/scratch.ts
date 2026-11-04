import * as fs from "node:fs"
import * as path from "node:path"

/**
 * Throwing away the scratch folders.
 *
 * FoxBin2Prg writes log files and backup files next to the file it works on,
 * and it recompiles the form on the way, so it never sees the project folder
 * of the user. What it does see is a folder in the temporary folder of the
 * user, and that folder is thrown away when the work is done.
 *
 * Windows does not always let go of a folder the moment the work is done with
 * it. A folder that was just written to can still be in the hands of the
 * virus scanner or of the indexer for a moment, and then it cannot be removed.
 * The error that comes out of that says nothing that helps the user:
 *
 *    EPERM, Permission denied:
 *    \\?\C:\Users\...\AppData\Local\Temp\vfp-tools\1792790420581-ezu5ncf4k9
 *
 * Two things follow from that. The removal waits for the hold to be let go
 * of, and it does so in the background, because Visual FoxPro and the
 * extension share one thread and a wait there would freeze everything that is
 * on the screen. And when the folder still will not go, it is left behind: it
 * is empty by then and it is in the temporary folder, so it does no harm, and
 * a later run sweeps it up. None of it is allowed to reach the user as an
 * error.
 */

/** How many times a removal is tried before the folder is left behind. */
const TRIES = 10

/** How long the first wait is, and how much longer every next one is. */
const WAIT = 100

/** Removes a folder and everything in it. True when the folder is gone. */
export function removeScratch(folder: string): Promise<boolean> {
  // A file that was copied from a read-only file is read-only itself, and
  // Windows will not remove those until the mark is taken off.
  makeWritableInside(folder)
  return remove(folder, true)
}

/** Removes one file. True when the file is gone. */
export function removeFile(file: string): Promise<boolean> {
  makeWritable(file)
  return remove(file, false)
}

/** Removes one file before it is written again, and says nothing when it will not go. */
export function removeFileNow(file: string): void {
  try {
    fs.rmSync(file, { force: true })
  } catch {
    /* it is written again over the top, and that works as well */
  }
}

/**
 * Sweeps up what earlier runs could not remove.
 *
 * Only the folders and the files that this extension makes are swept, and only
 * when they are a day old, so a build or a conversion that is going on in
 * another window is never touched.
 */
export async function sweepScratchRoot(root: string, olderThan = 24 * 60 * 60 * 1000): Promise<void> {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  const now = Date.now()
  for (const entry of entries) {
    // The folders of a conversion are <time>-<letters>, and the files of a
    // build are build_<time>.<prg|fxp|fpw|txt>. The .fpw is the configuration
    // file that keeps Visual FoxPro from reading and writing its resource file.
    const mine = entry.isDirectory()
      ? /^\d+-[a-z0-9]+$/i.test(entry.name)
      : /^build_\d+\.(prg|fxp|fpw|txt)$/i.test(entry.name)
    if (!mine) continue
    const full = path.join(root, entry.name)
    try {
      if (now - fs.statSync(full).mtimeMs < olderThan) continue
    } catch {
      continue
    }
    await (entry.isDirectory() ? removeScratch(full) : removeFile(full))
  }
}

/**
 * Removes, and waits for the hold to be let go of without stopping the world.
 *
 * The waiting is done by the file system itself, in the thread that is not the
 * one the screen is drawn on, so a folder that is held for a moment does not
 * make the window stop answering.
 */
function remove(target: string, recursive: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    fs.rm(
      target,
      { recursive, force: true, maxRetries: TRIES, retryDelay: WAIT },
      (error) => resolve(!error),
    )
  })
}

/** Takes the read-only mark off a file, and off what is in a folder. */
function makeWritable(target: string): void {
  try {
    const info = fs.statSync(target)
    if (info.isDirectory()) {
      makeWritableInside(target)
      return
    }
    if (info.mode & 0o200) return
    fs.chmodSync(target, 0o666)
  } catch {
    /* it may be gone already, which is what was wanted */
  }
}

function makeWritableInside(folder: string): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(folder, entry.name)
    if (entry.isDirectory()) makeWritableInside(full)
    else makeWritable(full)
  }
}
