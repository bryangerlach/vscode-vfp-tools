import * as fs from "node:fs"
import * as path from "node:path"
import {
  FormObject,
  PreviewModel,
  modelsOf,
  prop,
  propBool,
  propNumber,
  propText,
  sizeOf,
} from "./form"

/**
 * Drawing a form out of the text file.
 *
 * The properties of a form are the same ones the property window shows, so a
 * form can be drawn without Visual FoxPro: a control is a box at Left, Top of
 * its size, with its caption in it, in its own font and colours. The children
 * of a container are drawn inside it, in the order the form draws them.
 *
 * It is a picture of the design, not of the running form. A property that holds
 * an expression is shown as it is written, because what it comes to is only
 * known when the form runs, and a picture that cannot be found is left out.
 *
 * Everything is a plain document with no access to the file system, so the
 * only things that reach the page are the text of the form and the pictures
 * that were read into it.
 */

/** The size a control is drawn at when the text file does not say. */
const DEFAULT_SIZE: Record<string, [number, number]> = {
  form: [300, 250],
  formset: [300, 250],
  container: [100, 100],
  pageframe: [200, 120],
  page: [200, 100],
  grid: [200, 120],
  column: [100, 20],
  commandgroup: [100, 30],
  optiongroup: [100, 24],
  commandbutton: [100, 27],
  label: [100, 17],
  textbox: [100, 23],
  editbox: [100, 70],
  combobox: [100, 24],
  listbox: [100, 120],
  checkbox: [100, 17],
  optionbutton: [100, 17],
  spinner: [100, 23],
  shape: [100, 100],
  line: [100, 0],
  image: [100, 100],
  olecontrol: [100, 100],
  header: [100, 20],
  separator: [100, 5],
}

/** The colour a control has when the text file does not say. */
const DEFAULT_BACK: Record<string, string> = {
  form: "#d4d0c8",
  formset: "#d4d0c8",
  container: "#d4d0c8",
  pageframe: "#d4d0c8",
  page: "#d4d0c8",
  grid: "#ffffff",
  commandgroup: "#d4d0c8",
  optiongroup: "#d4d0c8",
  commandbutton: "#f0f0f0",
  label: "transparent",
  textbox: "#ffffff",
  editbox: "#ffffff",
  combobox: "#ffffff",
  listbox: "#ffffff",
  checkbox: "transparent",
  optionbutton: "transparent",
  spinner: "#ffffff",
  shape: "transparent",
  image: "transparent",
  olecontrol: "#f0f0f0",
}

/** How many controls were drawn, hidden, or left out. */
interface Counts {
  drawn: number
  hidden: number
  skipped: number
}

/** The pictures that were already read, as data, so that they cost once. */
type Pictures = Map<string, string | undefined>

/** The page, for a file that is open in the preview. */
export function renderHtml(options: { file: string; text: string; nonce: string }): string {
  const name = path.basename(options.file)
  let models: PreviewModel[] = []
  let trouble: string | undefined
  try {
    models = modelsOf(options.file, options.text)
  } catch (error) {
    trouble = error instanceof Error ? error.message : String(error)
  }

  if (trouble) {
    return page(name, "", `<p class="trouble">The text file could not be read: ${escapeHtml(trouble)}</p>`, options.nonce)
  }
  if (!models.length) {
    return page(
      name,
      "",
      `<p class="trouble">There is no form in this text file. Only a form or a class library that holds one can be drawn.</p>`,
      options.nonce,
    )
  }

  const pictures: Pictures = new Map()
  let hidden = 0
  const sections = models
    .map((model) => {
      const counts: Counts = { drawn: 0, hidden: 0, skipped: 0 }
      const body = renderForm(model, pictures, counts, options.file)
      hidden += counts.hidden
      const details = [`${counts.drawn} control${counts.drawn === 1 ? "" : "s"}`]
      if (counts.hidden) details.push(`${counts.hidden} hidden`)
      if (counts.skipped) details.push(`${counts.skipped} not drawn`)
      const about = `${model.width} × ${model.height}  ·  ${details.join("  ·  ")}`
      return [
        `<section>`,
        `<h2>${escapeHtml(model.name)} <span class="what">${escapeHtml(model.base)}${model.cls ? ` · ${escapeHtml(model.cls)}` : ""}</span></h2>`,
        `<p class="about">${escapeHtml(about)}</p>`,
        body,
        `</section>`,
      ].join("")
    })
    .join("")

  return page(name, `${models.length} form${models.length === 1 ? "" : "s"}`, sections, options.nonce, hidden > 0)
}

/** A page that says why there is nothing to see. */
export function renderNotice(message: string): string {
  return page("Form preview", "", `<p class="trouble">${escapeHtml(message)}</p>`, "vfp", false)
}

