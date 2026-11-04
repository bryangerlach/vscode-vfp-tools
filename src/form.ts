import * as fs from "node:fs"
import * as path from "node:path"

/**
 * Reading a form out of its text file.
 *
 * A text file that FoxBin2Prg wrote holds a DEFINE CLASS block for the form and
 * one ADD OBJECT block for every control, with the same properties the property
 * window shows. That is enough to draw the form: where every control is, how
 * big it is, what it says, and what colour it is.
 *
 * Nothing here runs any Visual FoxPro code and nothing is executed. A property
 * that holds an expression instead of a value (Caption = "Total: " + STR(n)) is
 * drawn as the text of the expression, because what it says is only known when
 * the form runs.
 *
 * The class libraries are read as well. When a control is an instance of a
 * class of the project, the properties that it inherits are taken from the text
 * of that class, so a form of this project looks like itself: most of the
 * controls are subclasses, and the record of a subclass only holds what was
 * changed away from the class.
 */

/** What a property can hold. */
export type Value = string | number | boolean | null

/** One method of a class, and where its code starts. */
export interface Procedure {
  /** The name as the text writes it, for example "Grid1.ColACT.Text1.DblClick". */
  name: string
  /** What it belongs to: [] for the class itself, else the path of the object. */
  path: string[]
  /** The event or the method, which is the last part of the name. */
  event: string
  /** The line of the PROCEDURE line, counted from 1. */
  line: number
  /** The line of the ENDPROC line, counted from 1, or 0 when it was not seen. */
  end: number
}

/** One class of a text file: a form, or a class of a class library. */
export interface Sc2Class {
  /** The name of the class, as it was declared. */
  name: string
  /** The class it was declared as, which is itself a class or a base class. */
  as: string
  /** The class library that class comes from, when it comes from one. */
  lib?: string
  /** The base class, which is what a preview draws it as. */
  base: string
  /** Properties of the class itself. Names with a dot make child objects. */
  props: Map<string, Value>
  /** The objects that were added to it. */
  objects: RawObject[]
  /** The paths of the objects, in the order they are drawn (the ZOrder). */
  order: string[]
  /** The methods that have code, and where they are. */
  procedures: Procedure[]
  /** The line of the DEFINE CLASS line, counted from 1. */
  line: number
  /** The line of the ENDDEFINE line, counted from 1, or the last line. */
  end: number
}

/** One ADD OBJECT block, before it is put in its place in the tree. */
export interface RawObject {
  /** "Grid1.ColACT.Header1" is ["Grid1", "ColACT", "Header1"]. */
  path: string[]
  /** The class it is an instance of. */
  as: string
  /** The base class, from the comment that ends the block. */
  base: string
  /** The class library, when the class comes from one. */
  lib?: string
  props: Map<string, Value>
}

/** An object of a form, after everything it inherits is in place. */
export interface FormObject {
  /** The name it is held under, for example Column1. */
  member: string
  /** The Name property, for example ColACT. */
  name: string
  /** The class it is. */
  cls: string
  /** The base class, which is what it is drawn as. */
  base: string
  /** The class library that class comes from, when it comes from one. */
  lib?: string
  props: Map<string, Value>
  children: FormObject[]
}

/** A class of a text file, ready to be drawn. */
export interface PreviewModel {
  name: string
  cls: string
  /** The class library the class comes from, when it comes from one. */
  lib?: string
  base: string
  root: FormObject
  /** The width and the height of the form itself, in pixels. */
  width: number
  height: number
  /** What one unit of the text file is worth, in pixels. */
  unit: number
}

/** The base classes that a form can be drawn from. */
const FORM_CLASSES = new Set(["form", "formset"])

/** The base classes that a preview knows how to draw. */
const DRAWABLE = new Set([
  "form",
  "formset",
  "container",
  "pageframe",
  "page",
  "grid",
  "column",
  "commandgroup",
  "optiongroup",
  "commandbutton",
  "optionbutton",
  "label",
  "textbox",
  "editbox",
  "combobox",
  "listbox",
  "checkbox",
  "spinner",
  "shape",
  "line",
  "image",
  "olecontrol",
  "header",
  "separator",
])

