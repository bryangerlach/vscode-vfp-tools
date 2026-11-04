// Checks the form preview: reading a form out of its text file, and drawing it.
//
// The preview reads the same .sc2/.vc2 text that FoxBin2Prg writes, so the only
// things it needs are the properties the property window shows. It is checked
// here on forms made for the test, which hold every shape the drawing code
// knows: a label with an accelerator, a caption that has to be escaped, a text
// box with a control source, a hidden control, a grid with real columns and
// headers, a control that is not drawn at all, and a form that takes its
// properties and its controls from a class library.
//
// The real forms of the project are looked at as well, when they are there, but
// only for the things that do not change when a form is edited.
//
// Run it with:
//   cd extension
//   node node_modules/typescript/bin/tsc -p ./
//   node test/form.mjs
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const here = join(dirname(fileURLToPath(import.meta.url)), "..")
const { parseSc2, modelsOf, methodsOf, prop, propText, propNumber, propBool } = require(join(here, "out", "form.js"))
const { renderHtml, renderNotice } = require(join(here, "out", "formview.js"))

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
function has(what, text, needle) {
  check(what, text.includes(needle), `"${needle}" is not in it`)
}
function hasNot(what, text, needle) {
  check(what, !text.includes(needle), `"${needle}" is in it`)
}

// --- the forms that the test draws --------------------------------------------------
const work = join(tmpdir(), "vfp-tools", "formtest")
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

// A form with one of everything.
const demo = `*< FOXBIN2PRG: Version="1.21" SourceFile="demo.scx" />

DEFINE CLASS dataenvironment AS dataenvironment 
 	*< CLASSDATA: Baseclass="dataenvironment" Scale="" />

	Height = 200
	Left = 1
	Name = "Dataenvironment"
	Top = 220
	Width = 520

ENDDEFINE

DEFINE CLASS demo AS form 
 	*< CLASSDATA: Baseclass="form" Scale="" />

	*<PropValue>
		BackColor = 212,208,200
		Caption = "Demo"
		Height = 200
		Left = 0
		Name = "DEMO"
		ScaleMode = 3
		Top = 0
		Width = 320
	*</PropValue>

	*-- OBJECTDATA items order determines ZOrder / El orden de los items OBJECTDATA determina el ZOrder
	*< OBJECTDATA: ObjPath="Label1" UniqueID="" Timestamp="" />
	*< OBJECTDATA: ObjPath="Label2" UniqueID="" Timestamp="" />
	*< OBJECTDATA: ObjPath="Text1" UniqueID="" Timestamp="" />
	*< OBJECTDATA: ObjPath="Command1" UniqueID="" Timestamp="" />
	*< OBJECTDATA: ObjPath="Grid1" UniqueID="" Timestamp="" />
	*< OBJECTDATA: ObjPath="Hidden1" UniqueID="" Timestamp="" />
	*< OBJECTDATA: ObjPath="Timer1" UniqueID="" Timestamp="" />

	ADD OBJECT 'Label1' AS label WITH ;
		Caption = "Name\\<:", ;
		FontName = "Times New Roman", ;
		FontSize = 12, ;
		Height = 17, ;
		Left = 10, ;
		Name = "Label1", ;
		Top = 10, ;
		Width = 60
	*< END OBJECT: BaseClass="label" />

	ADD OBJECT 'Label2' AS label WITH ;
		Caption = "He said ""hi"" & <b>", ;
		Height = 17, ;
		Left = 10, ;
		Name = "Label2", ;
		Top = 30, ;
		Width = 200
	*< END OBJECT: BaseClass="label" />

	ADD OBJECT 'Text1' AS textbox WITH ;
		ControlSource = "demo.name", ;
		Height = 23, ;
		Left = 80, ;
		Name = "Text1", ;
		Top = 48, ;
		Width = 120
	*< END OBJECT: BaseClass="textbox" />

	ADD OBJECT 'Command1' AS commandbutton WITH ;
		Caption = "<script>alert(1)</script>", ;
		Height = 25, ;
		Left = 220, ;
		Name = "Command1", ;
		Top = 48, ;
		Width = 90
	*< END OBJECT: BaseClass="commandbutton" />

	ADD OBJECT 'Grid1' AS grid WITH ;
		ColumnCount = 2, ;
		Height = 80, ;
		Left = 10, ;
		Name = "Grid1", ;
		RowHeight = 20, ;
		Top = 90, ;
		Width = 200, ;
		Column1.Name = "ColOne", ;
		Column1.Width = 120, ;
		Column2.Name = "ColTwo", ;
		Column2.Width = 80
	*< END OBJECT: BaseClass="grid" />

	ADD OBJECT 'Grid1.ColOne.Header1' AS header WITH ;
		Alignment = 2, ;
		BackColor = 0,100,0, ;
		Caption = "First\\<Head", ;
		ForeColor = 255,255,255, ;
		Height = 24, ;
		Name = "Header1", ;
		Width = 120
	*< END OBJECT: BaseClass="header" />

	ADD OBJECT 'Grid1.ColTwo.Header1' AS header WITH ;
		Alignment = 1, ;
		Caption = "Second", ;
		Height = 24, ;
		Name = "Header1", ;
		Width = 80
	*< END OBJECT: BaseClass="header" />

	ADD OBJECT 'Hidden1' AS label WITH ;
		Caption = "shown by code", ;
		Height = 17, ;
		Left = 250, ;
		Name = "Hidden1", ;
		Top = 180, ;
		Visible = .F., ;
		Width = 60
	*< END OBJECT: BaseClass="label" />

	ADD OBJECT 'Timer1' AS timer WITH ;
		Interval = 500, ;
		Name = "Timer1"
	*< END OBJECT: BaseClass="timer" />

	PROCEDURE Init
		THIS.Caption = "Demo"
	ENDPROC

	PROCEDURE Command1.Click
		MESSAGEBOX("clicked")
	ENDPROC

	PROCEDURE Grid1.ColOne.Text1.DblClick
		THIS.Value = 1
	ENDPROC

ENDDEFINE
`