/** The whole document. */
function page(name: string, detail: string, body: string, nonce: string, ghosts = false): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>${escapeHtml(name)}</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <span class="name">${escapeHtml(name)}</span>
  <span class="detail">${escapeHtml(detail)}</span>
  <span class="spacer"></span>
  ${ghosts ? `<button data-ghost="1" class="on" title="Controls that are hidden when the form runs">Hidden</button>` : ""}
  <button data-zoom="fit" class="on">Fit</button>
  <button data-zoom="one">100%</button>
</header>
<main>
${body}
<p class="foot">Drawn from the text file. Nothing was run. Click a control for its code.</p>
</main>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`
}

/** One form, with its title bar and its client area. */
function renderForm(model: PreviewModel, pictures: Pictures, counts: Counts, file: string): string {
  const folder = path.dirname(file)
  const width = sizeOf(model.width) * model.unit
  const height = sizeOf(model.height) * model.unit
  const isWindow = model.base === "form" || model.base === "formset"
  const inside = renderChildren(model.root, model.unit, pictures, counts, folder, "")
  // The name of the class is what says which of them a control belongs to.
  const holder = `<div class="holder" data-class="${escapeAttr(model.name)}">`

  if (!isWindow) {
    // A class library holds classes that are not a window, and a container is
    // drawn as what it is.
    const box = renderObject(model.root, model.unit, pictures, counts, folder, "")
    return `${holder}${box}</div>`
  }

  const titleBar = propBool(model.root.props, "TitleBar", true)
  const caption = captionOf(model.root)
  const border = propNumber(model.root.props, "BorderStyle", 3) !== 0
  const controlBox = propBool(model.root.props, "ControlBox", true)
  const maximize = propBool(model.root.props, "MaxButton", true)
  const minimize = propBool(model.root.props, "MinButton", true)
  const buttons = [
    minimize ? `<i>&#150;</i>` : "",
    maximize ? `<i>&#9633;</i>` : "",
    controlBox ? `<i>&#215;</i>` : "",
  ].join("")
  const back = backgroundOf(model.root)

  return [
    holder,
    `<div class="window${border ? "" : " noborder"}" data-w="${round(width + 2)}">`,
    titleBar ? `<div class="titlebar"><span class="cap">${escapeHtml(caption)}</span><span class="sys">${buttons}</span></div>` : "",
    `<div class="client" data-path="" style="width:${px(width)};height:${px(height)};${back}">${inside}</div>`,
    `</div>`,
    `</div>`,
  ].join("")
}

/** Everything inside an object, in the order it is drawn. */
function renderChildren(
  parent: FormObject,
  unit: number,
  pictures: Pictures,
  counts: Counts,
  folder: string,
  prefix: string,
): string {
  return parent.children
    .map((child) => renderObject(child, unit, pictures, counts, folder, join(prefix, child.name)))
    .join("")
}

