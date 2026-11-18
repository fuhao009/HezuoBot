import { ipcMain } from "electron";
// Deliberately registered during module evaluation, after the first bootstrap dependency.
ipcMain.handle("debug-smoke:import-time", (_event, value) => value);
ipcMain.on("debug-smoke:sync", event => { event.returnValue = false; });