// A class library: a form with a control of its own, a button and a box.
const library = `*< FOXBIN2PRG: Version="1.21" SourceFile="mylib.vcx" />

DEFINE CLASS myform AS form 
 	*< CLASSDATA: Baseclass="form" Scale="" />

	Caption = "From the class"
	Height = 240
	Width = 300

	*< OBJECTDATA: ObjPath="Logo" UniqueID="" Timestamp="" />

	ADD OBJECT 'Logo' AS label WITH ;
		Caption = "the class logo", ;
		Height = 17, ;
		Left = 8, ;
		Name = "Logo", ;
		Top = 8, ;
		Width = 100
	*< END OBJECT: BaseClass="label" />

	PROCEDURE Resize
		THIS.Logo.Top = 8
	ENDPROC

ENDDEFINE

DEFINE CLASS mycmd AS commandbutton 
 	*< CLASSDATA: Baseclass="commandbutton" Scale="" />

	Caption = "From the class"
	FontBold = .T.
	Height = 30
	Left = 5
	Top = 5
	Width = 120

	PROCEDURE Click
		THIS.Caption = "clicked"
	ENDPROC

ENDDEFINE

DEFINE CLASS mybox AS container 
 	*< CLASSDATA: Baseclass="container" Scale="" />

	BackColor = 255,0,0
	Height = 60
	Left = 0
	Top = 0
	Width = 100

	*< OBJECTDATA: ObjPath="Inside" UniqueID="" Timestamp="" />

	ADD OBJECT 'Inside' AS label WITH ;
		Caption = "inside the box", ;
		Height = 17, ;
		Left = 4, ;
		Name = "Inside", ;
		Top = 4, ;
		Width = 90
	*< END OBJECT: BaseClass="label" />

ENDDEFINE
`

// A form that takes everything it can from the class library.
const inherited = `*< FOXBIN2PRG: Version="1.21" SourceFile="inherited.scx" />

DEFINE CLASS inherited AS myform OF "mylib.vcx" 
 	*< CLASSDATA: Baseclass="form" Scale="" />

	*<PropValue>
		Caption = "The child"
		Height = 200
		Name = "INHERITED"
		ScaleMode = 3
		Width = 400
	*</PropValue>

	*< OBJECTDATA: ObjPath="Box1" UniqueID="" Timestamp="" />
	*< OBJECTDATA: ObjPath="Go1" UniqueID="" Timestamp="" />

	ADD OBJECT 'Box1' AS mybox OF "mylib.vcx" WITH ;
		Left = 10, ;
		Top = 40
	*< END OBJECT: ClassLib="mylib.vcx" BaseClass="container" />

	ADD OBJECT 'Go1' AS mycmd OF "mylib.vcx" WITH ;
		Left = 200, ;
		Top = 120
	*< END OBJECT: ClassLib="mylib.vcx" BaseClass="commandbutton" />

ENDDEFINE
`