/** One control. */
function renderObject(
  obj: FormObject,
  unit: number,
  pictures: Pictures,
  counts: Counts,
  folder: string,
  at: string,
): string {
  // A column and a page are placed by the grid or the page frame, and a header
  // only means something inside a grid.
  if (obj.base === "column" || obj.base === "page" || obj.base === "header" || obj.base === "separator") {
    return ""
  }
  const visible = propBool(obj.props, "Visible", true)
  if (STRUCTURE.has(obj.base)) {
    if (visible) counts.skipped++
    return ""
  }
  // A control that is hidden when the form runs is still a part of the design,
  // so it is drawn as a ghost, the way the designer shows it.
  if (visible) counts.drawn++
  else counts.hidden++
  const ghost = visible ? "" : " ghost"

  const style = `${geometry(obj, unit)}${fontOf(obj)}${backgroundOf(obj)}${colorOf(obj)}${dimOf(obj)}`
  const title = `${obj.name} (${obj.base})  ${propNumber(obj.props, "Left", 0)},${propNumber(obj.props, "Top", 0)}  ${propNumber(obj.props, "Width", 0)}×${propNumber(obj.props, "Height", 0)}  --  click for its code`
  const attr = ` class="ctl ${obj.base}${ghost}" data-name="${escapeAttr(obj.name)}" data-path="${escapeAttr(at)}" title="${escapeAttr(title)}"`
  const inside = () => renderChildren(obj, unit, pictures, counts, folder, at)

  switch (obj.base) {
    case "container":
    case "olecontrol": {
      const frame = obj.base === "olecontrol" ? FRAME_INSET : frameOf(obj)
      const ole = obj.base === "olecontrol"
        ? `<div class="ole">${escapeHtml(propText(obj.props, "OLEClass", propText(obj.props, "Class", "OLE")))}</div>`
        : ""
      return `<div${attr} style="${style}${frame}${alignOf(obj)}">${ole}${inside()}</div>`
    }

    case "commandgroup":
    case "optiongroup": {
      return `<div${attr} style="${style}${frameOf(obj)}">${inside()}</div>`
    }

    case "pageframe":
      return renderPageFrame(obj, unit, pictures, counts, folder, style, attr, at)

    case "grid":
      return renderGrid(obj, unit, style, attr, at)

    case "label": {
      const wrap = propBool(obj.props, "WordWrap", false)
      return `<div${attr} style="${style}${alignOf(obj)}${wrap ? "white-space:pre-wrap;word-break:break-word;" : "white-space:nowrap;"}">${captionHtml(captionOf(obj))}</div>`
    }

    case "textbox":
    case "spinner": {
      const text = textboxContent(obj)
      const spinner = obj.base === "spinner" ? `<span class="spin"><i></i><i></i></span>` : ""
      return `<div${attr} style="${style}${boxOf(obj)}${alignOf(obj)}"><span class="${text.muted ? "muted" : ""}">${text.html}</span>${spinner}</div>`
    }

    case "editbox": {
      const text = textboxContent(obj)
      const bars = propNumber(obj.props, "ScrollBars", 0) > 0 ? `<span class="vbar"></span>` : ""
      return `<div${attr} style="${style}${boxOf(obj)}align-items:flex-start;white-space:pre-wrap;word-break:break-word;">${text.html}${bars}</div>`
    }

    case "combobox": {
      const text = textboxContent(obj)
      const arrow = propNumber(obj.props, "Style", 0) === 2 ? "" : text.html
      return `<div${attr} style="${style}${boxOf(obj)}"><span class="${text.muted ? "muted" : ""}">${arrow}</span><span class="drop"><i></i></span></div>`
    }

    case "listbox": {
      const items = listItems(obj)
      const rows = items.length
        ? items.map((one) => `<span class="item">${escapeHtml(one)}</span>`).join("")
        : `<span class="item">&nbsp;</span><span class="item">&nbsp;</span><span class="item">&nbsp;</span>`
      const bars = propNumber(obj.props, "ScrollBars", 0) !== 0 ? `<span class="vbar"></span>` : ""
      return `<div${attr} style="${style}${boxOf(obj)}flex-direction:column;align-items:stretch;">${rows}${bars}</div>`
    }

    case "checkbox": {
      const on = propBool(obj.props, "Value", false)
      return `<div${attr} style="${style}display:flex;align-items:center;gap:4px;white-space:nowrap;"><span class="tick${on ? " on" : ""}"></span><span>${captionHtml(captionOf(obj))}</span></div>`
    }

    case "optionbutton": {
      const on = propBool(obj.props, "Value", false)
      return `<div${attr} style="${style}display:flex;align-items:center;gap:4px;white-space:nowrap;"><span class="dot${on ? " on" : ""}"></span><span>${captionHtml(captionOf(obj))}</span></div>`
    }

    case "commandbutton":
      return renderButton(obj, style, attr, pictures, folder)

    case "shape": {
      const curvature = propNumber(obj.props, "Curvature", 0)
      const effect = propNumber(obj.props, "SpecialEffect", 0)
      const fill = propNumber(obj.props, "FillStyle", 0) === 1
        ? color(prop(obj.props, "FillColor")) ?? color(prop(obj.props, "BackColor")) ?? "transparent"
        : "transparent"
      const edge = color(prop(obj.props, "BorderColor")) ?? "#808080"
      const round = curvature ? `border-radius:${Math.min(50, curvature)}%;` : ""
      const bevel = effect === 0 && !curvature
        ? "box-shadow:inset 1px 1px 0 #fff,inset -1px -1px 0 #808080;border:1px solid #b0b0b0;"
        : `border:1px solid ${edge};`
      return `<div${attr} style="${style}background:${fill};${round}${bevel}"></div>`
    }

    case "line": {
      const slant = propBool(obj.props, "LineSlant", false)
      const edge = color(prop(obj.props, "BorderColor")) ?? "#808080"
      const width = sizeOf(propNumber(obj.props, "Width", 100)) * unit
      const height = sizeOf(propNumber(obj.props, "Height", 0)) * unit
      const line = slant
        ? `<line x1="0" y1="${round(height)}" x2="${round(width)}" y2="0" stroke="${edge}" stroke-width="1"/>`
        : `<line x1="0" y1="0.5" x2="${round(width)}" y2="0.5" stroke="${edge}" stroke-width="1"/>`
      return `<div${attr} style="${style.replace(/height:[^;]+;/, "height:1px;")}"><svg width="${round(width)}" height="${round(Math.max(1, height))}" style="display:block;overflow:visible">${line}</svg></div>`
    }

    case "image": {
      const picture = pictureOf(obj, pictures, folder)
      const stretch = propNumber(obj.props, "Stretch", 1)
      const fit = stretch === 0 ? "none" : stretch === 2 ? "fill" : "contain"
      const picture2 = picture
        ? `<img src="${picture}" style="width:100%;height:100%;object-fit:${fit};display:block" alt="">`
        : `<span class="nopic">${escapeHtml(path.basename(propText(obj.props, "Picture", "no picture")))}</span>`
      return `<div${attr} style="${style}display:flex;align-items:center;justify-content:center;">${picture2}</div>`
    }

    default:
      return `<div${attr} style="${style}${boxOf(obj)}"><span class="muted">${escapeHtml(obj.base)}</span></div>`
  }
}