/** The base classes that are a part of Visual FoxPro, not of a project. */
const BASE_CLASSES = new Set([
  ...DRAWABLE,
  "dataenvironment",
  "cursor",
  "relation",
  "timer",
  "custom",
  "control",
  "hyperlink",
  "collection",
  "exception",
  "datasession",
])

/** A size that a browser can draw, without letting a bad number break it. */
export function sizeOf(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(20000, value))
}

/**
 * The classes of a text file, in the order they are in it.
 *
 * FoxBin2Prg writes one property per line and ends a line with a semicolon when
 * the block goes on. The method code is between PROCEDURE and ENDPROC and is
 * not read, because a preview does not run anything.
 */
export function parseSc2(text: string): Sc2Class[] {
  const classes: Sc2Class[] = []
  let cls: Sc2Class | undefined
  let object: RawObject | undefined
  let inProcedure = false
  let number = 0

  for (const raw of text.split(/\r?\n/)) {
    number++
    const line = raw.trim()
    if (!line) continue

    if (inProcedure) {
      if (/^END(PROC|FUNC)\b/i.test(line)) {
        inProcedure = false
        if (cls && cls.procedures.length) {
          const last = cls.procedures[cls.procedures.length - 1]
          if (!last.end) last.end = number
        }
      }
      continue
    }
    if (/^PROCEDURE\s/i.test(line)) {
      inProcedure = true
      if (cls) {
        // The name is the method, and everything in front of the last part is
        // the object it is a method of. A name with no dot is a method of the
        // class itself.
        const name = line.replace(/^PROCEDURE\s+/i, "").trim()
        const parts = name.split(".")
        cls.procedures.push({
          name,
          path: parts.slice(0, -1),
          event: parts[parts.length - 1],
          line: number,
          end: 0,
        })
      }
      continue
    }

    if (/^ENDDEFINE\b/i.test(line)) {
      if (cls) cls.end = number
      cls = undefined
      object = undefined
      continue
    }

    const defines = /^DEFINE\s+CLASS\s+(\S+)\s+AS\s+(\S+?)(?:\s+OF\s+"([^"]*)")?\s*$/i.exec(line)
    if (defines) {
      cls = {
        name: defines[1],
        as: defines[2],
        lib: defines[3],
        base: defines[2].toLowerCase(),
        props: new Map(),
        objects: [],
        order: [],
        procedures: [],
        line: number,
        end: 0,
      }
      classes.push(cls)
      object = undefined
      continue
    }
    if (!cls) continue

    // The comment that says what the class really is, and in what scale the
    // numbers were written.
    if (/^\*<\s*CLASSDATA:/i.test(line)) {
      const base = /Baseclass="([^"]*)"/i.exec(line)
      if (base) cls.base = base[1].toLowerCase()
      continue
    }
    // The order of the objects is the order they are drawn in.
    if (/^\*<\s*OBJECTDATA:/i.test(line)) {
      const one = /ObjPath="([^"]*)"/i.exec(line)
      if (one) cls.order.push(one[1])
      continue
    }

    const adds = /^ADD\s+OBJECT\s+'([^']*)'\s+AS\s+(\S+?)(?:\s+OF\s+"([^"]*)")?(?:\s+WITH\b)?\s*;?\s*$/i.exec(line)
    if (adds) {
      object = {
        path: adds[1].split("."),
        as: adds[2],
        base: adds[2].toLowerCase(),
        lib: adds[3],
        props: new Map(),
      }
      cls.objects.push(object)
      continue
    }
    // The end of an object block says what base class it is, which is what
    // tells a preview how to draw it.
    if (/^\*<\s*END\s+OBJECT:/i.test(line)) {
      if (object) {
        const base = /BaseClass="([^"]*)"/i.exec(line)
        const lib = /ClassLib="([^"]*)"/i.exec(line)
        if (base) object.base = base[1].toLowerCase()
        if (lib) object.lib = lib[1]
      }
      object = undefined
      continue
    }
    if (line.startsWith("*")) continue

    if (object) {
      assign(object.props, line)
    } else {
      assign(cls.props, line)
    }
  }

  // A class that was not closed by ENDDEFINE runs to the end of the file, and a
  // method that was not closed by ENDPROC runs to the next one or to the end of
  // its class. FoxBin2Prg writes both ends, so this is only for a hand-written
  // text file.
  for (const one of classes) {
    if (!one.end) one.end = number
    one.procedures.forEach((procedure, index) => {
      if (procedure.end) return
      procedure.end = index + 1 < one.procedures.length ? one.procedures[index + 1].line - 1 : one.end
    })
  }

  return classes
}