// A form that was drawn in twips rather than in pixels.
const twips = `*< FOXBIN2PRG: Version="1.21" SourceFile="twips.scx" />

DEFINE CLASS twips AS form 
 	*< CLASSDATA: Baseclass="form" Scale="" />

	Caption = "Twips"
	Height = 3000
	ScaleMode = 0
	Width = 4500

	*< OBJECTDATA: ObjPath="Label1" UniqueID="" Timestamp="" />

	ADD OBJECT 'Label1' AS label WITH ;
		Caption = "in twips", ;
		Height = 255, ;
		Left = 150, ;
		Name = "Label1", ;
		Top = 300, ;
		Width = 1500
	*< END OBJECT: BaseClass="label" />

ENDDEFINE
`

// A form with a page frame: only the page that is open is drawn.
const wizard = `*< FOXBIN2PRG: Version="1.21" SourceFile="wizard.scx" />

DEFINE CLASS wizard AS form 
 	*< CLASSDATA: Baseclass="form" Scale="" />

	Caption = "Wizard"
	Height = 300
	Left = 0
	Name = "WIZARD"
	ScaleMode = 3
	Top = 0
	Width = 400

	*< OBJECTDATA: ObjPath="PageFrame1" UniqueID="" Timestamp="" />
	*< OBJECTDATA: ObjPath="List1" UniqueID="" Timestamp="" />

	ADD OBJECT 'PageFrame1' AS pageframe WITH ;
		ActivePage = 2, ;
		Height = 200, ;
		Left = 10, ;
		Name = "PageFrame1", ;
		PageCount = 2, ;
		Top = 10, ;
		Width = 380, ;
		Page1.Caption = "First", ;
		Page1.Name = "Page1", ;
		Page2.Caption = "Second", ;
		Page2.Name = "Page2"
	*< END OBJECT: BaseClass="pageframe" />

	ADD OBJECT 'PageFrame1.Page1.Label1' AS label WITH ;
		Caption = "on the first page", ;
		Height = 17, ;
		Left = 10, ;
		Name = "Label1", ;
		Top = 10, ;
		Width = 150
	*< END OBJECT: BaseClass="label" />

	ADD OBJECT 'PageFrame1.Page2.Label2' AS label WITH ;
		Caption = "on the second page", ;
		Height = 17, ;
		Left = 10, ;
		Name = "Label2", ;
		Top = 10, ;
		Width = 150
	*< END OBJECT: BaseClass="label" />

	ADD OBJECT 'List1' AS listbox WITH ;
		Height = 60, ;
		Left = 10, ;
		Name = "List1", ;
		RowSource = "one,two,three", ;
		RowSourceType = 1, ;
		Top = 220, ;
		Width = 200
	*< END OBJECT: BaseClass="listbox" />

ENDDEFINE
`

const file = (name) => join(work, name)
writeFileSync(file("demo.SC2"), demo)
writeFileSync(file("MYLIB.VC2"), library)
writeFileSync(file("inherited.SC2"), inherited)
writeFileSync(file("twips.SC2"), twips)
writeFileSync(file("wizard.SC2"), wizard)

// --- reading the text ------------------------------------------------------------
console.log("reading the text of a form")

