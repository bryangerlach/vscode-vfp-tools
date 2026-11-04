// Checks what "Go to Definition", F12 and Ctrl+click do in Visual FoxPro code.
//
// The names of Visual FoxPro are not always the names of files: DO hello runs
// hello.prg, DO add IN tools runs a procedure of tools.prg, SET PROCEDURE TO
// names a file that holds procedures, DO FORM names a form whose text is the
// master, and THISFORM.Foo calls a method of the form or of one of its classes.
// Every one of those is checked here, on a small project made for the test.
//
// A name that is not found is not an error: it can be in a DLL or an APP. That
// is checked too, together with the names that are only in a comment or in a
// string, which must not be answered.
//
// Run it with:
//   cd extension
//   node node_modules/typescript/bin/tsc -p ./
//   node test/goto.mjs
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const here = join(dirname(fileURLToPath(import.meta.url)), "..")
const { definitionsAt, forgetIndex } = require(join(here, "out", "goto.js"))

// --- a way to say what is wrong ----------------------------------------------------
let passed = 0
const failures = []
function check(what, ok, detail) {
  if (ok) {
    passed++
    return
  }
  failures.push(`${what}${detail ? `  --  ${detail}` : ""}`)
}
function same(what, got, wanted) {
  check(what, JSON.stringify(got) === JSON.stringify(wanted), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(wanted)}`)
}

// --- the project that the test goes to ----------------------------------------------
const work = join(tmpdir(), "opencode", "gototest")
rmSync(work, { recursive: true, force: true })
mkdirSync(join(work, "forms"), { recursive: true })
mkdirSync(join(work, "progs"), { recursive: true })

const demo = `*< FOXBIN2PRG: Version="1.21" SourceFile="demo.scx" />

DEFINE CLASS dataenvironment AS dataenvironment
	*< CLASSDATA: Baseclass="dataenvironment" Scale="" />
ENDDEFINE

DEFINE CLASS demo AS form
	*< CLASSDATA: Baseclass="form" Scale="" />
	Height = 200
	Width = 300
	ADD OBJECT 'cmdGo' AS commandbutton WITH ;
		Name = "cmdGo", ;
		Caption = "Go"
	*< END OBJECT: BaseClass="commandbutton" />
	ADD OBJECT 'cmdLib' AS mycmd OF "mylib.vcx" WITH ;
		Name = "cmdLib", ;
		Caption = "Lib"
	*< END OBJECT: BaseClass="commandbutton" ClassLib="mylib.vcx" />

	PROCEDURE Init
		THISFORM.my_method
		ThisForm.My_Method
		THISFORM.cmdGo.Click
		THISFORM.cmdLib.DoIt
		THISFORM.cmdLib.Click
		thisform.missing
		? "THISFORM.my_method"
	ENDPROC

	PROCEDURE my_method
		DO hello
		DO addnums IN tools
		DO orphan
	ENDPROC

	PROCEDURE cmdGo.Click
		RETURN
	ENDPROC

	PROCEDURE cmdLib.Click
		this.DoIt
	ENDPROC
ENDDEFINE
`

const library = `*< FOXBIN2PRG: Version="1.21" SourceFile="mylib.vcx" />

DEFINE CLASS mycmd AS commandbutton
	*< CLASSDATA: Baseclass="commandbutton" Scale="" />
	PROCEDURE DoIt
		RETURN
	ENDPROC
	PROCEDURE Click
		RETURN
	ENDPROC
ENDDEFINE
`

const tools = `* tools
PROCEDURE addnums
	LPARAMETERS a, b
	RETURN a + b
ENDPROC

FUNCTION subtract
	LPARAMETERS a, b
	RETURN a - b
ENDFUNC
`

const hello = `LPARAMETERS tcName
? "hello"
RETURN
`

const library2 = `* another library
PROCEDURE orphan
	RETURN
ENDPROC
`

const local = `PROCEDURE outer
	DO localproc
ENDPROC

PROCEDURE localproc
	RETURN
ENDPROC
`

const main = `SET PROCEDURE TO tools ADDITIVE
DO addnums
DO subtract
DO hello
DO missing
DO addnums IN tools
SET PROCEDURE TO tools
DO FORM demo
DO FORM "demo.scx"
DO WHILE .T.
DO foo
* DO hello
&& DO hello
? "DO hello"
IF .T. THEN DO hello
DO orphan
DO hello.prg
DO foo IN nowhere
DO FORM binaryonly
DO FORM missing
`

const files = {
  "forms/demo.sc2": demo,
  "forms/mylib.vc2": library,
  "forms/binaryonly.scx": "not a text form",
  "progs/tools.prg": tools,
  "progs/hello.prg": hello,
  "progs/library2.prg": library2,
  "progs/local.prg": local,
  "progs/main.prg": main,
}
for (const [name, text] of Object.entries(files)) writeFileSync(join(work, name), text, "utf8")

// --- asking ------------------------------------------------------------------------
const file = (name) => join(work, name)
const textOf = (name) => files[name]

/** The line and column of a word on a line of a file. */
function spot(name, needle, part = needle) {
  const text = textOf(name)
  const lines = text.split("\n")
  const index = lines.findIndex((line) => line.includes(needle))
  if (index < 0) throw new Error(`${needle} is not in ${name}`)
  const column = lines[index].indexOf(part)
  if (column < 0) throw new Error(`${part} is not on the ${needle} line`)
  return { line: index + 1, column: column + 1 }
}

/** What going to a word on a line comes to, as file and line, or nothing. */
function go(name, needle, part) {
  const where = spot(name, needle, part)
  return definitionsAt({
    file: file(name),
    text: textOf(name),
    line: where.line,
    column: where.column,
    root: work,
  })
}

/** A target written the short way, so that the folder of the test does not matter. */
function short(targets) {
  return targets.map((one) => `${basename(one.file).toLowerCase()}:${one.line}`)
}

/** The line of a PROCEDURE, FUNCTION or the first line, in a test file. */
function lineOf(name, needle) {
  return textOf(name).split("\n").findIndex((line) => line.includes(needle)) + 1
}

forgetIndex()

// --- THISFORM and THIS --------------------------------------------------------------
console.log("THISFORM and THIS")
{
  same("a form method goes to its PROCEDURE", short(go("forms/demo.sc2", "THISFORM.my_method", "my_method")), [
    `demo.sc2:${lineOf("forms/demo.sc2", "PROCEDURE my_method")}`,
  ])
  same("the case of the name does not matter", short(go("forms/demo.sc2", "ThisForm.My_Method", "My_Method")), [
    `demo.sc2:${lineOf("forms/demo.sc2", "PROCEDURE my_method")}`,
  ])
  same("an event of a control goes to the code of the form", short(go("forms/demo.sc2", "THISFORM.cmdGo.Click", "Click")), [
    `demo.sc2:${lineOf("forms/demo.sc2", "PROCEDURE cmdGo.Click")}`,
  ])
  same("a method of a class of the project goes to the class library", short(go("forms/demo.sc2", "THISFORM.cmdLib.DoIt", "DoIt")), [
    `mylib.vc2:${lineOf("forms/mylib.vc2", "PROCEDURE DoIt")}`,
  ])
  same("THIS is the control whose method the caret is in", short(go("forms/demo.sc2", "this.DoIt", "DoIt")), [
    `mylib.vc2:${lineOf("forms/mylib.vc2", "PROCEDURE DoIt")}`,
  ])
  same("the form's own method wins over the class", short(go("forms/demo.sc2", "THISFORM.cmdLib.Click", "Click")), [
    `demo.sc2:${lineOf("forms/demo.sc2", "PROCEDURE cmdLib.Click")}`,
  ])
  same("a name that is not there is not answered", go("forms/demo.sc2", "thisform.missing", "missing"), [])
  same("THISFORM itself is not a method", go("forms/demo.sc2", "THISFORM.my_method", "THISFORM"), [])
  same("a name in a string is not code", go("forms/demo.sc2", '? "THISFORM.my_method"', "my_method"), [])
}

// --- DO -----------------------------------------------------------------------------
console.log("")
console.log("DO")
{
  same("DO addnums goes to the procedure of tools.prg", short(go("progs/main.prg", "DO addnums", "addnums")), [
    `tools.prg:${lineOf("progs/tools.prg", "PROCEDURE addnums")}`,
  ])
  same("DO subtract goes to the FUNCTION", short(go("progs/main.prg", "DO subtract", "subtract")), [
    `tools.prg:${lineOf("progs/tools.prg", "FUNCTION subtract")}`,
  ])
  same("DO hello goes to hello.prg", short(go("progs/main.prg", "DO hello", "hello")), ["hello.prg:1"])
  same("DO hello.prg goes to hello.prg as well", short(go("progs/main.prg", "DO hello.prg", "hello.prg")), ["hello.prg:1"])
  same("DO addnums IN tools goes to the procedure of that file", short(go("progs/main.prg", "DO addnums IN tools", "tools")), [
    `tools.prg:${lineOf("progs/tools.prg", "PROCEDURE addnums")}`,
  ])
  same("the name of a DO ... IN is found as well", short(go("progs/main.prg", "DO addnums IN tools", "addnums")), [
    `tools.prg:${lineOf("progs/tools.prg", "PROCEDURE addnums")}`,
  ])
  same("a procedure of another program is found by its name", short(go("progs/main.prg", "DO orphan", "orphan")), [
    `library2.prg:${lineOf("progs/library2.prg", "PROCEDURE orphan")}`,
  ])
  same("a procedure of the file that is open is found", short(go("progs/local.prg", "DO localproc", "localproc")), [
    `local.prg:${lineOf("progs/local.prg", "PROCEDURE localproc")}`,
  ])
  same("DO from a form finds a program of the project", short(go("forms/demo.sc2", "DO hello", "hello")), ["hello.prg:1"])
  same("DO from a form finds the file of a DO ... IN", short(go("forms/demo.sc2", "DO addnums IN tools", "tools")), [
    `tools.prg:${lineOf("progs/tools.prg", "PROCEDURE addnums")}`,
  ])
  same("DO from a form finds a procedure with no SET PROCEDURE", short(go("forms/demo.sc2", "DO orphan", "orphan")), [
    `library2.prg:${lineOf("progs/library2.prg", "PROCEDURE orphan")}`,
  ])
  same("a DO that is after THEN is found", short(go("progs/main.prg", "IF .T. THEN DO hello", "hello")), ["hello.prg:1"])
  same("a name that is not there is not answered", go("progs/main.prg", "DO missing", "missing"), [])
  same("a file of a DO ... IN that is not there is not answered", go("progs/main.prg", "DO foo IN nowhere", "nowhere"), [])
  same("DO WHILE is not a program", go("progs/main.prg", "DO WHILE", "WHILE"), [])
  same("DO in a comment is not code", go("progs/main.prg", "* DO hello", "hello"), [])
  same("DO after && is not code", go("progs/main.prg", "&& DO hello", "hello"), [])
  same("DO in a string is not code", go("progs/main.prg", '? "DO hello"', "hello"), [])
}

// --- SET PROCEDURE ------------------------------------------------------------------
console.log("")
console.log("SET PROCEDURE TO")
{
  same("the file of SET PROCEDURE TO is opened", short(go("progs/main.prg", "SET PROCEDURE TO tools", "tools")), [
    "tools.prg:1",
  ])
  same("a procedure of the file that SET PROCEDURE TO names is found", short(go("progs/main.prg", "DO addnums", "addnums")), [
    `tools.prg:${lineOf("progs/tools.prg", "PROCEDURE addnums")}`,
  ])
  same("SET itself is not a file", go("progs/main.prg", "SET PROCEDURE TO tools", "SET"), [])
}

// --- DO FORM ------------------------------------------------------------------------
console.log("")
console.log("DO FORM")
{
  same("DO FORM goes to the text file of the form", short(go("progs/main.prg", "DO FORM demo", "demo")), ["demo.sc2:1"])
  same("the extension of a form does not matter", short(go("progs/main.prg", 'DO FORM "demo.scx"', "demo.scx")), [
    "demo.sc2:1",
  ])
  same("a form with no text file is not answered", go("progs/main.prg", "DO FORM binaryonly", "binaryonly"), [])
  same("a form that is not there is not answered", go("progs/main.prg", "DO FORM missing", "missing"), [])
}

// --- the answer ---------------------------------------------------------------------
console.log("")
if (failures.length) {
  for (const failure of failures) console.log(`  FAILED  ${failure}`)
  console.log("")
  console.log(`${passed} checks passed, ${failures.length} FAILED`)
  process.exit(1)
}
console.log(`${passed} checks passed, nothing failed.`)
