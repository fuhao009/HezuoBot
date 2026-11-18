// This must be main.mjs's first dependency: ESM evaluates it before sibling
// modules that register Electron IPC handlers as an import side effect.
import { app, ipcMain, webContents, utilityProcess } from "electron";
import { installMainDebug } from "./debug-main.mjs";

installMainDebug({ app, ipcMain, webContents, utilityProcess });