/** Reads one `Name = value` line into the properties. */
function assign(props: Map<string, Value>, line: string): void {
  const at = line.indexOf("=")
  if (at < 1) return
  const name = line.slice(0, at).trim()
  // A property name is a name, or a path to a child object of it.
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(name)) return
  props.set(name, valueOf(line.slice(at + 1)))
}

/** The value of a property, as it was written. */
function valueOf(raw: string): Value {
  let text = raw.trim()
  // A line that goes on ends with a semicolon, and one property is separated
  // from the next by a comma.
  if (text.endsWith(";")) text = text.slice(0, -1).trimEnd()
  if (text.endsWith(",")) text = text.slice(0, -1).trimEnd()

  if (/^\.T\.$/i.test(text)) return true
  if (/^\.F\.$/i.test(text)) return false
  if (/^\.NULL\.$/i.test(text)) return null
  if (/^[-+]?\d+$/.test(text)) return Number(text)
  if (/^[-+]?\d*\.\d+$/.test(text)) return Number(text)

  const quote = text[0]
  if ((quote === '"' || quote === "'") && text.length > 1 && text.endsWith(quote)) {
    // A quote inside a string is written twice.
    return text.slice(1, -1).split(quote + quote).join(quote)
  }
  // A colour is written as three numbers with commas, and anything else that
  // is not a value is left as it was written.
  return text
}

/** A property of an object, whatever its case. */
export function prop(props: Map<string, Value>, name: string): Value | undefined {
  const exact = props.get(name)
  if (exact !== undefined) return exact
  const lower = name.toLowerCase()
  for (const [key, value] of props) if (key.toLowerCase() === lower) return value
  return undefined
}

/** A property as text. */
export function propText(props: Map<string, Value>, name: string, fallback = ""): string {
  const value = prop(props, name)
  if (value === undefined || value === null) return fallback
  if (typeof value === "boolean") return value ? ".T." : ".F."
  return String(value)
}

/** A property as a number. */
export function propNumber(props: Map<string, Value>, name: string, fallback: number): number {
  const value = prop(props, name)
  if (typeof value === "number") return value
  if (typeof value === "string") {
    const number = Number(value.replace(",", "."))
    if (Number.isFinite(number)) return number
  }
  return fallback
}

/** A property as a yes or a no. */
export function propBool(props: Map<string, Value>, name: string, fallback: boolean): boolean {
  const value = prop(props, name)
  if (typeof value === "boolean") return value
  if (typeof value === "number") return value !== 0
  if (typeof value === "string") {
    const text = value.trim().toLowerCase()
    if (text === ".t." || text === "true" || text === "1") return true
    if (text === ".f." || text === "false" || text === "0") return false
  }
  return fallback
}

/**
 * The classes of a text file that are worth drawing.
 *
 * A form is what a .SC2 file holds, and it is drawn when there is one. A .VC2
 * file can hold many classes, and then the ones that are a form or a container
 * are drawn, because those are the ones with a picture to them.
 */
