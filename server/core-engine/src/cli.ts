import { LocalInput } from './local-input.ts';
import { Conversation } from './core.ts';
import { loadConfig } from './config.ts';
import type { TaskClass } from './model-routing.ts';
import { isScenarioChoice } from './scenarios.ts';
import type { ScenarioChoice } from './scenarios.ts';

const help = `HezuoBot-Core (Node >=24.16)
  npm start -- --message "你好"   One turn
  npm start                     Interactive, in-memory conversation; /exit to quit
  node --env-file=.env src/cli.ts --message "你好"
Required: HEZUO_CORE_MODEL
Optional: HEZUO_CORE_API_KEY (as required by the provider)
          HEZUO_CORE_BASE_URL (default https://api.openai.com/v1)
          All tools for the selected backend are available without separate grants.
          Browser tools include navigation, reading, input and screenshots.
          HEZUO_CORE_BROWSER_HEADLESS=false (visible browser for manual login)
          HEZUO_CORE_BROWSER_BACKEND=legacy|computer_use (default: legacy)
          computer_use controls the primary desktop and foreground application on macOS.
          HEZUO_CORE_DESKTOP_BACKEND=cua|ax (default: cua; computer_use only)
          cua: requires the existing CuaDriver 0.38.0 daemon and window capture permissions.
          ax: uses agent-desktop 1.3.1; HEZUO_CORE_AX_BINARY sets its absolute executable path.
          Select the backend before starting a session; no automatic fallback between backends.
          Both desktop backends retain managed Chromium browser tools and browser screenshots.
          Never send passwords, keys or tokens in chat; CAPTCHA remains manual.
          HEZUO_CORE_WEB_MODEL, HEZUO_CORE_ANALYSIS_MODEL (each falls back to base model)
Routing: --mode auto|default|web_execution|planning_analysis (also /mode VALUE)
         --task web_execution|planning_analysis supplies explicit task metadata for auto.
         auto uses explicit metadata, otherwise base model; no classifier request,
         no guess from future tool names, and no automatic mid-turn phase detection.
Scenario: --scenario auto|web|native|visual|mixed|general (also /scenario VALUE)
          Advisory execution guidance; does not switch the fixed desktop backend.
          /status prints safe current scenario and timing information.
         browser_tabs lists tabs; browser_switch returns to opener, unlike browser_back.
          HEZUO_CORE_SYSTEM
No automatic .env loading, shell, arbitrary JS, gateway or stored history.
Web: browser navigation uses the configured backend. Temporary session.
Local login: visible interactive TTY input; never send credentials in chat.
The tool collects a hidden account/password and fills the current login fields.
No extra confirmation, fixed-origin gate or automatic browser-access pause.
CAPTCHA is manual; submitting fields is not proof of login.
HEZUO_CORE_BROWSER_PERSIST=true opts into local cookies/localStorage save/restore.
Dedicated .local-browser state (0700/0600); not encrypted. Login can expire. Chat is not saved.
/session-save saves now; /session-clear clears disk and disables exit save until explicit save.
Use browser_session_save,browser_session_clear for conversational save/clear.
Normal exit saves when enabled. Crashes/forced termination may lose unsaved state.
Do not submit secrets to the model. Page text and screenshots are untrusted data.
Install Chromium once: npx playwright install chromium
Model HTTP redirects are followed; authorization forwarding follows the HTTP client's rules.
CLI output is untrusted model text; terminal control characters are removed.`;
const safe = (text: string) => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');

let active: Conversation | undefined;
let input: LocalInput | undefined;
let interrupted = false;
const stop = (signal: NodeJS.Signals) => {
  if (interrupted) return;
  interrupted = true;
  process.exitCode = signal === 'SIGINT' ? 130 : 143;
  input?.close();
  void active?.close().catch(() => {});
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
try {
  const args = process.argv.slice(2);
  let mode: TaskClass | 'auto' = 'auto';
  let task: TaskClass | undefined;
  let scenario: ScenarioChoice = 'auto';
  for (let index = 0; index < args.length;) {
    if (args[index] === '--scenario') {
      const value = args[index + 1];
      if (!isScenarioChoice(value)) throw new Error('Invalid execution scenario');
      scenario = value;
      args.splice(index, 2);
      continue;
    }
    if (['--mode', '--task'].includes(args[index])) {
      const flag = args[index];
      const value = args[index + 1];
      if (!(flag === '--mode' ? ['auto', 'default', 'web_execution', 'planning_analysis'] : ['default', 'web_execution', 'planning_analysis']).includes(value)) throw new Error('Invalid routing class');
      if (flag === '--mode') mode = value as TaskClass | 'auto';
      else task = value as TaskClass;
      args.splice(index, 2);
    } else index++;
  }
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) console.log(help);
  else {
    if (args.length && !(args.length === 2 && args[0] === '--message')) throw new Error('Use --help for CLI arguments');
    if (!args.length) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Use --message for non-interactive input');
      input = new LocalInput();
    }
    const conversation = new Conversation(loadConfig(), input);
    conversation.setScenario(scenario);
    active = conversation;
    if (args.length) console.log(safe(await conversation.send(args[1], { task }, mode)));
    else {
      if (!input) throw new Error('Use --message for non-interactive input');
      try {
        for (;;) {
          const text = await input.question('you> (input hidden) ');
          if (text.trim() === '/exit' || input.isClosed) break;
          if (!text.trim()) continue;
          try {
            if (text.trim() === '/session-save') console.log((await conversation.saveBrowserState()).text);
            else if (text.trim() === '/session-clear') console.log((await conversation.clearBrowserState()).text);
            else if (text.trim() === '/browser-resume') console.log((await conversation.resumeBrowserAccess()).text);
            else if (text.trim().startsWith('/mode ')) {
              const value = text.trim().slice(6);
              if (!['auto', 'default', 'web_execution', 'planning_analysis'].includes(value)) throw new Error('Invalid routing class');
              mode = value as TaskClass | 'auto';
              console.log(`Routing mode: ${mode}`);
            }
            else if (text.trim().startsWith('/scenario ')) {
              const value = text.trim().slice(10);
              if (!isScenarioChoice(value)) throw new Error('Invalid execution scenario');
              scenario = value;
              conversation.setScenario(scenario);
              console.log(`Execution scenario: ${scenario}`);
            }
            else if (text.trim() === '/status') console.log(JSON.stringify(conversation.executionState() ?? { phase: 'idle', scenario }));
            else console.log(safe(await conversation.send(text, { task }, mode)));
          } catch { console.error('Turn failed; conversation remains open. Check the current page or desktop before retrying side effects.'); }
        }
      } finally { input.close(); }
    }
  }
} catch (error) {
  const key = process.env.HEZUO_CORE_API_KEY;
  const message = error instanceof Error ? error.message : 'CLI failed';
  console.error(safe(key ? message.split(key).join('[redacted]') : message));
  if (!interrupted) process.exitCode = 1;
} finally {
  input?.close();
  try { await active?.close(); }
  catch { console.error('Session cleanup could not be confirmed.'); if (!interrupted) process.exitCode = 1; }
  if (active) console.log(active.browserStatus());
  if (active?.computerAudit()) console.log(`Computer Use metrics: ${JSON.stringify(active.computerAudit())}`);
  else if (active) console.log(`Run metrics: ${JSON.stringify(active.timingAudit())}`);
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
