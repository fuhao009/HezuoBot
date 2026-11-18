export declare function skipped(name: string, directory: boolean): boolean;
export declare function validWirePath(path: unknown): path is string;
export declare function windowsProblem(path: string): "characters" | "trailing" | "reserved" | null;
export declare function foldKey(path: string): string;
export declare function clashPath(path: string, at: number, taken: (path: string) => boolean, label?: string): string;
export declare function safeFolderName(name: string, taken: ReadonlySet<string>): string;
export declare function neverFromCloud(path: string): boolean;
