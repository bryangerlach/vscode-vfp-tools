import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import * as vscode from "vscode"
import { methodsOf } from "./form"
import { renderHtml, renderNotice } from "./formview"

/**
 * The form, as a picture, in an editor of its own.
 *
 * It is a read-only editor, so the text file still opens as text and the work
 * is still done in the text. The picture is picked with Open With, or by the
 * command that comes with the extension, and it follows the text file while it
 * is being changed: the point of seeing the form is to see what the change did.
 *
 * A control in the picture can be clicked. The text file says which object each
 * method belongs to (PROCEDURE cmdList.Click), so the methods of the control
 * that was clicked are listed, and picking one takes the text editor to the
 * line where it starts. Nothing is run to find them: the methods are read out
 * of the same text the picture was drawn from.
 */

/** The editor that is registered for a form, so that Open With can pick it. */
export const VIEW_TYPE = "vfp.formPreview"

/** The files that hold a form, or a class library that holds forms. */
export const FORM_TEXT = /\.(sc2|vc2)$/i

/** How long a change waits before the form is drawn again. */
const WAIT = 250

export function activatePreview(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, new FormPreview(), {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    }),
  )
}

/** The editor itself. */
class FormPreview implements vscode.CustomReadonlyEditorProvider {
  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose() {} }
  }

  resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): void {
    panel.webview.options = { enableScripts: true }
    const file = document.uri.fsPath

    const draw = () => {
      const text = textOf(file)
      if (text === undefined) {
        panel.webview.html = renderNotice(`The text file could not be read: ${file}`)
      } else {
        panel.webview.html = renderHtml({ file, text, nonce: nonce() })
      }
    }

    draw()

    // The preview is there to be looked at while the text is being changed, so
    // it follows the file. A change that is not saved yet is used as well, when
    // the text is open in another editor.
    let timer: ReturnType<typeof setTimeout> | undefined
    const soon = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(draw, WAIT)
    }

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(path.dirname(file)), path.basename(file)),
    )
    const changed = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.fsPath.toLowerCase() === file.toLowerCase()) soon()
    })
    const saved = vscode.workspace.onDidSaveTextDocument((saved) => {
      if (saved.uri.fsPath.toLowerCase() === file.toLowerCase()) soon()
    })
    // A control was clicked: the methods of it are asked for.
    const asked = panel.webview.onDidReceiveMessage((message: unknown) => {
      if (!message || typeof message !== "object") return
      const one = message as { type?: string; cls?: unknown; path?: unknown }
      if (one.type !== "method") return
      void showMethods(file, String(one.cls ?? ""), String(one.path ?? ""))
    })

    watcher.onDidChange(soon)
    watcher.onDidCreate(soon)
    panel.onDidDispose(() => {
      if (timer) clearTimeout(timer)
      watcher.dispose()
      changed.dispose()
      saved.dispose()
      asked.dispose()
    })
  }
}

/**
 * Lists the methods of one object, and jumps to the one that is picked.
 *
 * The methods of the form itself have a name with no dot in it (Init, Load),
 * and the methods of a control start with the path of the control
 * (cmdList.Click, Grid1.ColACT.Text1.DblClick). A control that is an instance
 * of a class of the project has no methods of its own, so the class it was made
 * from is looked at, which can be in another file.
 */
async function showMethods(file: string, clsName: string, at: string): Promise<void> {
  const text = textOf(file)
  if (text === undefined) {
    void vscode.window.showInformationMessage("The text file could not be read.")
    return
  }

  const found = methodsOf(file, text, clsName, at)

  if (!found.methods.length) {
    const from = found.lib ? ` It is a ${found.cls} of ${path.basename(found.lib)}, and that class has no code either.` : ""
    void vscode.window.showInformationMessage(`${found.name} has no code in this file.${from}`)
    return
  }

  if (found.methods.length === 1) {
    await reveal(found.methods[0].file, found.methods[0].procedure.line)
    return
  }

  const files = new Set(found.methods.map((one) => one.file.toLowerCase()))
  const items = found.methods.map((one) => ({
    label: `$(symbol-method) ${one.procedure.event}`,
    description: files.size > 1 ? path.basename(one.file) : one.procedure.name,
    file: one.file,
    line: one.procedure.line,
  }))
  const picked = await vscode.window.showQuickPick(items, {
    title: found.name,
    placeHolder: `${found.methods.length} methods of ${found.name} - pick one to see its code`,
    matchOnDescription: true,
  })
  if (!picked) return
  await reveal(picked.file, picked.line)
}

/**
 * Takes the text editor to the line a method starts on.
 *
 * When the text is already open it is used, so the cursor moves in the window
 * that is already there; otherwise the text opens beside the picture, which is
 * where the work is done anyway.
 */