{
  const classes = parseSc2(demo)
  same("the text holds both classes", classes.map((one) => one.name), ["dataenvironment", "demo"])
  same("the form is a form", classes[1].base, "form")
  same("the objects are in the order they are written", classes[1].objects.length, 9)
  same("the ZOrder is the order of the OBJECTDATA lines", classes[1].order.length, 7)
  same("the first of the ZOrder is Label1", classes[1].order[0], "Label1")
  same("the methods are noted", classes[1].procedures.map((one) => one.name), [
    "Init",
    "Command1.Click",
    "Grid1.ColOne.Text1.DblClick",
  ])
  same("a method knows what it belongs to", classes[1].procedures[2].path, ["Grid1", "ColOne", "Text1"])
  same("a method knows its event", classes[1].procedures[2].event, "DblClick")
  same("a number is a number", prop(classes[1].props, "Width"), 320)
  same("a colour stays three numbers until it is drawn", prop(classes[1].props, "BackColor"), "212,208,200")
  same("a yes is a yes", prop(classes[1].props, "ScaleMode"), 3)

  const label1 = classes[1].objects[0]
  same("a doubled quote inside a string is one quote", propText(label1.props, "Caption"), 'Name\\<:')
  const label2 = classes[1].objects[1]
  same("and the rest of that caption is kept", propText(label2.props, "Caption"), 'He said "hi" & <b>')

  // The properties of a base class can be asked for in any case, the way the
  // real text mixes them.
  same("a property is found whatever its case", propText(classes[1].props, "caption"), "Demo")
  same("a property that is not there is not invented", prop(classes[1].props, "SubClass"), undefined)
  same("a property that is not there falls back", propNumber(classes[1].props, "RowHeight", 20), 20)
  same("a property that is not there is off", propBool(classes[1].props, "WordWrap", false), false)
}

// --- the shape of the form -------------------------------------------------------
console.log("")
console.log("the form as a model")

let demoHtml = ""
{
  const models = modelsOf(file("demo.SC2"), demo)
  same("the data environment is not a form to draw", models.length, 1)
  const model = models[0]
  same("it is the form that is drawn", model.name, "demo")
  same("its size is the size of the form", [model.width, model.height], [320, 200])
  same("it draws in pixels", model.unit, 1)

  const names = model.root.children.map((child) => child.name)
  same("every control is there, and in the order it is drawn", names, [
    "Label1",
    "Label2",
    "Text1",
    "Command1",
    "Grid1",
    "Hidden1",
    "Timer1",
  ])
  const grid = model.root.children.find((child) => child.name === "Grid1")
  same("the columns of the grid are its children", grid.children.map((child) => child.name), ["ColOne", "ColTwo"])
  same("a grid column knows it is a column", grid.children[0].base, "column")
  same("a header sits in its column", grid.children[0].children.map((child) => child.name), ["Header1"])

  demoHtml = renderHtml({ file: file("demo.SC2"), text: demo, nonce: "TESTNONCE" })
}

// --- drawing it ------------------------------------------------------------------
console.log("")
console.log("the drawing")

has("the page says which file it is", demoHtml, "demo.SC2")
has("the form says which class it is", demoHtml, 'data-class="demo"')
has("a control says where it sits", demoHtml, 'data-path="Command1"')
has("the page can ask the editor for the code of a control", demoHtml, 'type: "method"')
has("the caption of the form is in the title bar", demoHtml, '<span class="cap">Demo</span>')
has("the form is drawn at its size", demoHtml, "width:320px;height:200px")
has("a control is where the text says it is", demoHtml, "left:10px;top:10px;width:60px;height:17px")
has("the accelerator of a caption is underlined", demoHtml, "Name<u>:</u>")
has("an ampersand is escaped", demoHtml, "&amp;")
has("a less than is escaped", demoHtml, "&lt;b&gt;")
has("a caption is not a way in", demoHtml, "&lt;script&gt;alert(1)&lt;/script&gt;")
hasNot("nothing of the caption runs", demoHtml, "<script>alert")
hasNot("the font family does not break the style it sits in", demoHtml, 'font-family:"')
has("the font family is quoted the other way round", demoHtml, "font-family:'Times New Roman'")
has("a text box says where its value comes from", demoHtml, "demo.name")
has("the class of a control is a class of the page", demoHtml, 'class="ctl label"')
has("a hidden control is still drawn", demoHtml, 'data-name="Hidden1"')
has("and it is drawn as a ghost", demoHtml, 'class="ctl label ghost"')
hasNot("a timer is not drawn", demoHtml, 'data-name="Timer1"')
has("the page counts what it drew", demoHtml, "5 controls")
has("and says how many are hidden", demoHtml, "1 hidden")
has("and how many it left out", demoHtml, "1 not drawn")
has("the hidden controls can be turned off", demoHtml, "data-ghost")
has("the page is allowed only what it came with", demoHtml, "script-src 'nonce-TESTNONCE'")
has("the pictures of the project are the only pictures", demoHtml, "img-src data:")

