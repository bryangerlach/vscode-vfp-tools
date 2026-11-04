// Checks the grammar with the tokenizer that Visual Studio Code uses, so the
// colours are the real ones.
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
const require = createRequire(import.meta.url)
const oniguruma = require("vscode-oniguruma")
const { Registry } = require("vscode-textmate")

const here = join(dirname(fileURLToPath(import.meta.url)), "..")
const grammar = JSON.parse(readFileSync(join(here, "syntaxes", "vfp.tmLanguage.json"), "utf8"))

const wasm = readFileSync(
  join(here, "node_modules", "vscode-oniguruma", "release", "onig.wasm"),
)

oniguruma.loadWASM(wasm.buffer).then(async () => {
  const registry = new Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (sources) => new oniguruma.OnigScanner(sources),
      createOnigString: (str) => new oniguruma.OnigString(str),
    }),
    loadGrammar: async (scopeName) => (scopeName === "source.vfp" ? grammar : null),
  })
  const tmLanguage = await registry.loadGrammar("source.vfp")

  const samples = [
    ["* a comment about the form", "comment"],
    ['lcCmd = "a string"', "string"],
    ["lcCmd = 'another string'", "string"],
    ["IF m.lnOk > 0", "keyword"],
    ["LOCAL lcName, lnCount", "keyword"],
    ["DEFINE CLASS frm_customer AS myform", "keyword"],
    ['    .Caption = "Hello"', "string"],
    ["    lnCount = 42", "constant"],
    ["PROCEDURE cmdOk.Click", "keyword"],
    ["ENDPROC", "keyword"],
    ["#INCLUDE _VFPXMPATH", "meta.preprocessor"],
    ["DO myprogram", "keyword"],
    ["lcResult = m.lcText + TRANSFORM(m.lnCount)", "keyword"],
    ["lcB = 'a quoted word'", "string"],
  ]
  let good = 0
  for (const [line, expected] of samples) {
    const result = tmLanguage.tokenizeLine(line, null)
    const scopes = result.tokens.map((t) => t.scopes.join(" "))
    const hit = scopes.some((s) => s.includes(expected))
    if (hit) good++
    console.log(`${hit ? "ok  " : "MISS"} ${line.padEnd(44)} ${scopes[0] ?? ""}`)
  }
  console.log(`\n${good} of ${samples.length} lines are coloured as they should be`)
})
