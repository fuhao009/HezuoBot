// Compatibility shim: repeated tool calls and results are never intercepted or annotated.
export class ChatRepeatGuard {
  noteAfter(_name: string, _args: string, _result: { ok: boolean; text: string; images?: readonly unknown[] }): undefined {
    return undefined;
  }
}
