# Visual FoxPro Tools

A Visual FoxPro extension for VSCodium and Visual Studio Code. It gives the `.prg`, `.sc2`, `.vc2`,
`.fr2` and the other text files of a Visual FoxPro project the colours and the
indenting they need, and it turns the binary files of a project into readable
text and back again.

## Installing it

Build a `.vsix` and install it, or install the packaged file if a release has
one:

```
npm install
npx vsce package --skip-license
codium --install-extension vfp-tools-<version>.vsix
```

`code --install-extension` does the same in Visual Studio Code.

## What it does

| Command | What it does |
| --- | --- |
| **VFP: Open the menu** | Opens a list of everything the extension can do. It is also what the status bar opens. |
| **VFP: Open a file as text** | Turns a `.scx`, `.vcx`, `.frx`, `.mnx`, `.lbx` or `.pjx` file into the matching `.SC2`, `.VC2`, `.FR2`, `.MN2`, `.LB2` or `.PJ2` file and gives the path of it. The file stays open for the session, so it is not turned into text again. |
| **VFP: Close a file** | Turns the text file back into the binary file, so the changes are in the form or the report again. |
| **VFP: Build the project** | Builds the binary files whose text was changed, and then runs the program that builds the project. |
| **VFP: Put everything in step** | Builds what the text files changed, makes the text files that are behind, and makes the text files that are not there yet. |
| **VFP: Rebuild the binary files from the text files** | Builds every binary file again from its text file, whether or not it is out of step. |
| **VFP: Rebuild the text files from the binary files** | Makes the text file of every binary file that is behind, and of every binary file that has no text file yet. |
| **VFP: Bring the binary files in step with the text files** | Builds the binary files whose text file was changed, and nothing else. |
| **VFP: Show what is out of step** | Only looks, and changes nothing. |
| **VFP: Edit the exclude list** | Makes the `.vfpignore` file if it is not there yet, with the rules written down in it, and opens it. |
| **VFP: Open in the Visual FoxPro IDE** | Opens the file in the designer of the Visual FoxPro that is running. |
| **VFP: Preview the form** | Draws the form of a `.sc2` or `.vc2` file as a picture, beside the text, so the effect of a change is seen without the designer. |
| **VFP: Show or hide the form preview** | Turns the one preview pane on or off with `Ctrl+K V`, or the preview button in the title bar of a form text file, and keeps it on the form that is being edited. |

## Where the commands are

There are three places, so that nobody has to remember a name.

1. **The panel on the left.** The icon of Visual FoxPro opens a panel with
   the files of the project, and the ones that are out of step are at the top
   of their folder. There are buttons at the top of the panel: the menu, "put
   everything in step", "bring in step" and the build. Right-click a file in the
   panel for the commands that work on that one file.

2. **The right-click menu.** Right-click in the editor, or right-click a file
   in the explorer, and every command is there.

3. **The status bar.** On the right of the status bar it says how many files
   are out of step. Click it and the menu opens.

Every command is also in the command palette (Ctrl+Shift+P) under **VFP**.

The button at the top right of the editor, **Open in the Visual FoxPro IDE**,
is the only one that fits there, so it is the only one that is there.

## The text file is the master

A `.scx` file is binary and cannot be read by an editor. The `.SC2` file next to
it holds the same thing as text, and the text is the master: the binary file
is the build, and it is made again from the text.

So the work goes like this:

1. The file is opened as text when it is needed.
2. The text file is changed.
3. The file is closed, and the binary file is built again.

A file that is open stays open for the session. When the form is changed in the
designer, the next open makes the text again and says so. When the form and
the text were both changed, neither one is touched, because one of them would
be thrown away.

## How the extension knows which side changed

The times of the files are not enough, because FoxBin2Prg gives the file it
writes the time of the run. A conversion and a change in the designer look the
same.

So there is a **marker file** that holds the size and the time of both files
of every pair, as they were the last time the two were seen together:

```
%LOCALAPPDATA%\vfp-tools\sync_myproject_pjx.txt
```

* The text file is not the mark it was → the text was changed, and the binary
  file has to be built again.
* The binary file is not the mark it was → the form was changed in the
  designer, and the text has to catch up.
* Both are the mark they were → the two belong together.

A file **without a text file** is the fourth case: it has never been turned into
text at all.

The time is rounded **up to the next even second**, the way Visual FoxPro
records file times, so the mark does not change with the part of a second that
the file system adds, and the day is written as `YYYYMMDD`, without the dashes.

## When a lot of files are out of step

After a session in the designer, **Show what is out of step** can name hundreds
of files at once, and they are not all waiting for the same thing:

```
Waiting to be built (the text is newer): 0
Behind (the binary is newer): 128
Without a text file: 12
```

**Put everything in step** deals with all three at once. It is the second button
at the top of the panel, and it is in the menu behind the status bar.

* A file whose **text** was changed is built into its binary file, because the
  text file is the master. If that file was also saved in the designer since the
  two were last in step, the text file wins, exactly as it does with the other
  build commands.
