Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
root = files.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = root
shell.Run """C:\Program Files\nodejs\node.exe"" """ & root & "\launch-cinema.mjs""", 0, False
