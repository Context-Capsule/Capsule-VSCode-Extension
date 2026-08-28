PID reconciliation regression fixture

CLI-observed VS Code descendant shell PIDs: 100, 200, 300
Actual VS Code integrated terminal processIds: 100
Shell-integration tracked running terminal processIds: 100
Expected: PID 100 matched; PIDs 200 and 300 ignored as nested/helper shells; no missing terminal coverage.