export function modelsOf(file: string, text: string): PreviewModel[] {
  const folder = path.dirname(file)
  const classes = parseSc2(text)
  const cache = new Map<string, Sc2Class[]>()

  const forms = classes.filter((one) => FORM_CLASSES.has(one.base))
  const roots = forms.length ? forms : classes.filter((one) => DRAWABLE.has(one.base) && one.base !== "column")
  const models: PreviewModel[] = []

  for (const cls of roots.slice(0, 24)) {
    const root = buildRoot(cls, folder, cache)
    const scaleMode = propNumber(cls.props, "ScaleMode", 3)
    models.push({
      name: cls.name,
      cls: cls.as,
      lib: cls.lib,
      base: cls.base,
      root,
      width: propNumber(root.props, "Width", 300),
      height: propNumber(root.props, "Height", 250),
      // A form that is in twips draws in twips; the rest is pixels.
      unit: scaleMode === 0 ? 1 / 15 : 1,
    })
  }
  return models
}

/** The form, with everything it inherits from its class in place. */
function buildRoot(
  cls: Sc2Class,
  folder: string,
  cache: Map<string, Sc2Class[]>,
  depth = 0,
  seen = new Set<string>(),
): FormObject {
  const root: FormObject = {
    member: cls.name,
    name: cls.name,
    cls: cls.as,
    lib: cls.lib,
    base: cls.base,
    props: new Map(cls.props),
    children: [],
  }
  applyDotted(root)
  for (const raw of cls.objects) attach(root, raw, folder, cache)
  sortTree(root, "", cls.order)
  const ancestor = templateOf(cls.as, cls.lib, folder, cache, depth, seen)
  if (ancestor) mergeTemplate(root, ancestor)
  return root
}

/** Puts one ADD OBJECT block in its place in the tree. */
function attach(
  root: FormObject,
  raw: RawObject,
  folder: string,
  cache: Map<string, Sc2Class[]>,
): void {
  let node = root
  for (const part of raw.path) {
    let child = childOf(node, part)
    if (!child) {
      child = {
        member: part,
        name: part,
        cls: "",
        base: inferredBase(node),
        props: new Map(),
        children: [],
      }
      node.children.push(child)
    }
    node = child
  }
  node.cls = raw.as
  if (raw.lib) node.lib = raw.lib
  if (raw.base) node.base = raw.base
  for (const [key, value] of raw.props) node.props.set(key, value)
  applyDotted(node)
  node.name = propText(node.props, "Name", node.member)
  // A control that is an instance of a class of the project only holds what
  // was changed in it, so the rest comes from the class.
  const ancestor = templateOf(raw.as, raw.lib, folder, cache)
  if (ancestor) mergeTemplate(node, ancestor)
}

/** Turns `Column1.Width = 150` into a child object with that width. */
function applyDotted(node: FormObject): void {
  for (const [key, value] of [...node.props]) {
    if (!key.includes(".")) continue
    node.props.delete(key)
    const parts = key.split(".")
    let parent = node
    for (const part of parts.slice(0, -1)) {
      let child = childOf(parent, part)
      if (!child) {
        child = {
          member: part,
          name: part,
          cls: "",
          base: inferredBase(parent),
          props: new Map(),
          children: [],
        }
        parent.children.push(child)
      }
      parent = child
    }
    parent.props.set(parts[parts.length - 1], value)
    parent.name = propText(parent.props, "Name", parent.member)
  }
}

/** A child by the name it is held under, or by its Name property. */
function childOf(parent: FormObject, part: string): FormObject | undefined {
  const lower = part.toLowerCase()
  return parent.children.find(
    (child) => child.member.toLowerCase() === lower || child.name.toLowerCase() === lower,
  )
}

/** What a child object is, when the text only gives it a name. */
function inferredBase(parent: FormObject): string {
  switch (parent.base) {
    case "grid":
      return "column"
    case "pageframe":
      return "page"
    case "commandgroup":
      return "commandbutton"
    case "optiongroup":
      return "optionbutton"
    default:
      return "container"
  }
}

/** The properties and the objects a class gives to the ones that use it. */
interface Template {
  props: Map<string, Value>
  children: FormObject[]
}

/**
 * What a class adds to the base class it is made from.
 *
 * A control that is an instance of a class of the project only holds what was
 * changed in it, so the rest has to come from the class itself. A class can be
 * made from another class, and the text of a class library holds the whole
 * chain, so it is followed to the bottom.
 */