/** A command button, with its picture when it has one. */
function renderButton(
  obj: FormObject,
  style: string,
  attr: string,
  pictures: Pictures,
  folder: string,
): string {
  const picture = pictureOf(obj, pictures, folder)
  const caption = captionOf(obj)
  const flat = propNumber(obj.props, "SpecialEffect", 0) === 1
  const enabled = propBool(obj.props, "Enabled", true)
  const height = sizeOf(propNumber(obj.props, "Height", 27))
  const pictureFirst = picture && height > 34
  const inner = picture
    ? `<img src="${picture}" style="max-width:80%;max-height:${pictureFirst ? "60%" : "80%"};object-fit:contain" alt="">${pictureFirst && caption ? `<span class="under">${captionHtml(caption)}</span>` : ""}`
    : `<span>${captionHtml(caption)}</span>`
  return `<div${attr} style="${style}${flat ? "flat" : ""}display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;padding:1px;${enabled ? "" : "color:#8a8a8a;"}">${inner}</div>`
}

/** A page frame draws its tabs and the page that is open. */
function renderPageFrame(
  obj: FormObject,
  unit: number,
  pictures: Pictures,
  counts: Counts,
  folder: string,
  style: string,
  attr: string,
  at: string,
): string {
  const pages = obj.children.filter((child) => child.base === "page")
  const active = Math.max(1, Math.round(propNumber(obj.props, "ActivePage", 1)))
  const tabs = propBool(obj.props, "Tabs", true)
  const tabHeight = tabs ? 22 : 4

  if (!pages.length) {
    return `<div${attr} style="${style}${FRAME_INSET}"></div>`
  }

  const open = pages[Math.min(pages.length, active) - 1]
  let left = 2
  const tabsHtml = tabs
    ? pages
        .map((page, index) => {
          const caption = captionOf(page) || `Page${index + 1}`
          const width = Math.max(34, 10 + caption.length * 6.2)
          const isOpen = page === open
          const one = `<span class="tab${isOpen ? " on" : ""}" data-path="${escapeAttr(join(at, page.name))}" style="left:${round(left)}px;width:${round(width)}px">${escapeHtml(caption)}</span>`
          left += width + 2
          return one
        })
        .join("")
    : ""

  const pageAt = join(at, open.name)
  const body = `<div class="page" data-path="${escapeAttr(pageAt)}" style="left:1px;right:1px;top:${tabHeight}px;bottom:1px">${renderChildren(open, unit, pictures, counts, folder, pageAt)}</div>`
  return `<div${attr} style="${style}">${tabsHtml}${body}</div>`
}

/** A grid draws its headers and a few empty rows. */
function renderGrid(obj: FormObject, unit: number, style: string, attr: string, at: string): string {
  const width = sizeOf(propNumber(obj.props, "Width", 200)) * unit
  const height = sizeOf(propNumber(obj.props, "Height", 120)) * unit
  const mark = propBool(obj.props, "DeleteMark", true) ? 12 : 0
  const bars = propNumber(obj.props, "ScrollBars", 2) !== 0 ? 16 : 0
  const room = Math.max(20, width - bars - mark)

  const cells = cellsOf(obj, unit, room, at)
  // The grid says how high a header is; when it does not, the headers say it
  // themselves.
  const own = propNumber(obj.props, "HeaderHeight", 0)
  const written = Math.max(0, ...cells.map((cell) => cell.height))
  const headerHeight = Math.max(12, (own > 0 ? own : written > 0 ? written : 20) * unit)
  const rowHeight = Math.max(8, propNumber(obj.props, "RowHeight", 20) * unit)
  const total = cells.reduce((sum, cell) => sum + cell.width, 0) || room

  const head = cells
    .map((cell, index) => {
      const left = cells.slice(0, index).reduce((sum, one) => sum + one.width, 0)
      return `<span class="gcell" data-path="${escapeAttr(cell.header)}" style="left:${round(mark + left)}px;width:${round(cell.width)}px;height:${round(headerHeight)}px;${cell.font}background:${cell.bg};color:${cell.fg};text-align:${cell.align};font-weight:${cell.bold ? 600 : 400}">${captionHtml(cell.caption)}</span>`
    })
    .join("")

  const rows: string[] = []
  const room2 = Math.max(0, height - headerHeight - 1)
  const count = Math.min(20, Math.max(1, Math.floor(room2 / rowHeight)))
  for (let row = 0; row < count; row++) {
    const top = round(headerHeight + 1 + row * rowHeight)
    const line = cells
      .map((cell, index) => {
        const left = cells.slice(0, index).reduce((sum, one) => sum + one.width, 0)
        return `<span class="grow" data-path="${escapeAttr(cell.text)}" style="left:${round(mark + left)}px;width:${round(cell.width)}px;height:${round(rowHeight)}px"></span>`
      })
      .join("")
    rows.push(`<span class="gline" style="top:${top}px;left:${round(mark)}px;width:${round(total)}px"></span>${line}`)
  }

  const scroll = bars
    ? `<span class="vbar" style="left:${round(width - bars - 1)}px;top:${round(headerHeight)}px;width:${bars}px;bottom:${round(bars / 2)}px"></span>`
    : ""
  return `<div${attr} style="${style}background:#ffffff;border:1px solid #7f9fbf;overflow:hidden;">${mark ? `<span class="gmark" style="width:${mark}px"></span>` : ""}${head}${rows.join("")}${scroll}</div>`
}