async function reveal(file: string, line: number): Promise<void> {
  const at = new vscode.Range(Math.max(0, line - 1), 0, Math.max(0, line - 1), 0)
  const open = vscode.window.visibleTextEditors.find(
    (editor) => editor.document.uri.fsPath.toLowerCase() === file.toLowerCase(),
  )
  if (open) {
    open.selection = new vscode.Selection(at.start, at.start)
    open.revealRange(at, vscode.TextEditorRevealType.InCenter)
    await vscode.window.showTextDocument(open.document, {
      viewColumn: open.viewColumn,
      selection: at,
      preserveFocus: false,
      preview: false,
    })
    return
  }
  await vscode.window.showTextDocument(vscode.Uri.file(file), {
    viewColumn: vscode.ViewColumn.Beside,
    selection: at,
    preserveFocus: false,
    preview: false,
  })
}

/** The text of the file that is open, or the text that is on the disk. */
function textOf(file: string): string | undefined {
  const open = vscode.workspace.textDocuments.find(
    (document) => document.uri.fsPath.toLowerCase() === file.toLowerCase(),
  )
  if (open) return open.getText()
  try {
    return fs.readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

/** A preview that is open, and the file it draws. */
export interface ShownPreview {
  /** The file that is drawn. */
  file: string
  /** The column it is drawn in. */
  column?: vscode.ViewColumn
}

/** The previews that are open now. */
export function shownPreviews(): ShownPreview[] {
  const found: ShownPreview[] = []
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input
      if (input instanceof vscode.TabInputCustom && input.viewType === VIEW_TYPE) {
        found.push({ file: input.uri.fsPath, column: group.viewColumn })
      }
    }
  }
  return found
}

/** Draws a form text file in a preview, beside the text. */
export async function showPreview(file: string, column?: vscode.ViewColumn): Promise<void> {
  await vscode.commands.executeCommand(
    "vscode.openWith",
    vscode.Uri.file(file),
    VIEW_TYPE,
    column ?? vscode.ViewColumn.Beside,
  )
}

/**
 * Puts the keyboard back in the text when the picture opens.
 *
 * A preview is there to be looked at, and the typing belongs in the code, so
 * opening one never takes the focus away from the text it is drawn from.
 */
async function keepTyping(editor: vscode.TextEditor | undefined): Promise<void> {
  if (!editor) return
  await vscode.window.showTextDocument(editor.document, {
    viewColumn: editor.viewColumn,
    preserveFocus: false,
  })
}

/** Closes the previews that are open, or only the ones that draw one file. */
export async function closePreviews(file?: string): Promise<void> {
  const lower = file?.toLowerCase()
  const closing: vscode.Tab[] = []
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input
      if (!(input instanceof vscode.TabInputCustom) || input.viewType !== VIEW_TYPE) continue
      if (lower && input.uri.fsPath.toLowerCase() !== lower) continue
      closing.push(tab)
    }
  }
  for (const tab of closing) await vscode.window.tabGroups.close(tab)
}

/** The file of the preview that is in front, when a preview is. */
export function previewedFile(): string | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input
  if (!(input instanceof vscode.TabInputCustom) || input.viewType !== VIEW_TYPE) return undefined
  return input.uri.fsPath
}

/**
 * The column to draw the form in.
 *
 * The one the preview was in, unless the text has been opened there as well;
 * then the picture goes beside the text rather than on top of it.
 */
function columnFor(open: ShownPreview[], editor: vscode.TextEditor | undefined): vscode.ViewColumn | undefined {
  const column = open.find((one) => one.column !== undefined)?.column
  if (column !== undefined && editor?.viewColumn === column) return undefined
  return column
}

/**
 * Shows or hides the preview of the form that is being edited.
 *
 * There is one preview and it follows the text, so the picture is always of the
 * form in the code window and the tabs do not pile up. A second press on the
 * form that is being drawn hides it.
 */
export async function togglePreview(file?: string): Promise<void> {
  const chosen = file ?? vscode.window.activeTextEditor?.document.uri.fsPath ?? previewedFile()
  if (!chosen || !FORM_TEXT.test(chosen)) {
    void vscode.window.showInformationMessage(
      "The preview is for a form text file. Open a .sc2 or a .vc2 file first.",
    )
    return
  }

  const open = shownPreviews()
  if (open.some((one) => one.file.toLowerCase() === chosen.toLowerCase())) {
    await closePreviews(chosen)
    return
  }

  // The column the preview was in is kept, so it does not jump across the
  // window when another form is opened.
  const typing = vscode.window.activeTextEditor
  const column = columnFor(open, typing)
  if (open.length) await closePreviews()
  await showPreview(chosen, column)
  await keepTyping(typing)
}

/**
 * Draws the form that was just opened, in the preview that is already there.
 *
 * A preview that is not open is not opened by this: the key and the button are
 * how it is turned on, so opening a form never changes the layout by itself.
 */
export async function followPreview(editor: vscode.TextEditor | undefined): Promise<void> {
  if (!editor || editor.document.uri.scheme !== "file") return
  const file = editor.document.uri.fsPath
  if (!FORM_TEXT.test(file)) return

  const open = shownPreviews()
  if (!open.length) return
  if (open.some((one) => one.file.toLowerCase() === file.toLowerCase())) return

  const column = columnFor(open, editor)
  await closePreviews()
  await showPreview(file, column)
  await keepTyping(editor)
}

/** What the page is allowed to run, which is only itself. */
function nonce(): string {
  return crypto.randomBytes(16).toString("base64").replace(/[^A-Za-z0-9]/g, "")
}