function templateOf(
  clsName: string,
  lib: string | undefined,
  folder: string,
  cache: Map<string, Sc2Class[]>,
  depth = 0,
  seen = new Set<string>(),
): Template | undefined {
  const lower = clsName.toLowerCase()
  if (BASE_CLASSES.has(lower) || !lib || depth > 4) return undefined

  const binary = path.isAbsolute(lib) ? lib : path.join(folder, lib)
  const key = `${binary.toLowerCase()}#${lower}`
  if (seen.has(key)) return undefined

  const classes = classesOf(binary, cache)
  const cls = classes?.find((one) => one.name.toLowerCase() === lower)
  if (!cls) return undefined

  const next = new Set(seen).add(key)
  const own = buildRoot(cls, path.dirname(binary), cache, depth + 1, next)
  const base = templateOf(cls.as, cls.lib, path.dirname(binary), cache, depth + 1, next)
  if (base) mergeTemplate(own, base)
  return { props: own.props, children: own.children }
}

/** The classes of the text file that holds a class library. */
function classesOf(binary: string, cache: Map<string, Sc2Class[]>): Sc2Class[] | undefined {
  const lower = binary.toLowerCase()
  const known = cache.get(lower)
  if (known) return known
  const file = classTextFile(binary)
  const text = file === undefined ? undefined : readText(file)
  if (text === undefined) return undefined
  const classes = parseSc2(text)
  cache.set(lower, classes)
  return classes
}

/** The text file of a class library, when it is there. */
function classTextFile(binary: string): string | undefined {
  for (const name of [binary.replace(/\.vcx$/i, ".VC2"), binary.replace(/\.vcx$/i, ".vc2")]) {
    try {
      if (fs.existsSync(name)) return name
    } catch {
      // A file that cannot be read is treated as one that is not there.
    }
  }
  return undefined
}

/** The text of a file, or nothing when it cannot be read. */
function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

/** One class of the chain that a class is made of, and the file it is in. */
export interface ClassIn {
  file: string
  cls: Sc2Class
}

/**
 * The classes a class is made of, from the class itself to the base class.
 *
 * The methods of a control are not always in the file of the form: a form can be
 * made from a class of a class library, and that class from another class of
 * another library, and the method can be written anywhere along that chain.
 * The text of the file that is open, if it is given, is used instead of the file
 * on the disk, so that what is shown is what is being edited.
 */
export function ancestryOf(file: string, clsName: string, text?: string): ClassIn[] {
  const chain: ClassIn[] = []
  const seen = new Set<string>()
  // A class is asked for by the file it is in, which is the text file of the
  // form, or the binary of a class library; the text of a library is found from
  // its binary.
  let at = { file: text === undefined ? (classTextFile(file) ?? file) : file, name: clsName }
  let known = text

  while (chain.length < 6) {
    const key = `${path.resolve(at.file).toLowerCase()}#${at.name.toLowerCase()}`
    if (seen.has(key)) break
    seen.add(key)

    const body = known ?? readText(at.file)
    if (body === undefined) break
    const cls = parseSc2(body).find((one) => one.name.toLowerCase() === at.name.toLowerCase())
    if (!cls) break
    chain.push({ file: at.file, cls })

    if (!cls.lib || BASE_CLASSES.has(cls.as.toLowerCase())) break
    const binary = path.isAbsolute(cls.lib) ? cls.lib : path.join(path.dirname(at.file), cls.lib)
    const next = classTextFile(binary)
    if (!next) break
    at = { file: next, name: cls.as }
    known = undefined
  }

  return chain
}

/** Puts what a class gives on top of the object that uses it. */
function mergeTemplate(into: FormObject, template: Template): void {
  for (const [key, value] of template.props) {
    if (prop(into.props, key) === undefined) into.props.set(key, value)
  }
  const inherited = template.children
    .filter((child) => !childOf(into, child.member) && !childOf(into, child.name))
    .map(cloneObject)
  // The controls that come from the class are drawn under the ones that were
  // added to the form itself.
  into.children = [...inherited, ...into.children]
  for (const child of template.children) {
    const mine = childOf(into, child.member) ?? childOf(into, child.name)
    if (mine) mergeTemplate(mine, { props: child.props, children: child.children })
  }
}