/** The header of each column of a grid. */
interface Cell {
  width: number
  height: number
  caption: string
  bg: string
  fg: string
  align: string
  font: string
  bold: boolean
  /** The path of the header, and of the text box under it, for their code. */
  header: string
  text: string
}

function cellsOf(grid: FormObject, unit: number, room: number, at: string): Cell[] {
  const columns = grid.children.filter((child) => child.base === "column")
  if (!columns.length) {
    // A grid whose columns are made by the data source, so only the source is
    // known. It is shown as one column, which is what it looks like empty.
    return [
      {
        width: room,
        height: 0,
        caption: propText(grid.props, "RecordSource", ""),
        bg: "#d4d0c8",
        fg: "#000000",
        align: "left",
        font: fontOf(grid),
        bold: true,
        header: at,
        text: at,
      },
    ]
  }
  return columns.map((column, index) => {
    const header = column.children.find((child) => child.base === "header")
    const text = column.children.find((child) => child.base === "textbox")
    const width = sizeOf(propNumber(column.props, "Width", index === columns.length - 1 ? room : 100)) * unit
    const columnAt = join(at, column.name)
    return {
      width: Math.max(8, width),
      height: header ? propNumber(header.props, "Height", 0) : 0,
      caption: header ? captionOf(header) : propText(column.props, "ControlSource", "") || column.name,
      bg: (header && color(prop(header.props, "BackColor"))) ?? "#d4d0c8",
      fg: (header && color(prop(header.props, "ForeColor"))) ?? "#000000",
      align: header ? textAlignOf(header) : textAlignOf(column),
      font: header ? fontOf(header) : fontOf(column),
      bold: header ? propBool(header.props, "FontBold", true) : true,
      // A column's text box is Text1 unless the text gives it another name.
      header: join(columnAt, header ? header.name : "Header1"),
      text: join(columnAt, text ? text.name : "Text1"),
    }
  })
}

/** The base classes that are a part of the form rather than a control. */
const STRUCTURE = new Set(["dataenvironment", "cursor", "relation", "timer", "custom", "control", "hyperlink", "collection", "exception", "datasession"])

/** A frame, as a container is drawn. */
const FRAME_INSET = "border:1px solid #a0a0a0;box-shadow:inset 1px 1px 0 #6f6f6f,inset -1px -1px 0 #ffffff;"

/** The border of a container, which is either a bevel or a line. */
function frameOf(obj: FormObject): string {
  const effect = propNumber(obj.props, "SpecialEffect", 0)
  const border = propNumber(obj.props, "BorderStyle", 0)
  const width = Math.max(1, propNumber(obj.props, "BorderWidth", 1))
  const edge = color(prop(obj.props, "BorderColor"))
  if (border === 1) return `border:${width}px solid ${edge ?? "#808080"};`
  if (effect === 1) return "border:1px solid #b0b0b0;"
  if (effect === 2) return FRAME_INSET
  return "border:1px solid #b8b8b8;box-shadow:inset 1px 1px 0 #ffffff,inset -1px -1px 0 #a0a0a0;"
}

/** Where a control is. */
function geometry(obj: FormObject, unit: number): string {
  const left = propNumber(obj.props, "Left", 0) * unit
  const top = propNumber(obj.props, "Top", 0) * unit
  const [width, height] = DEFAULT_SIZE[obj.base] ?? [100, 20]
  const box = {
    width: sizeOf(propNumber(obj.props, "Width", width)) * unit,
    height: sizeOf(propNumber(obj.props, "Height", height)) * unit,
  }
  return `left:${px(left)};top:${px(top)};width:${px(box.width)};height:${px(box.height)};`
}

/** The box a text field is drawn in. */
function boxOf(obj: FormObject): string {
  const border = propNumber(obj.props, "BorderStyle", 1)
  const width = Math.max(1, propNumber(obj.props, "BorderWidth", 1))
  const edge = color(prop(obj.props, "BorderColor"))
  const frame = border === 0 ? "" : `border:${width}px solid ${edge ?? "#7f9db9"};`
  return `${frame}display:flex;align-items:center;padding:0 3px;overflow:hidden;white-space:pre;`
}