// the grid
has("a column header is drawn where the columns put it", demoHtml, "left:12px;width:120px;height:24px")
has("a header keeps its own colour", demoHtml, "background:rgb(0, 100, 0)")
has("and its own writing", demoHtml, "color:rgb(255, 255, 255)")
has("a header that is centred is centred", demoHtml, "text-align:center")
has("a header that is right is right", demoHtml, "text-align:right")
has("the caption of a header is underlined as well", demoHtml, "First<u>H</u>ead")
has("the second header of the grid is drawn", demoHtml, "Second")
hasNot("a header is not drawn twice", demoHtml, 'data-name="Header1"')
has("the grid has rows to look at", demoHtml, "grow")
has("a header says what code it has", demoHtml, 'data-path="Grid1.ColOne.Header1"')
has("and so does the text box under it", demoHtml, 'data-path="Grid1.ColOne.Text1"')

// the order of the controls in the page is the order they are drawn in
{
  const order = ["Label1", "Label2", "Text1", "Command1", "Grid1", "Hidden1"].map((name) =>
    demoHtml.indexOf(`data-name="${name}"`),
  )
  check("the controls are drawn from the back to the front", order.every((at, index) => at >= 0 && (index === 0 || at > order[index - 1])))
}

// --- what a class library gives ---------------------------------------------------
console.log("")
console.log("a form that takes what it does from a class library")

{
  const models = modelsOf(file("inherited.SC2"), inherited)
  same("it is one form", models.length, 1)
  const model = models[0]
  same("the size it gives itself wins", [model.width, model.height], [400, 200])
  same("the caption it gives itself wins", propText(model.root.props, "Caption"), "The child")

  const names = model.root.children.map((child) => child.name)
  same("the control of the class is drawn under the ones of the form", names, ["Logo", "Box1", "Go1"])

  const box = model.root.children.find((child) => child.name === "Box1")
  same("a container is a container", box.base, "container")
  same("the size of a container comes from its class", [propNumber(box.props, "Width", 0), propNumber(box.props, "Height", 0)], [100, 60])
  same("the control inside a class is drawn", box.children.map((child) => child.name), ["Inside"])

  const go = model.root.children.find((child) => child.name === "Go1")
  same("a button takes its caption from its class", propText(go.props, "Caption"), "From the class")
  same("and its size", propNumber(go.props, "Width", 0), 120)
  same("and its font", propBool(go.props, "FontBold", false), true)

  const html = renderHtml({ file: file("inherited.SC2"), text: inherited, nonce: "N" })
  has("the caption of the class is drawn", html, "From the class")
  has("the control of the class is drawn", html, "the class logo")
  has("the control inside the box of the class is drawn", html, "inside the box")
  has("the colour of the class is drawn", html, "background:rgb(255, 0, 0)")
  has("the bold of the class is drawn", html, "font-weight:700")
}

// --- a class library on its own ---------------------------------------------------
console.log("")
console.log("a class library on its own")

{
  const models = modelsOf(file("MYLIB.VC2"), library)
  same("only the class that is a form is drawn", models.map((model) => model.name), ["myform"])
  const html = renderHtml({ file: file("MYLIB.VC2"), text: library, nonce: "N" })
  has("its caption is drawn", html, "From the class")
  has("its control is drawn", html, "the class logo")
}

// --- a form drawn in twips --------------------------------------------------------
console.log("")
console.log("a form that was drawn in twips")

{
  const model = modelsOf(file("twips.SC2"), twips)[0]
  same("a twip is a fifteenth of a pixel", model.unit, 1 / 15)
  const html = renderHtml({ file: file("twips.SC2"), text: twips, nonce: "N" })
  has("the form is drawn in pixels", html, "width:300px;height:200px")
  has("so is the control", html, "left:10px;top:20px;width:100px;height:17px")
}

// --- a page frame ------------------------------------------------------------------
console.log("")
console.log("a form with a page frame")