/** A copy of an object, so that a class can be used more than once. */
function cloneObject(obj: FormObject): FormObject {
  return {
    member: obj.member,
    name: obj.name,
    cls: obj.cls,
    lib: obj.lib,
    base: obj.base,
    props: new Map(obj.props),
    children: obj.children.map(cloneObject),
  }
}

/** The object at a path of names, if there is one. */
function objectAt(root: FormObject, parts: string[]): FormObject | undefined {
  let node: FormObject | undefined = root
  for (const part of parts) {
    const lower = part.toLowerCase()
    node = node?.children.find((child) => child.name.toLowerCase() === lower)
    if (!node) return undefined
  }
  return node
}

/** A method of an object, and the file its code is in. */
export interface MethodIn {
  file: string
  procedure: Procedure
}

/** What a click on an object comes to. */
export interface MethodLookup {
  /** The name of the object, as the form knows it. */
  name: string
  /** The class it is. */
  cls: string
  /** The class library that class comes from, when it comes from one. */
  lib?: string
  /** The methods of it, in the order they are written. */
  methods: MethodIn[]
}

/**
 * The methods of one object of a form, and where their code is.
 *
 * The methods of the form itself have a name with no dot in it (Init, Load),
 * and the methods of a control start with the path of the control
 * (cmdList.Click, Grid1.ColACT.Text1.DblClick). A control that is an instance
 * of a class of the project also has the code of the class, which can be in a
 * class library of its own, so that is looked at as well.
 */
export function methodsOf(file: string, text: string, clsName: string, at: string): MethodLookup {
  const models = modelsOf(file, text)
  const model = models.find((one) => one.name.toLowerCase() === clsName.toLowerCase()) ?? models[0]
  const parts = at ? at.split(".") : []
  if (!model) return { name: at || clsName, cls: "", methods: [] }

  const obj = parts.length ? objectAt(model.root, parts) : model.root
  const name = obj?.name ?? (at || model.name)
  const cls = obj?.cls ?? model.cls
  const lib = obj?.lib

  const methods: MethodIn[] = []
  const seen = new Set<string>()
  const take = (chain: ClassIn[], wanted: string) => {
    for (const one of chain) {
      for (const procedure of one.cls.procedures) {
        if (procedure.path.join(".").toLowerCase() !== wanted) continue
        // A method that is written again down the chain is only the one that is
        // nearest, and that is the first that is met.
        const key = `${one.file.toLowerCase()}#${procedure.name.toLowerCase()}`
        if (seen.has(key)) continue
        seen.add(key)
        methods.push({ file: one.file, procedure })
      }
    }
  }

  // What was written on the form belongs to the object by the path of the object.
  take(ancestryOf(file, model.name, text), parts.join(".").toLowerCase())
  // An instance of a class of the project also has the code of the class, which
  // is written without a path in the file of the class library.
  if (parts.length > 0 && lib && cls !== "") {
    const binary = path.isAbsolute(lib) ? lib : path.join(path.dirname(file), lib)
    take(ancestryOf(binary, cls), "")
  }

  return { name, cls, lib, methods }
}

/** Sorts the children in the order they are drawn. */
function sortTree(node: FormObject, prefix: string, order: string[]): void {
  const rank = new Map<string, number>()
  order.forEach((one, index) => rank.set(one.toLowerCase(), index))
  const pathOf = (name: string) => (prefix ? `${prefix}.${name}` : name).toLowerCase()
  const indexOf = (child: FormObject) =>
    rank.get(pathOf(child.name)) ?? rank.get(pathOf(child.member)) ?? Number.MAX_SAFE_INTEGER

  node.children.sort((one, two) => indexOf(one) - indexOf(two))
  for (const child of node.children) sortTree(child, pathOf(child.name), order)
}