/** The font of a control. */
function fontOf(obj: FormObject): string {
  const size = propNumber(obj.props, "FontSize", 9) * (4 / 3)
  const family = propText(obj.props, "FontName", "Arial").trim() || "Arial"
  const weight = propBool(obj.props, "FontBold", false) ? "700" : "400"
  const style = propBool(obj.props, "FontItalic", false) ? "italic" : "normal"
  const decoration = propBool(obj.props, "FontUnderline", false) ? "underline" : "none"
  return `font-family:${quoted(family)}, Tahoma, Arial, sans-serif;font-size:${px(size)};font-weight:${weight};font-style:${style};text-decoration:${decoration};line-height:1.2;text-align:left;`
}

/** The colour of the writing. */
function colorOf(obj: FormObject): string {
  return `color:${color(prop(obj.props, "ForeColor")) ?? "#000000"};`
}

/** A control that is not enabled is drawn greyed. */
function dimOf(obj: FormObject): string {
  return propBool(obj.props, "Enabled", true) ? "" : "opacity:0.55;"
}

/** The colour behind a control. */
function backgroundOf(obj: FormObject): string {
  if (propNumber(obj.props, "BackStyle", 1) === 0) return "background:transparent;"
  const name = obj.base === "page" || obj.base === "form" ? "form" : obj.base
  const back = color(prop(obj.props, "BackColor")) ?? DEFAULT_BACK[name] ?? "transparent"
  return `background:${back};`
}

/** Where the writing sits across its box. */
function alignOf(obj: FormObject): string {
  const align = textAlignOf(obj)
  const flex = align === "right" ? "flex-end" : align === "center" ? "center" : "flex-start"
  return `justify-content:${flex};text-align:${align};`
}

/** Where the writing sits inside its box, as a CSS text-align. */
function textAlignOf(obj: FormObject): string {
  switch (propNumber(obj.props, "Alignment", 0)) {
    case 1:
      return "right"
    case 2:
      return "center"
    case 3:
      return "justify"
    default:
      return "left"
  }
}

/** What a text field shows: its value, or where the value comes from. */
function textboxContent(obj: FormObject): { html: string; muted: boolean } {
  const value = prop(obj.props, "Value")
  if (value !== undefined && value !== null && value !== "" && value !== false) {
    return { html: escapeHtml(String(value).split(/\r?\n/)[0]), muted: false }
  }
  const source = propText(obj.props, "ControlSource", "")
  if (source) return { html: escapeHtml(source), muted: true }
  return { html: "", muted: true }
}

/** The items of a list box, when the text file says what they are. */
function listItems(obj: FormObject): string[] {
  if (propNumber(obj.props, "RowSourceType", 0) !== 1) return []
  return propText(obj.props, "RowSource", "")
    .split(",")
    .map((one) => one.trim())
    .filter(Boolean)
    .slice(0, 12)
}

/** A picture of a control, as data, when the file is there. */
function pictureOf(obj: FormObject, pictures: Pictures, folder: string): string | undefined {
  const value = propText(obj.props, "Picture", "").trim()
  if (!value) return undefined
  const known = pictures.get(`${folder}|${value}`)
  if (known !== undefined) return known

  const found = findPicture(value, folder)
  pictures.set(`${folder}|${value}`, found)
  return found
}

/** Finds a picture and reads it, so that the page needs no file of its own. */
function findPicture(value: string, folder: string): string | undefined {
  // A picture can be a name, a path, or an expression, and only a file that is
  // there can be shown.
  if (!/^[A-Za-z]:[\\/]|^[\\/]|^\.\.?[\\/]|^[A-Za-z0-9 _\\/-]+$/.test(value)) return undefined
  const guessed = /\.(bmp|gif|jpe?g|png|ico|cur|emf|wmf)$/i.test(value)
    ? [value]
    : [value, `${value}.bmp`, `${value}.gif`, `${value}.jpg`, `${value}.png`, `${value}.ico`]

  for (const guess of guessed) {
    const file = path.isAbsolute(guess) ? guess : path.join(folder, guess)
    try {
      const info = fs.statSync(file)
      if (!info.isFile() || info.size > 3 * 1024 * 1024) continue
      const data = fs.readFileSync(file)
      return `data:${MIME[path.extname(file).toLowerCase()] ?? "image/bmp"};base64,${data.toString("base64")}`
    } catch {
      // A picture that cannot be read is left out.
    }
  }
  return undefined
}

const MIME: Record<string, string> = {
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".cur": "image/x-icon",
}