{
  const model = modelsOf(file("wizard.SC2"), wizard)[0]
  const frame = model.root.children.find((child) => child.name === "PageFrame1")
  same("the pages of the frame are its children", frame.children.map((child) => child.name), ["Page1", "Page2"])
  same("a page knows it is a page", frame.children[0].base, "page")
  same("a page holds the controls that are on it", frame.children[0].children.map((child) => child.name), ["Label1"])
  same("and so does the other one", frame.children[1].children.map((child) => child.name), ["Label2"])

  const html = renderHtml({ file: file("wizard.SC2"), text: wizard, nonce: "N" })
  has("the tab of every page is drawn", html, ">First</span>")
  has("the tab of the open page is the open one", html, "tab on")
  has("the controls of the open page are drawn", html, "on the second page")
  hasNot("the controls of a page that is not open are not drawn", html, "on the first page")
  has("a list says what it holds", html, ">one</span>")
  has("and the rest of the list", html, ">three</span>")
  has("a tab says which page it is", html, 'data-path="PageFrame1.Page1"')
  has("the open page says which page it is", html, 'data-path="PageFrame1.Page2"')
  has("a control on a page says where it sits", html, 'data-path="PageFrame1.Page2.Label2"')
}

// --- the code of a control ---------------------------------------------------------
console.log("")
console.log("the code behind a control")

{
  const at = file("demo.SC2")
  const lines = demo.split(/\r?\n/)

  const form = methodsOf(at, demo, "demo", "")
  same("the form has the methods of the form", form.methods.map((one) => one.procedure.event), ["Init"])
  same("and the line where the code starts", lines[form.methods[0].procedure.line - 1].trim(), "PROCEDURE Init")
  same("the file the code is in is the form itself", basename(form.methods[0].file), "demo.SC2")

  const button = methodsOf(at, demo, "demo", "Command1")
  same("a control has the methods that were written on it", button.methods.map((one) => one.procedure.event), ["Click"])
  same("the name it is known by is the name on the form", button.name, "Command1")
  same("the line is the line of the PROCEDURE", lines[button.methods[0].procedure.line - 1].trim(), "PROCEDURE Command1.Click")

  const cell = methodsOf(at, demo, "demo", "Grid1.ColOne.Text1")
  same("a text box in a grid column has its methods too", cell.methods.map((one) => one.procedure.event), ["DblClick"])
  same("and the whole path is used to find them", cell.methods[0].procedure.path, ["Grid1", "ColOne", "Text1"])

  same("a control with no code has no methods", methodsOf(at, demo, "demo", "Label1").methods, [])
  same("a control that is not on the form has no methods either", methodsOf(at, demo, "demo", "Nope").methods, [])

  // A control that is an instance of a class of the project has the code of the
  // class as well, and that code is written in the class library.
  const go = methodsOf(file("inherited.SC2"), inherited, "inherited", "Go1")
  same("a control of a class has the methods of its class", go.methods.map((one) => one.procedure.event), ["Click"])
  same("and they are in the file of the class", basename(go.methods[0].file).toLowerCase(), "mylib.vc2")
  same("the class is the one the control is made from", go.cls, "mycmd")

  const inherits = methodsOf(file("inherited.SC2"), inherited, "inherited", "")
  same("a form has the methods of the class it comes from", inherits.methods.map((one) => one.procedure.event), ["Resize"])
  same("and that code is in the class library", basename(inherits.methods[0].file).toLowerCase(), "mylib.vc2")

  const own = methodsOf(at, demo, "demo", "Grid1")
  same("a grid itself has no code in this form", own.methods, [])
}

// --- what is not a form -----------------------------------------------------------
console.log("")
console.log("what cannot be drawn")

{
  const plain = renderHtml({ file: file("plain.SC2"), text: "DEFINE CLASS thing AS custom\n\tName = \"thing\"\nENDDEFINE\n", nonce: "N" })
  has("a file with no form in it says so", plain, "There is no form in this text file")
  const useless = renderNotice("the file is gone")
  has("a page can say why there is nothing to see", useless, "the file is gone")
}

rmSync(work, { recursive: true, force: true })

// --- the answer -------------------------------------------------------------------
console.log("")
if (failures.length) {
  for (const failure of failures) console.log(`  FAILED  ${failure}`)
  console.log("")
  console.log(`${passed} checks passed, ${failures.length} FAILED`)
  process.exit(1)
}
console.log(`${passed} checks passed, nothing failed.`)
