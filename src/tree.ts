import * as fs from "node:fs"
import * as path from "node:path"
import * as vscode from "vscode"

/**
 * The Visual FoxPro files of the project, in the explorer.
 *
 * The text file is the master, so the tree shows the text files, and says
 * for each one whether the binary file is in step with it. The four states
 * are:
 *
 *   * in step       the text and the binary file belong together
 *   * to build      the text is newer, the binary file has to be built again
 *   * to refresh    the binary file is newer, the text has to catch up
 *   * excluded      the file is in .vfpignore and is never converted at all
 *
 * A file that was changed in the designer is not written over, because that
 * would throw the work away. It is only said out loud.
 */

export type State = "step" | "build" | "refresh" | "notext" | "ignored"

export interface VfpEntry {
  /** The binary file of the project. */
  binary: string
  /** The text file that belongs to it. */
  text: string
  /** Where it stands. */
  state: State
}

/** The icon that goes with a state. */
const ICONS: Record<State, string> = {
  step: "file-binary",
  build: "tools",
  refresh: "warning",
  notext: "file",
  ignored: "circle-slash",
}

/** What the status bar and the tree say about a state. */
const DESCRIPTIONS: Record<State, string> = {
  step: "in step",
  build: "to build",
  refresh: "to refresh",
  notext: "without a text file",
  ignored: "excluded",
}

/** A node of the tree. */
export class VfpNode extends vscode.TreeItem {
  constructor(
    readonly label: string,
    readonly kind: "folder" | "file",
    readonly entry?: VfpEntry,
    readonly children: VfpNode[] = [],
  ) {
    super(
      label,
      kind === "folder"
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    )
    if (kind === "file" && entry) {
      const file = entry.text && fs.existsSync(entry.text) ? entry.text : entry.binary
      this.resourceUri = vscode.Uri.file(file)
      this.command = {
        command: "vscode.open",
        title: "Open",
        arguments: [this.resourceUri],
      }
      this.description = DESCRIPTIONS[entry.state]
      this.iconPath = new vscode.ThemeIcon(ICONS[entry.state])
      this.contextValue = `vfp:${entry.state}`
      this.tooltip = new vscode.MarkdownString(
        [
          `**${path.basename(entry.binary)}**`,
          "",
          `- The binary file: \`${entry.binary}\``,
          `- The text file: \`${entry.text}\``,
          `- ${DESCRIPTIONS[entry.state]}`,
          ...(entry.state === "ignored"
            ? ["", `This file is in \`.vfpignore\`, so FoxBin2Prg is never used on it.`]
            : []),
        ].join("\n"),
      )
    } else if (kind === "folder") {
      this.iconPath = new vscode.ThemeIcon("folder")
      this.contextValue = "vfp:folder"
    }
  }
}

/** The tree of the Visual FoxPro files. */
export class VfpTree implements vscode.TreeDataProvider<VfpNode> {
  private readonly changed = new vscode.EventEmitter<VfpNode | undefined>()
  readonly onDidChangeTreeData = this.changed.event

  /** The files, found by the extension. */
  entries: VfpEntry[] = []

  refresh(): void {
    this.changed.fire(undefined)
  }

  getTreeItem(node: VfpNode): vscode.TreeItem {
    return node
  }

  /**
   * The tree, grouped by the folder the files are in.
   *
   * The files that are out of step come first, because those are the ones a
   * person wants to see.
   */
  getChildren(node?: VfpNode): VfpNode[] {
    if (!node) {
      const folders = new Map<string, VfpEntry[]>()
      for (const entry of this.entries) {
        const folder = path.dirname(entry.binary)
        if (!folders.has(folder)) folders.set(folder, [])
        folders.get(folder)!.push(entry)
      }
      const nodes: VfpNode[] = []
      for (const [folder, list] of folders) {
        const name = path.basename(folder)
        list.sort((a, b) => rank(a.state) - rank(b.state) || a.binary.localeCompare(b.binary))
        // A file that is excluded is not counted as one that needs work.
        const waiting = list.filter((e) => e.state !== "step" && e.state !== "ignored").length
        const label = waiting ? `${name}  (${waiting})` : name
        nodes.push(
          new VfpNode(
            label,
            "folder",
            undefined,
            list.map((e) => new VfpNode(path.basename(e.binary), "file", e)),
          ),
        )
      }
      return nodes
    }
    return node.children
  }
}

/** The order the states come in: the ones that need work come first. */
function rank(state: State): number {
  switch (state) {
    case "build":
      return 0
    case "refresh":
      return 1
    case "notext":
      return 2
    case "step":
      return 3
    default:
      return 4
  }
}
