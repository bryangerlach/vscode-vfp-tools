// The scratch folder, and what happens when Windows will not let go of it.
//
// A folder that was just written to can still be held for a moment by the
// virus scanner or by the indexer. The removal waits for the hold to be let go
// of, and it does that in the background, so the window keeps answering. A
// folder that still will not go is left behind and swept up by a later run. It
// must never throw: an error about a folder the user never asked for used to
// reach them as "A system error occurred".
import { createRequire } from "node:module"
import { chmodSync, existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { tmpdir } from "node:os"
const require = createRequire(import.meta.url)
const { removeScratch, removeFile, sweepScratchRoot } = require("../out/scratch.js")

const root = join(tmpdir(), "vfp-tools-test")
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })

let good = true
function check(name, ok, note = "") {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${note ? "  " + note : ""}`)
  if (!ok) good = false
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Holds a file open the way another program does, and says when it has it.
 *
 * Windows will not remove a file that is open without sharing, and it will not
 * remove the folder it is in either. The hold is taken by a program of its
 * own, because nothing in this program can lock a file that way.
 */
async function hold(file, ms, mark) {
  const lock = spawn(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command",
     `$f = [System.IO.File]::Open('${file}','Open','ReadWrite','None');` +
     ` Set-Content -Path '${mark}' -Value 'held'; Start-Sleep -Milliseconds ${ms}; $f.Close()`],
    { windowsHide: true },
  )
  for (let i = 0; i < 300; i++) {
    if (existsSync(mark)) return lock
    if (lock.exitCode !== null) break
    await wait(50)
  }
  throw new Error("the file could not be held")
}

// ---- 1. the ordinary case ------------------------------------------------
const plain = join(root, "1-aaaa")
mkdirSync(plain)
writeFileSync(join(plain, "frm.SC2"), "text", "latin1")
check("a folder that is not held goes", (await removeScratch(plain)) && !existsSync(plain))

// ---- 2. a file that is read-only -----------------------------------------
// A file that is copied from a read-only file in the project is read-only
// itself, and Windows will not remove it until the mark is taken off.
const readOnly = join(root, "2-bbbb")
mkdirSync(readOnly)
const readOnlyFile = join(readOnly, "frm.scx")
writeFileSync(readOnlyFile, "binary", "latin1")
chmodSync(readOnlyFile, 0o444)
check("a read-only file goes as well", (await removeScratch(readOnly)) && !existsSync(readOnly))

// ---- 3. a folder that another program is holding for a moment ------------
// This is the case that was reported: the folder is empty, and it still will
// not go for a second.
const held = join(root, "3-cccc")
mkdirSync(held)
const heldFile = join(held, "frm.sct")
writeFileSync(heldFile, "code", "latin1")
const shortLock = await hold(heldFile, 2500, join(root, "held.mark"))

let threw
let removed
let ticks = 0
const ticker = setInterval(() => ticks++, 20)
const started = Date.now()
try {
  removed = await removeScratch(held)
} catch (error) {
  threw = error
}
clearInterval(ticker)
const waited = Date.now() - started

check("a folder that is held does not throw", threw === undefined, threw ? String(threw.message) : "")
check("it waits for the hold and then takes it", removed === true && !existsSync(held), `${waited} ms`)
check("the window keeps answering while it waits", ticks > 10, `${ticks} ticks of 20 ms`)
shortLock.kill()

// ---- 4. a hold that lasts a long time ------------------------------------
// It keeps trying in the background, and the window keeps answering while it
// does. The user is told nothing about it either way.
const stuck = join(root, "4-dddd")
mkdirSync(stuck)
const stuckFile = join(stuck, "frm.sct")
writeFileSync(stuckFile, "code", "latin1")
const longLock = await hold(stuckFile, 6000, join(root, "stuck.mark"))

let stuckThrew
let stuckTicks = 0
const stuckTicker = setInterval(() => stuckTicks++, 20)
const stuckDone = removeScratch(stuck).catch((error) => {
  stuckThrew = error
  return false
})
await wait(2500)
clearInterval(stuckTicker)
check(
  "a long hold is waited out in the background, without a word",
  stuckThrew === undefined && stuckTicks > 60,
  `${stuckTicks} ticks of 20 ms, threw=${stuckThrew ? String(stuckThrew.message) : "no"}`,
)
check("and it does go when the hold is let go", (await stuckDone) === true && !existsSync(stuck))
longLock.kill()
await wait(400)

// ---- 5. sweeping up what was left behind ---------------------------------
const old = join(root, "1000000000000-old")
const young = join(root, "9999999999999-young")
mkdirSync(old)
mkdirSync(young)
const longAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
utimesSync(old, longAgo, longAgo)
const oldBuild = join(root, "build_1000000000000.fxp")
const youngBuild = join(root, "build_9999999999999.fxp")
writeFileSync(oldBuild, "compiled", "latin1")
utimesSync(oldBuild, longAgo, longAgo)
writeFileSync(youngBuild, "compiled", "latin1")
const notes = join(root, "notes.txt")
writeFileSync(notes, "not ours", "latin1")
utimesSync(notes, longAgo, longAgo)

await sweepScratchRoot(root)

check("an old scratch folder is swept", !existsSync(old))
check("a folder that was just made is kept", existsSync(young))
check("an old build file is swept", !existsSync(oldBuild))
check("a build file that was just made is kept", existsSync(youngBuild))
check("a file that is not ours is left alone", existsSync(notes))

// ---- 6. one file, quietly ------------------------------------------------
const one = join(root, "one.txt")
writeFileSync(one, "x")
check("one file goes", (await removeFile(one)) && !existsSync(one))
check("a file that is not there is not an error", (await removeFile(join(root, "gone.txt"))) === true)

rmSync(root, { recursive: true, force: true })
console.log(good ? "\nall fine" : "\nthere are failures above")
process.exit(good ? 0 : 1)
