import * as fs from "node:fs"
import * as path from "node:path"
import { execFileSync, spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { removeFile, removeFileNow, sweepScratchRoot } from "./scratch"

const { existsSync, mkdirSync, readFileSync, writeFileSync } = fs
const { join } = path

/**
 * Talking to Visual FoxPro.
 *
 * The IDE is a COM server. The one that is already running is reached with
 * GetActiveObject, which is how the extension opens a form in the IDE the
 * user has open, and not in a second one.
 *
 * A build is a different matter. It changes the files of the project, and the
 * IDE holds some of them open, so the build gets a Visual FoxPro of its own
 * that is closed again when the build is done.
 */

/** The places Visual FoxPro is usually installed in. */
const VFP_FOLDERS = [
  "C:\\Program Files (x86)\\Microsoft Visual FoxPro Advanced 10.2",
  "C:\\Program Files (x86)\\Microsoft Visual FoxPro Advanced 10.1",
  "C:\\Program Files (x86)\\Microsoft Visual FoxPro 9",
  "C:\\Program Files\\Microsoft Visual FoxPro Advanced 10.2",
  "C:\\Program Files\\Microsoft Visual FoxPro 9",
]

/** The program of each folder. */
const VFP_EXES = ["VFPA.EXE", "vfp9.exe", "VFP9.EXE"]

/** The COM name of the IDE. */
const PROG_ID = "VisualFoxpro.Application"

/** Finds the Visual FoxPro program, for a build that runs on its own. */
export function findVfp(configured?: string): string | undefined {
  if (configured && fs.existsSync(configured)) return path.resolve(configured)
  for (const folder of VFP_FOLDERS) {
    if (!fs.existsSync(folder)) continue
    for (const exe of VFP_EXES) {
      const candidate = path.join(folder, exe)
      if (fs.existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/** The path of the PowerShell that is used to talk to the COM server. */
function powershell(): string {
  return path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  )
}

/** The result of a command that was sent to the IDE. */
export interface IdeResult {
  ok: boolean
  error?: string
}

/**
 * Sends a command to the Visual FoxPro that is already running.
 *
 * Node has no way of talking to a COM server that is already running, so
 * this goes through PowerShell, which has GetActiveObject.
 */
export function runInIde(command: string): IdeResult {
  const escaped = command.replace(/'/g, "''")
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    "try {",
    `  $o = [Runtime.InteropServices.Marshal]::GetActiveObject('${PROG_ID}')`,
    `  $o.DoCmd('${escaped}')`,
    "  exit 0",
    "} catch {",
    "  Write-Output $_.Exception.Message",
    "  exit 1",
    "}",
  ].join("\n")
  return runPowerShell(ps)
}

/** Whether a Visual FoxPro is running. */
export function ideIsRunning(): boolean {
  const ps = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "try {",
    `  $o = [Runtime.InteropServices.Marshal]::GetActiveObject('${PROG_ID}')`,
    "  Write-Output $o.Version",
    "  exit 0",
    "} catch {",
    "  exit 1",
    "}",
  ].join("\n")
  return runPowerShell(ps).ok
}

/** The caption of the Visual FoxPro that is running. */
export function ideCaption(): string | undefined {
  const ps = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "try {",
    `  $o = [Runtime.InteropServices.Marshal]::GetActiveObject('${PROG_ID}')`,
    "  Write-Output $o.Caption",
    "  exit 0",
    "} catch {",
    "  exit 1",
    "}",
  ].join("\n")
  const result = runPowerShell(ps)
  return result.ok ? result.output?.trim() : undefined
}

/** Runs a PowerShell script and gives back what it said. */
function runPowerShell(ps: string): { ok: boolean; output?: string; error?: string } {
  try {
    const out = execFileSync(powershell(), ["-NoProfile", "-NonInteractive", "-Command", ps], {
      encoding: "utf8",
      windowsHide: true,
    })
    return { ok: true, output: out }
  } catch (error) {
    const stdout =
      error && typeof error === "object" && "stdout" in error
        ? String((error as { stdout?: string }).stdout ?? "").trim()
        : ""
    const message =
      error && typeof error === "object" && "message" in error
        ? String((error as { message?: string }).message ?? "")
        : String(error)
    return { ok: false, error: stdout || message || "PowerShell did not answer." }
  }
}

/**
 * Runs a Visual FoxPro program in a Visual FoxPro of its own.
 *
 * Visual FoxPro runs the program that is given on its command line, but it
 * stays open afterwards. So a small program is written that runs the build
 * and closes Visual FoxPro again, and that program is what is started.
 *
 * The result is written to a file, so the caller knows whether the build
 * worked even when Visual FoxPro says nothing.
 *
 * Visual FoxPro remembers its settings from one run to the next in a resource
 * file, and among those settings is the project it was left with. That is bad
 * twice over here. The project opens by itself in the Visual FoxPro that is
 * started for one program, so the program is not working on the project of the
 * user at all, and the resource file is written again on the way out, which
 * takes minutes when that file sits on a slow path. A configuration file of its
 * own is therefore handed to Visual FoxPro with -C, so that it leaves the
 * resource file alone.
 */
export function runProgram(vfp: string, program: string, folder: string): IdeResult {
  const stamp = Date.now()
  const home = join(tmpdir(), "vfp-tools")
  const wrapper = join(home, `build_${stamp}.prg`)
  const resultFile = join(home, `build_${stamp}.txt`)
  const config = join(home, `build_${stamp}.fpw`)
  mkdirSync(home, { recursive: true })
  void sweepScratchRoot(home)
  try {
    removeFileNow(resultFile)
    // The resource file is left alone, and nothing else is set here.
    writeFileSync(config, "RESOURCE = OFF\r\n", "latin1")
    writeFileSync(
      wrapper,
      [
        "* Runs the build program and closes Visual FoxPro again.",
        "ON ERROR DO build_err",
        `DO ("${program.replace(/"/g, '""')}")`,
        `=STRTOFILE("ok", "${resultFile.replace(/"/g, '""')}", 0)`,
        "* A project that the program left open is not saved, and nothing is asked",
        "* about it, because there is no window here to ask in.",
        "SET SAFETY OFF",
        "QUIT",
        "",
        "* The build failed. The error is written down and Visual FoxPro closes",
        "* anyway, so the caller is not left waiting for it.",
        "PROCEDURE build_err",
        `=STRTOFILE("error " + TRANSFORM(ERROR()) + ": " + MESSAGE(), "${resultFile.replace(/"/g, '""')}", 0)`,
        "SET SAFETY OFF",
        "QUIT",
        "ENDPROC",
        "",
      ].join("\r\n"),
      "latin1",
    )

    // The output is not used, and Visual FoxPro can leave a helper process
    // behind. With pipes, that helper would keep the output open and the call
    // would wait for it long after Visual FoxPro itself has closed.
    const result = spawnSync(vfp, [`-C${config}`, wrapper], {
      cwd: folder,
      windowsHide: true,
      stdio: "ignore",
      timeout: 30 * 60 * 1000,
    })

    if (result.error) {
      return { ok: false, error: result.error.message }
    }
    if (existsSync(resultFile)) {
      const text = readFileSync(resultFile, "utf8").trim()
      if (text && text !== "ok") {
        return { ok: false, error: text }
      }
      return { ok: true }
    }
    // Visual FoxPro did not write a result. It was killed, or it is still
    // running.
    if (result.status !== 0) {
      return {
        ok: false,
        error: `Visual FoxPro ended with the code ${result.status}.`,
      }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    void removeFile(wrapper)
    void removeFile(resultFile)
    // Visual FoxPro compiles the wrapper that is run, and it leaves the
    // compiled one behind.
    void removeFile(wrapper.replace(/\.prg$/i, ".fxp"))
  }
}

/** The command that opens a file in the IDE. */
export function openCommand(file: string): string {
  const ext = path.extname(file).replace(".", "").toLowerCase()
  switch (ext) {
    case "scx":
      return `MODIFY FORM ${quote(file)}`
    case "frx":
      return `MODIFY REPORT ${quote(file)}`
    case "vcx":
      return `MODIFY CLASS ${quote(file)}`
    case "mnx":
      return `MODIFY MENU ${quote(file)}`
    case "pjx":
      return `MODIFY PROJECT ${quote(file)}`
    default:
      return `MODIFY COMMAND ${quote(file)}`
  }
}

/** A path in quotes, with a doubled quote inside it. */
export function quote(file: string): string {
  return `"${file.replace(/"/g, '""')}"`
}