/** The caption of a control, with the line breaks that are written into it. */
function captionOf(obj: FormObject): string {
  return propText(obj.props, "Caption", "")
    .replace(/["']\s*\+\s*CHR\(13\)\s*\+\s*["']/gi, "\n")
    .replace(/CHR\((13|10)\)/gi, "\n")
}

/** A caption as the page shows it, with its accelerator underlined. */
function captionHtml(text: string): string {
  let out = ""
  let index = 0
  while (index < text.length) {
    if (text.startsWith("\\\\<", index)) {
      out += escapeHtml("\\<")
      index += 3
      continue
    }
    if (text.startsWith("\\<", index) && index + 2 < text.length) {
      out += `<u>${escapeHtml(text[index + 2])}</u>`
      index += 3
      continue
    }
    const char = text[index]
    out += char === "\n" ? "<br>" : escapeHtml(char)
    index++
  }
  return out
}

/** A colour property, as the page can use it. */
function color(value: unknown): string | undefined {
  if (typeof value === "string") {
    const triplet = /^(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})$/.exec(value.trim())
    if (triplet) return `rgb(${triplet[1]}, ${triplet[2]}, ${triplet[3]})`
    if (/^#[0-9a-f]{3,8}$/i.test(value.trim())) return value.trim()
    return undefined
  }
  if (typeof value === "number" && value >= 0) {
    // A colour that is held as one number is blue, green, red, from the top.
    const red = value & 0xff
    const green = (value >> 8) & 0xff
    const blue = (value >> 16) & 0xff
    return `rgb(${red}, ${green}, ${blue})`
  }
  return undefined
}

function quoted(name: string): string {
  // A style sits inside a double-quoted attribute, so the family is quoted the
  // other way round.
  return `'${name.replace(/'/g, "")}'`
}

/** The path of a child object, as the text file writes it. */
function join(prefix: string, name: string): string {
  return prefix ? `${prefix}.${name}` : name
}

function px(value: number): string {
  return `${round(value)}px`
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;")
}

/** The look of the page around the form. */
const CSS = `
* { box-sizing: border-box; }
html, body { margin: 0; }
body {
  font: 12px/1.5 var(--vscode-font-family, sans-serif);
  color: var(--vscode-foreground, #ccc);
  background: var(--vscode-editor-background, #1e1e1e);
}
header {
  position: sticky; top: 0; z-index: 30;
  display: flex; align-items: center; gap: 10px;
  padding: 7px 14px;
  background: var(--vscode-editor-background, #1e1e1e);
  border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c);
}
header .name { font-weight: 600; font-size: 13px; }
header .detail { opacity: .6; }
header .spacer { flex: 1; }
header button {
  font: inherit; padding: 1px 10px; border-radius: 3px; cursor: pointer;
  color: var(--vscode-button-secondaryForeground, inherit);
  background: var(--vscode-button-secondaryBackground, #3a3d41);
  border: 1px solid var(--vscode-panel-border, #3c3c3c);
}
header button.on {
  color: var(--vscode-button-foreground, #fff);
  background: var(--vscode-button-background, #0e639c);
}
main { padding: 14px 16px 8px; }
section { margin: 0 0 28px; }
section h2 { margin: 0 0 2px; font-size: 13px; font-weight: 600; }
section h2 .what { font-weight: 400; opacity: .55; }
section .about { margin: 0 0 8px; opacity: .6; }
.holder { overflow: hidden; }
.window {
  position: relative; display: inline-block; transform-origin: top left;
  background: #d4d0c8; border: 1px solid #7f7f7f;
  box-shadow: 0 3px 14px rgba(0, 0, 0, .35);
}
.window.noborder { border: 0; }
.titlebar {
  height: 22px; display: flex; align-items: center; gap: 4px; padding: 0 3px;
  background: linear-gradient(180deg, #0a246a 0%, #3a6ea5 100%);
  color: #fff; font: 11px Tahoma, sans-serif;
}
.titlebar .cap { flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.titlebar .sys { display: flex; gap: 2px; }
.titlebar .sys i {
  width: 16px; height: 14px; display: block; background: #d4d0c8; color: #000;
  font: 9px/13px Tahoma, sans-serif; text-align: center; font-style: normal;
  border: 1px solid #fff; box-shadow: inset -1px -1px 0 #808080;
}
.client { position: relative; overflow: hidden; }
.ctl { position: absolute; overflow: hidden; }
.ctl.ghost { opacity: .3; outline: 1px dashed #b25a5a; outline-offset: -1px; }
body.no-hidden .ctl.ghost { display: none; }
[data-path]:hover { outline: 1px solid #4a9eff; outline-offset: -1px; cursor: pointer; }
.ctl.ghost[data-path]:hover { outline-style: solid; }
.ctl.commandbutton { border: 1px solid #7f7f7f; border-radius: 2px; background: #f0f0f0;
  box-shadow: inset 1px 1px 0 #fff, inset -1px -1px 0 #a0a0a0; }
.ctl.commandbutton.flat { box-shadow: none; border-color: #a0a0a0; }
.ctl.commandbutton img { display: block; }
.ctl.commandbutton .under { font-size: 90%; }
.muted { opacity: .55; font-style: italic; }
.ole { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  font-size: 10px; color: #555; background: repeating-linear-gradient(45deg, #efefef, #efefef 6px, #e3e3e3 6px, #e3e3e3 12px); }
.drop { position: absolute; right: 0; top: 0; bottom: 0; width: 16px; background: #f0f0f0;
  border-left: 1px solid #a0a0a0; display: flex; align-items: center; justify-content: center; }
.drop i { width: 0; height: 0; border-left: 4px solid transparent; border-right: 4px solid transparent; border-top: 5px solid #333; }
.spin { position: absolute; right: 0; top: 0; bottom: 0; width: 14px; display: flex; flex-direction: column;
  border-left: 1px solid #a0a0a0; }
.spin i { flex: 1; position: relative; background: #f0f0f0; }
.spin i:first-child { border-bottom: 1px solid #a0a0a0; }
.spin i::after { content: ""; position: absolute; left: 4px; top: 4px; width: 0; height: 0;
  border-left: 3px solid transparent; border-right: 3px solid transparent; border-bottom: 4px solid #333; }
.spin i:last-child::after { top: 5px; border-bottom: 0; border-top: 4px solid #333; }
.vbar { position: absolute; right: 0; top: 0; bottom: 0; width: 16px; background: #f0f0f0;
  border-left: 1px solid #a0a0a0; }
.vbar::after { content: ""; position: absolute; left: 2px; right: 2px; top: 3px; height: 40%; background: #c8c8c8;
  border: 1px solid #9a9a9a; border-radius: 2px; }
.listbox .vbar, .editbox .vbar { position: absolute; }
.item { display: block; padding: 0 3px; white-space: nowrap; overflow: hidden; }
.tick { width: 13px; height: 13px; background: #fff; border: 1px solid #7f7f7f; position: relative; flex: none; }
.tick.on::after { content: ""; position: absolute; left: 2px; top: 1px; width: 7px; height: 5px;
  border-left: 2px solid #000; border-bottom: 2px solid #000; transform: rotate(-45deg); }
.dot { width: 12px; height: 12px; border-radius: 50%; background: #fff; border: 1px solid #7f7f7f;
  position: relative; flex: none; }
.dot.on::after { content: ""; position: absolute; left: 2px; top: 2px; width: 6px; height: 6px;
  border-radius: 50%; background: #000; }
.ctl.pageframe { background: #d4d0c8; }
.ctl.pageframe .tab { position: absolute; top: 1px; height: 21px; padding: 0 6px; font: 11px Tahoma, sans-serif;
  background: #c8c4bc; border: 1px solid #808080; border-bottom: 0; border-radius: 3px 3px 0 0;
  display: flex; align-items: center; justify-content: center; overflow: hidden; white-space: nowrap; }
.ctl.pageframe .tab.on { background: #d4d0c8; height: 23px; top: 0; z-index: 2; }
.ctl.pageframe .page { position: absolute; background: #d4d0c8; overflow: hidden; }
.ctl.grid .gcell { position: absolute; top: 0; border-right: 1px solid #b0b0b0;
  border-bottom: 1px solid #b0b0b0; padding: 0 3px; display: flex; align-items: center; overflow: hidden;
  white-space: nowrap; }
.ctl.grid .gmark { position: absolute; left: 0; top: 0; bottom: 0; background: #e8e8e8; border-right: 1px solid #b0b0b0; }
.ctl.grid .grow { position: absolute; border-right: 1px solid #dcdcdc; border-bottom: 1px solid #e4e4e4; }
.ctl.grid .gline { position: absolute; height: 1px; background: #e4e4e4; }
.nopic { font: 10px Tahoma, sans-serif; color: #777; padding: 2px; text-align: center; }
.trouble { padding: 24px 4px; opacity: .8; }
.foot { margin: 26px 0 0; opacity: .45; font-size: 11px; }
`

/** The little that the page does: fit the form to the width, or show it as it is. */
const SCRIPT = `
const state = { fit: true };
function apply() {
  document.querySelectorAll(".window").forEach((win) => {
    const holder = win.parentElement;
    const width = parseFloat(win.dataset.w || "0");
    if (state.fit && width > 0) {
      const room = holder.clientWidth;
      const scale = Math.min(1, (room - 2) / width);
      win.style.transform = scale < 1 ? "scale(" + scale + ")" : "";
      holder.style.height = scale < 1 ? win.getBoundingClientRect().height + "px" : "";
    } else {
      win.style.transform = "";
      holder.style.height = "";
    }
  });
  document.querySelectorAll("[data-zoom]").forEach((button) => {
    button.classList.toggle("on", (button.dataset.zoom === "fit") === state.fit);
  });
}
document.querySelectorAll("[data-zoom]").forEach((button) => {
  button.addEventListener("click", () => {
    state.fit = button.dataset.zoom === "fit";
    apply();
  });
});
const ghost = document.querySelector("[data-ghost]");
if (ghost) {
  ghost.addEventListener("click", () => {
    const off = document.body.classList.toggle("no-hidden");
    ghost.classList.toggle("on", !off);
  });
}

// A control knows where it sits in the form, and the editor knows which methods
// that object has. Clicking one asks for them.
const bridge = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
if (bridge) {
  document.addEventListener("click", (event) => {
    const at = event.target.closest("[data-path]");
    if (!at) return;
    const section = at.closest("[data-class]");
    bridge.postMessage({
      type: "method",
      cls: section ? section.dataset.class || "" : "",
      path: at.dataset.path || "",
    });
  });
}
window.addEventListener("resize", apply);
apply();
`