* A file that is **behind** gets its text file made again. That is safe, because
  the marker only calls a file behind when its text file was not touched since
  the two were last in step, so there is nothing of yours to lose.
* A file **without a text file** gets one.

Nothing that was written by hand can be thrown away, whatever the three numbers
are, so it can be used without going through the list first. It asks with the
three numbers in the question.

The two buttons under it work in one direction each, for when that is what is
wanted.

## Seeing the form

The text file says where every control is, how big it is, what it says and what
colour it is, because those are the properties the property window shows. That
is enough to draw the form, so there is a preview:

**VFP: Preview the form** opens the text file in an editor of its own, drawn as
the form, beside the text. It is the way to see what a change to the `.SC2` did
without opening the designer.

The preview is a **read-only editor of its own**, so a `.sc2` still opens as
text, and the work is still done in the text. It can be picked with **Open
With → VFP Form Preview**, or opened by the command:

* the preview button when the pointer is over a file in the panel
* right-click a `.sc2` or `.vc2` file, in the editor or in the explorer
* **VFP: Preview the form** in the command palette

A file that has no text file yet is turned into one first, because there would
be nothing to draw otherwise.

**The preview can be kept beside the code.** **VFP: Show or hide the form
preview** — `Ctrl+K V` when a form text file is open, or the preview button in
the title bar of a `.sc2` or `.vc2` — opens one preview pane and keeps it on the
form that is being edited: open another form and the same pane draws it, so there
is one picture of the form in the code window rather than a tab per form. The
same key hides it again. A preview that was opened with **Open With** follows the
text in the same way. The preview is an editor tab, so it can be dragged to a
second monitor, or **Move into New Window**, and sit there the way the designer
would on another screen.

It follows the text while it is being changed, so a form does not have to be
saved to be seen again. What it draws is:

* the form, with its title bar, its caption, its colour and its size
* every control at its `Left`, `Top`, `Width` and `Height`, with its caption, its
  font, its colours and its border, in the order the form draws them
* the inside of a container, of a page frame (its tabs, the page that is open)
  and of a grid (the columns, their headers, their alignment and their colours)
* the controls a **class library** gives a control, because the `.vc2` of the
  library is read as text as well, so a form of this project looks like itself

It does not run anything, and it reads no data:

* a property that is an **expression** is shown as it is written, because what it
  comes to is only known when the form runs
* a **text box** shows where its value comes from (`ControlSource`), and a grid
  is empty, because there is no data to show
* a **picture** is drawn when the file is there in the project folder, and left
  out when it is not

Controls whose `Visible` is `.F.` are drawn as ghosts, the way the designer shows
them, with a dashed outline. The **Hidden** button at the top hides them, so the
form can be seen the way it looks when it is first shown.

**Clicking a control shows its code.** The text file says which object each
method belongs to, in the `PROCEDURE` lines (`PROCEDURE cmdABORT.Click`,
`PROCEDURE Grid1.ColACT.Text1.DblClick`), so a click lists the methods of that
control, and picking one takes the text editor to the line where it starts, beside
the picture. A control that is an instance of a class of the project gets the
methods of that class as well, even when the class is in the `.vc2` of a class
library, and the file that holds the code is the one that opens. A control with
one method goes straight to it, one with more shows the list, and one with none
says so.

The form itself is clicked on its background, and a tab, a grid header and a grid
column have their own code too.

## Going to the code

**Go to Definition** — `F12`, `Ctrl+click`, or right-click → **Go to
Definition** — follows the names that Visual FoxPro uses instead of file names:

* `DO hello` opens `hello.prg`, and `DO hello IN tools` opens the `hello`
  procedure of `tools.prg`
* `SET PROCEDURE TO tools` opens `tools.prg`
* `DO FORM frm_customer` opens `frm_customer.sc2`, the text file, because the text
  is the master of the form
* `THISFORM.my_method` and `THIS.my_method` go to the `PROCEDURE my_method` line,
  in the form or in the class it is made from
* `THISFORM.cmdOK.Click` goes to that event, in the form or in the class library
  of the control

A name is looked for in the folder of the file that is open, then in the folder
of the project, and then anywhere in the project: a `.prg` with the name of the
program is found first, then a `PROCEDURE` or `FUNCTION` of that name in a
program, including the ones named by `SET PROCEDURE TO`.

A name that is not in the project is not answered, and nothing is said: it can
be in a DLL, an APP, or a program that is not in the project. A `.scx` that has
no `.sc2` is not answered either, because the binary file is not text that can
be read or edited.

## The Visual FoxPro that is running

The **Open in the Visual FoxPro IDE** command talks to the Visual FoxPro that
is already running, so a form opens in the window the user has open and not in
a second one. It is the one command that needs the IDE to be running.

The **Build the project** command starts a Visual FoxPro of its own, because the
build changes the files of the project and the IDE holds some of them open.

The Visual FoxPro that is started for a program is handed a configuration file
of its own, `-C`, that says `RESOURCE = OFF`. Visual FoxPro remembers its
settings from one run to the next in a resource file, and among those settings
is the project it was left with. Without that file the Visual FoxPro started for
one program would open the remembered project by itself, so the program would
not be working on the project of the user at all, and it would write the
resource file again on the way out, which takes minutes when that file sits on a
slow path. The configuration file is written in the scratch folder and is swept
up with the rest of it.

