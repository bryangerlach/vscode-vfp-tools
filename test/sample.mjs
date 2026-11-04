// Helpers for the checks that need a real Visual FoxPro project.
//
// The normal test suite is self-contained. A few checks are more useful on a
// real project, so they are opt-in: set VFP_SAMPLE_PROJECT to the folder of a
// project to run them. Nothing in that project is written to.
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"

/** The sample project, or undefined when the checks should be skipped. */
export function sampleProject() {
  const root = process.env.VFP_SAMPLE_PROJECT
  if (!root) {
    console.log("skipped: set VFP_SAMPLE_PROJECT to run this check against a real project.")
    return undefined
  }
  if (!existsSync(root)) {
    console.log("skipped: VFP_SAMPLE_PROJECT does not point at a folder:", root)
    return undefined
  }
  return root
}

/** The project file of a sample project, or undefined. */
export function sampleProjectFile(root) {
  const named = process.env.VFP_SAMPLE_PROJECT_FILE
  if (named && existsSync(named)) return named
  const found = readdirSync(root).find((name) => name.toLowerCase().endsWith(".pjx"))
  return found ? join(root, found) : undefined
}

/** The first form of a sample project that has its memo, or undefined. */
export function sampleForm(root) {
  const folders = [join(root, "forms"), root]
  for (const folder of folders) {
    let names
    try {
      names = readdirSync(folder)
    } catch {
      continue
    }
    for (const name of names.sort()) {
      if (!name.toLowerCase().endsWith(".scx")) continue
      const stem = name.slice(0, -4)
      const memo = names.find((other) => other.toLowerCase() === `${stem.toLowerCase()}.sct`)
      if (memo) return { binary: join(folder, name), memo: join(folder, memo) }
    }
  }
  return undefined
}