## The build program

The build program is a Visual FoxPro program with a `BUILD EXE` or a
`BUILD PROJECT` command in it. The extension looks for it in this order:

1. the `vfp.buildProgram` setting
2. `progs\build_it.prg`, `progs\build.prg` and the other names that are used
   most often
3. any program in the project that holds a build command

The program is run in a Visual FoxPro of its own, because the build changes the
files of the project and the IDE holds some of them open.

A build program can do more than `BUILD`: it can give the exe the next version
number, sign it and copy it to other drives. The extension does not depend on
any of that. It runs the program and reports whether it succeeded.

## The settings

| Setting | What it is |
| --- | --- |
| `vfp.foxbin2prg` | The path of `foxbin2prg.exe`. It is looked for in the project folder when this is empty. |
| `vfp.buildProgram` | The Visual FoxPro program that builds the project. It is looked for in the project when this is empty. |
| `vfp.projectFile` | The project file of the workspace, for example `myproject.pjx`. |
| `vfp.vfpExe` | The path of the Visual FoxPro program, for example `VFPA.EXE`. It is looked for when this is empty. |
| `vfp.buildOnSave` | Builds the binary file of a text file again when the text file is saved. |
| `vfp.showStatus` | Shows what is out of step in the status bar. |

## A word about FoxBin2Prg

The conversion is done by [FoxBin2Prg](https://github.com/rickyz/FoxBin2Prg),
by Fernando D. Bozzo. It does something that is worth knowing about: it does
not read the code of a form from the text file, it **recompiles** the form to
get at the code, and it writes the recompiled form back to disk.

So the tool works in a scratch folder, and only what it really made is put
back. A form whose code does not compile is left alone, and the reason is
written in the output panel.

The scratch folder is thrown away when the work is done. Windows does not
always let go of a folder that was just written to, because the virus scanner
or the indexer is still looking at it, and then it says:

```
EPERM, Permission denied: ...\Temp\vfp-tools\1792790420581-ezu5ncf4k9
```

That is not a failure and it is not the business of the user: the folder is
empty by then, and it is in the temporary folder. The removal waits for the
hold to be let go of, in the background so that the window keeps answering,
and a folder that still will not go is left for a later run to sweep up.

## The files that are left alone

Some files are never edited by hand, so there is no reason to turn them into
text at all, and no reason for them to be counted as being out of step. The list
of them is `.vfpignore` in the project folder, next to the `.pjx`:

```
# .vfpignore
forms/frm_old.scx          one file, in the forms folder
frm_never.frx              any file with this name, in any folder
reports/legacy/            everything in that folder
*.vcx                      every class library
forms/frm_keep.*           this one is left alone...
!forms/frm_keep.scx        ...but this one is used
```

The list is read by every command that converts a file, so a file that is on it
is left alone by all of them. The rules are the `.gitignore` ones, and they are
written down in the file itself by **VFP: Edit the exclude list**, which makes
the file if it is not there yet.

A file that is left alone is not turned into text, and its text file is not
built back into it. In the panel it is greyed out, with a dash for an icon and
no buttons, and asking for it to be built on purpose says that it is on the list
and does nothing. It is not counted in what is out of step, and it is not in the
marker either, so it never shows up as work that has to be done.

## Building it

```
git clone https://github.com/bryangerlach/vscode-vfp-tools
cd vscode-vfp-tools
npm install
npm run compile
```

The extension is in `out/`. To try it, open this folder in VSCodium and press
F5, or package it with `vsce`.

To build a `.vsix` you can install:

```
npx vsce package --skip-license
```

and then install it with `codium --install-extension vfp-tools-<version>.vsix`.

## The tests

The tests in `test/` work on a copy in the temporary folder, so nothing of the
user is touched.

```
node test/grammar.mjs       && are the colours right? the tokenizer of Visual
                              Studio Code is used, so the answer is the real one
node test/scratch.mjs       && does a scratch folder that Windows will not let
                              go of stay quiet, and does the window keep
                              answering while it waits?
node test/build.mjs         && does a build start Visual FoxPro, run the program
                              and close it again?
node test/marker.mjs        && does the marker agree about which side changed?
node test/form.mjs          && is a form read and drawn right: captions,
                              positions, colours, grids, hidden controls, and
                              what a class library gives a control?
node test/preview.mjs       && does the preview pane follow the form that is being
                              edited, and does the key hide it again?
node test/goto.mjs          && does a name go to its code: DO, SET PROCEDURE,
                              DO FORM, THISFORM and THIS, in the form and in a
                              class library?
node test/ignore.mjs        && does the extension leave alone every file that
                              .vfpignore names, and only those?
node test/installed.mjs     && is the extension in place, with all of its
                              commands and its grammar?
```

`memo-pair.mjs` is opt-in because it needs a real form: set
`VFP_SAMPLE_PROJECT` to a Visual FoxPro project folder. It only reads the
project and works on a copy.
