/**
 * Browser-bridge plugin: one local WebSocket endpoint the DSH Browser Control
 * extension connects to, plus the model-facing `browser_*` tools that drive
 * it. The Settings-managed `enabled` flag starts and stops the listener live
 * through dsh-settings' change hook — no reload needed.
 *
 * We deliberately bypass the higher-level `installSettingsSection` helper and
 * talk to the lower-level `sctx.settings.register` API directly: that API
 * predates the helper and is the one stable across every dsh-settings build a
 * consumer is realistically pinned to. Importing the helper on a build that
 * does not export it crashes the whole plugin at module load.
 *
 * Tools stay mounted whenever the plugin does; calling one while the bridge
 * is disabled or the extension is offline fails with a message naming the
 * fix, so the model can tell the user what to do instead of hanging.
 * @module @deepseek-ai/dsh-browser-bridge
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { BridgeServer, cleanupArtifacts } from "./server.js";
/** Cordis plugin name used by loader diagnostics. */
export const name = 'browser-bridge';
/** The tool registry this plugin contributes `browser_*` tools to. */
export const inject = ['tools', 'systemPrompt'];
/** Settings namespace carrying the bridge switch and endpoint options. */
export const BROWSER_BRIDGE_SETTINGS_NAMESPACE = 'browser-bridge';
export const Config = z.object({
    enabled: z.boolean().default(true),
    port: z.number().step(1).min(1024).max(65_535).default(9777),
    token: z.string().default('dsh-local'),
    shotsDir: z.string().default('dsh-browser-shots'),
    focusPolicy: z.union([z.const('preserve'), z.const('steal')]).default('preserve'),
});
const SNAPSHOT_REF_SELECTOR_PATTERN = /^e\d+$/;
const READ_CONTENT_MAX_CHARS = 120_000;
/**
 * Owns zero or one live {@link BridgeServer} and restarts it whenever the
 * resolved settings change. Reconciles serialize through a promise chain so a
 * burst of settings commits cannot interleave stop/start pairs.
 */
class BridgeController {
    log;
    server;
    serverKey = '';
    lastError;
    chain = Promise.resolve();
    current;
    constructor(log) {
        this.log = log;
    }
    /** Resolved directory screenshots land in; defined once any config arrived. */
    get shotsDir() {
        return this.current === undefined ? undefined : path.resolve(this.current.shotsDir);
    }
    /**
     * Converge the live server onto `config`. With `throwOnError`, an initial
     * start failure rejects (fail-loud activation); later changes record the
     * failure instead, so a bad port cannot tear down an otherwise running session.
     * @param config - the freshly resolved settings snapshot.
     * @param options - set `throwOnError` only for the activation-time call.
     * @returns a promise settling once the convergence attempt finished.
     */
    reconcile(config, options = {}) {
        this.current = config;
        const run = this.chain.then(() => this.reconcileNow(config));
        this.chain = run.catch(() => { });
        if (options.throwOnError === true) {
            return run.catch((error) => {
                throw error instanceof Error ? error : new Error(String(error));
            });
        }
        return Promise.resolve();
    }
    async reconcileNow(config) {
        const shotsDir = path.resolve(config.shotsDir);
        const key = config.enabled ? `${config.port}|${config.token}|${shotsDir}|${config.focusPolicy}` : '';
        if (key === this.serverKey)
            return;
        const previous = this.server;
        this.server = undefined;
        this.serverKey = '';
        await previous?.stop();
        if (!config.enabled) {
            this.lastError = undefined;
            return;
        }
        const server = new BridgeServer({ port: config.port, token: config.token, shotsDir, log: this.log });
        try {
            await server.start();
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.lastError = `桥接启动失败（端口 ${config.port}）: ${message}`;
            this.log(this.lastError);
            throw error instanceof Error ? error : new Error(message);
        }
        this.server = server;
        this.serverKey = key;
        this.lastError = undefined;
    }
    /**
     * Run one extension command over the live link.
     * @param command - extension command name (`nav`, `click`, …).
     * @param params - wire params passed through to the extension.
     * @param signal - tool-execution cancellation propagated to the pending command.
     * @returns the extension's result payload verbatim.
     */
    async execute(command, params, signal) {
        const server = this.server;
        if (server === undefined) {
            throw new Error(this.lastError ?? '浏览器控制未启用 —— 到 dsh 设置 → 插件 → DSH 浏览器控制 打开开关');
        }
        // The focus policy is a property of the bridge, not of any single call, so
        // it rides along on every command instead of being threaded through each
        // tool's parameter list. An explicit per-call value still wins, which is
        // what lets one tool opt back into foreground behaviour.
        const merged = params.focusPolicy === undefined
            ? { ...params, focusPolicy: this.current?.focusPolicy ?? 'preserve' }
            : params;
        return server.execute(command, merged, { signal });
    }
    /**
     * Delete generated artifacts using the currently resolved directories;
     * works while the bridge is stopped because it never touches the socket.
     * @returns counts and names of what was removed.
     */
    async cleanup() {
        const dir = this.shotsDir;
        if (dir === undefined)
            throw new Error('浏览器控制尚未加载配置，无法确定清理目录');
        return cleanupArtifacts({ shotsDir: dir });
    }
    /** Stop the listener; safe to call repeatedly and during teardown. */
    stop() {
        const previous = this.server;
        this.server = undefined;
        this.serverKey = '';
        return previous?.stop() ?? Promise.resolve();
    }
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
/** Cap long page reads and mark the cut, so token cost stays bounded. */
function clampText(value, maxChars) {
    return value.length <= maxChars
        ? { content: value, truncated: false }
        : { content: value.slice(0, maxChars), truncated: true };
}
/**
 * Resolve the element target a click/type tool received.
 * @param args - validated tool arguments carrying at most one targeting field.
 * @returns the CSS selector to send on the wire, refs translated to their attribute form.
 */
function targetSelector(args) {
    const hasSelector = typeof args.selector === 'string' && args.selector.length > 0;
    const hasRef = typeof args.ref === 'string' && args.ref.length > 0;
    if (hasSelector === hasRef) {
        throw new Error('provide exactly one of selector or ref (ref comes from browser_snapshot)');
    }
    if (hasRef) {
        const ref = args.ref;
        if (!SNAPSHOT_REF_SELECTOR_PATTERN.test(ref))
            throw new Error(`invalid ref: ${ref}`);
        return `[data-dsh-ref="${ref}"]`;
    }
    return args.selector;
}
/**
 * Render a `tabs.list` payload as a bounded, always-valid summary instead of
 * slicing raw JSON. Slicing mid-structure used to produce fragments that read
 * like the LIST itself was truncated (it never was — the extension returns every
 * tab), which pushed callers into needless workarounds. Counts are stated
 * exactly and only the row preview is capped, so a cut is never mistaken for
 * missing data.
 * @param value - the raw payload from the `tabs.list` command.
 * @returns one line per tab plus an exact count when the preview is capped.
 */
/**
 * Shared `expect` parameter description for the acting tools. One call that
 * states its own success condition replaces the usual "act, then screenshot,
 * then guess" cycle — a screenshot costs 713ms, and is the single slowest tool.
 */
const EXPECT_PARAM_DESCRIPTION = 'Optional post-condition verified in the SAME call, so you do not need a follow-up '
    + 'screenshot or query to learn whether the action worked. Give exactly one of: '
    + '{selector} (element appears), {text} (page text appears), {gone} (page text disappears), '
    + 'or {target, value} (an element reaches an exact value). Optional {timeoutMs} (default 5000, max 120000). '
    + 'The result reports expected.matched — a miss is a normal answer, not an error, so false means '
    + '"not observed yet", not "the call failed".';
const TABS_PREVIEW_LIMIT = 25;
function summarizeTabs(value) {
    const total = typeof value.count === 'number' ? value.count : 0;
    const activeTabId = value.activeTabId;
    const tabs = Array.isArray(value.tabs) ? value.tabs : [];
    if (tabs.length === 0)
        return `${total} tab(s) open; no tab details returned`;
    const shown = tabs.slice(0, TABS_PREVIEW_LIMIT);
    // Chrome refuses the debugger protocol on two classes of target (another
    // extension's pages, and browser-internal chrome:// pages). The extension
    // tags them, and saying so inline is what keeps the agent from planning work
    // against a tab that can never be read or clicked.
    const restrictedCount = tabs.filter(tab => {
        const row = tab;
        return typeof row.restricted === 'string' && row.restricted.length > 0;
    }).length;
    const lines = shown.map(tab => {
        const row = tab;
        const marker = row.id === activeTabId ? '*' : ' ';
        const title = typeof row.title === 'string' && row.title.length > 0 ? row.title : '(untitled)';
        const blocked = typeof row.restricted === 'string' && row.restricted.length > 0
            ? `  [not automatable: ${row.restricted}]`
            : '';
        return `${marker} ${String(row.id)}  ${title.slice(0, 80)} — ${String(row.url ?? '').slice(0, 120)}${blocked}`;
    });
    const header = `${total} tab(s) open; ${shown.length} shown (* = active)`;
    const restrictedNote = restrictedCount > 0
        ? `\n${restrictedCount} tab(s) marked "not automatable": Chrome blocks the debugger protocol on another extension's pages and on chrome:// pages. Those tabs can be listed, opened, closed and navigated, but never read or clicked — hand that step to the user.`
        : '';
    const footer = tabs.length > shown.length
        ? `\n… and ${tabs.length - shown.length} more (raise detail by calling browser_tabs again; the full list is always returned)`
        : '';
    return `${header}\n${lines.join('\n')}${restrictedNote}${footer}`;
}
function requireTabId(args, action) {
    if (typeof args.tabId !== 'number')
        throw new Error(`${action} requires tabId`);
    return args.tabId;
}
/** Write one screenshot payload to the shots directory and return its durable location. */
async function saveScreenshot(controller, payload) {
    const dir = controller.shotsDir;
    if (dir === undefined)
        throw new Error('browser-bridge is not configured yet');
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const random = Math.random().toString(36).slice(2, 6);
    const file = path.join(dir, `${stamp}-${random}.${payload.format === 'jpeg' ? 'jpg' : 'png'}`);
    const buffer = Buffer.from(payload.base64, 'base64');
    await writeFile(file, buffer);
    return {
        file,
        bytes: buffer.length,
        tabId: payload.tabId,
        title: payload.tabTitle,
        url: payload.tabUrl,
    };
}
/** Write one PDF payload to `path` (absolute or relative to `controller.shotsDir`)
 *  and return the absolute path + size. Mirrors saveScreenshot's contract. */
async function savePdf(controller, payload, requestedPath) {
    const dir = controller.shotsDir;
    if (dir === undefined)
        throw new Error('browser-bridge is not configured yet');
    let file;
    if (requestedPath && path.isAbsolute(requestedPath)) {
        file = requestedPath;
        await mkdir(path.dirname(file), { recursive: true });
    }
    else {
        await mkdir(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const random = Math.random().toString(36).slice(2, 6);
        const name = requestedPath ? path.basename(requestedPath) : `${stamp}-${random}.pdf`;
        file = path.join(dir, name);
    }
    const buffer = Buffer.from(payload.base64, 'base64');
    await writeFile(file, buffer);
    return {
        file,
        bytes: buffer.length,
        tabId: payload.tabId,
        ...(payload.tabTitle === undefined ? {} : { title: payload.tabTitle }),
        ...(payload.tabUrl === undefined ? {} : { url: payload.tabUrl }),
    };
}
/** Register every `browser_*` tool; each is a thin adapter over one extension command. */
function applyBrowserTools(ctx, controller) {
    ctx.systemPrompt.section({
        name: 'tool:browser',
        order: 112,
        text: 'The browser_* tools drive the user\'s real, logged-in browser through the DSH '
            + 'Browser Control extension; they act on the active tab unless a tabId is passed. '
            + 'Prefer browser_snapshot first on unfamiliar pages: it numbers interactive elements, '
            + 'and browser_click/browser_type accept the returned ref instead of guessing CSS selectors. '
            + 'browser_read extracts page text, browser_screenshot saves a PNG/JPEG and returns its file '
            + 'path (view it with an image tool). Calls fail with actionable copy while the bridge is '
            + 'disabled or no browser is connected.\n\n'
            + 'SHARING THE BROWSER WITH THE USER: by default (focusPolicy=preserve) the tools never '
            + 'activate a tab or focus a window, so the user can keep working while you operate. '
            + 'Reads (browser_read, browser_evaluate, browser_snapshot, screenshots) are always '
            + 'background-safe. Actions that normally need foreground input are re-routed: an '
            + 'affected result carries inputDegraded (e.g. "dom-synthetic", "fill-instead-of-type") '
            + 'meaning it was synthesised in-page rather than delivered as a trusted OS event. '
            + 'Treat inputDegraded as a signal, not a failure: check the returned state (value, '
            + 'formSubmitted, page change) before assuming the action did not land, and only '
            + 'retry with focusPolicy="steal" when a widget provably ignores synthetic events '
            + '(isTrusted gates, native browser shortcuts, canvas/pointer-drag interactions) — '
            + 'that retry interrupts whatever the user is doing, so prefer tabId-targeted reads '
            + 'or asking the user first. browser_tabs activate and an explicit active:true on '
            + 'browser_tabs open are always respected as deliberate foreground requests.\n\n'
            + 'WHAT CANNOT BE AUTOMATED: Chrome blocks the debugger protocol on two classes of '
            + 'page, so no browser_* read or click will ever work on them. This is a browser '
            + 'security boundary, not a transient failure — never retry it: (1) another '
            + "extension's pages, chrome-extension://<some other id>/… such as Tampermonkey's "
            + 'install or editor UI; (2) browser-internal pages, chrome://… and edge://… . '
            + 'browser_tabs list marks such tabs "restricted", and a refused call reports code '
            + 'restricted_other_extension or restricted_browser_internal. Listing, opening, '
            + 'closing and navigating them still work, and their url and title stay readable — '
            + 'only in-page access is blocked. When a task needs one, stop and hand that single '
            + 'step to the user with a concrete instruction, then carry on with the rest.\n\n'
            + 'PICK THE CHEAPEST WAY TO OBSERVE. Measured on real pages, the cost spread is '
            + 'roughly 200x between strategies, so escalate a level only when the one above '
            + 'genuinely cannot answer: (1) browser_evaluate reading exactly the fields you '
            + 'need — ~30 bytes, single-digit ms; (2) browser_read for the page as text — '
            + 'kilobytes; (3) browser_snapshot then browser_click by ref — one round trip for '
            + 'the interactive map, and prefer it over guessing CSS selectors; (4) '
            + 'browser_screenshot LAST — it is the slowest tool (~700ms) and returns a file '
            + 'path you must then open. browser_read(mode:"html") is almost always a mistake: '
            + 'it returned 126KB where an evaluate of the same page returned 33 bytes, and it '
            + 'rarely contains anything evaluate cannot reach. Reads and evaluation never '
            + 'disturb the user; prefer them over acting whenever reading suffices.\n\n'
            + 'STATE THE OUTCOME INSTEAD OF CHECKING LATER: browser_click, browser_type and '
            + 'browser_press accept an optional expect ({selector}|{text}|{gone}|{target,value}) '
            + 'that is verified inside the same call and reported as expected.matched. Use it '
            + 'whenever you would otherwise take a screenshot or issue a separate evaluate to '
            + 'find out whether the action landed. A false expected.matched means "not observed '
            + 'within the timeout", not "the call failed" — decide from it rather than retrying '
            + 'blindly.',
    });
    ctx.tools.register(defineTool({
        name: 'browser_navigate',
        description: 'Navigate a browser tab to a URL and wait for the page load to settle.',
        parameters: {
            url: { type: 'string', required: true, description: 'Absolute URL to open in the tab.' },
            tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    tabId: { type: 'number', required: true },
                    url: { type: 'string' },
                    title: { type: 'string' },
                },
            },
            render: (_args, value) => {
                const label = [value.title, value.url].filter(part => typeof part === 'string' && part.length > 0).join(' — ');
                return [{ type: 'text', text: `Tab ${value.tabId} now shows ${label.length > 0 ? label : '(untitled)'}` }];
            },
        },
        isConcurrencySafe: () => false,
        presentCall: args => ({ card: 'generic', title: `Open ${args.url}`, kind: 'other' }),
        async execute(args, exec) {
            const params = { url: args.url };
            if (args.tabId !== undefined)
                params.tabId = args.tabId;
            return await controller.execute('nav', params, exec.signal);
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_read',
        description: 'Read the current page: title, URL, ready state, and body text (or full HTML).',
        parameters: {
            tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
            mode: { type: 'string', description: '"text" (default) for visible text, "html" for the whole document.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    tabId: { type: 'number', required: true },
                    mode: { type: 'string', required: true },
                    title: { type: 'string', required: true },
                    url: { type: 'string', required: true },
                    content: { type: 'string', required: true },
                    truncated: { type: 'boolean', required: true },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: `${value.title} (${value.url}) — ${value.content.length} chars${value.truncated ? ', truncated' : ''}`,
                }],
        },
        presentCall: () => ({ card: 'generic', title: 'Read browser page', kind: 'other' }),
        async execute(args, exec) {
            const mode = args.mode === 'html' ? 'html' : 'text';
            const raw = await controller.execute('content', args.tabId === undefined ? { mode } : { mode, tabId: args.tabId }, exec.signal);
            const clamped = clampText(raw.content ?? '', READ_CONTENT_MAX_CHARS);
            return {
                tabId: raw.tabId,
                mode,
                title: raw.title ?? '',
                url: raw.url ?? '',
                content: clamped.content,
                truncated: clamped.truncated,
            };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_snapshot',
        description: 'Inventory the page\'s interactive elements with stable refs; pass a ref to browser_click/browser_type afterwards.',
        parameters: {
            tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
            limit: { type: 'number', description: 'Max elements returned; defaults to 120, capped at 200.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    tabId: { type: 'number', required: true },
                    title: { type: 'string', required: true },
                    url: { type: 'string', required: true },
                    items: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                ref: { type: 'string', required: true },
                                tag: { type: 'string', required: true },
                                name: { type: 'string' },
                                href: { type: 'string' },
                            },
                        },
                    },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: `${value.items.length} interactive elements on ${value.title}; click or fill them by ref.`,
                }],
        },
        presentCall: () => ({ card: 'generic', title: 'Snapshot browser page', kind: 'other' }),
        async execute(args, exec) {
            const limit = Math.min(200, Math.max(1, args.limit ?? 120));
            const raw = await controller.execute('snapshot', args.tabId === undefined ? { limit } : { limit, tabId: args.tabId }, exec.signal);
            return {
                tabId: raw.tabId,
                title: raw.title ?? '',
                url: raw.url ?? '',
                items: (raw.items ?? []).map(item => ({
                    ref: item.ref,
                    tag: item.tag,
                    ...(item.name === undefined ? {} : { name: item.name }),
                    ...(item.href === undefined ? {} : { href: item.href }),
                })),
            };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_click',
        description: 'Click a page element with real mouse events; target it by snapshot ref or CSS selector.',
        parameters: {
            ref: { type: 'string', description: 'Element ref from browser_snapshot (e.g. "e3"); wins over selector.' },
            selector: { type: 'string', description: 'CSS selector; ignored when ref is given.' },
            tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
            doubleClick: { type: 'boolean', description: 'Send a double click instead.' },
            focusPolicy: { type: 'string', description: "Per-call override of the plugin's focusPolicy: 'preserve' keeps the user's tab untouched (DOM-synthetic click), 'steal' activates the tab for a trusted mouse event." },
            expect: {
                type: 'object',
                additionalProperties: false,
                description: EXPECT_PARAM_DESCRIPTION,
                properties: {
                    selector: { type: 'string', description: 'Wait until this CSS selector matches an element.' },
                    text: { type: 'string', description: 'Wait until the page text contains this string.' },
                    gone: { type: 'string', description: 'Wait until the page text no longer contains this string.' },
                    target: { type: 'string', description: 'With value: the CSS selector whose value is checked.' },
                    value: { type: 'string', description: 'With target: the exact value the element must reach.' },
                    timeoutMs: { type: 'number', description: 'Budget in ms; default 5000, max 120000.' },
                },
            },
        },
        output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value).slice(0, 300) }],
        },
        presentCall: args => ({ card: 'generic', title: `Click ${args.ref ?? args.selector ?? ''}`, kind: 'other' }),
        async execute(args, exec) {
            const params = { selector: targetSelector(args) };
            if (args.tabId !== undefined)
                params.tabId = args.tabId;
            if (args.doubleClick !== undefined)
                params.doubleClick = args.doubleClick;
            if (args.focusPolicy !== undefined)
                params.focusPolicy = args.focusPolicy;
            if (args.expect !== undefined)
                params.expect = args.expect;
            return await controller.execute('click', params, exec.signal);
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_type',
        description: 'Fill an input/textarea/select/contentEditable (React-compatible events); optionally press Enter afterwards.',
        parameters: {
            value: { type: 'string', required: true, description: 'Text to put into the element.' },
            ref: { type: 'string', description: 'Element ref from browser_snapshot; wins over selector.' },
            selector: { type: 'string', description: 'CSS selector; ignored when ref is given.' },
            tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
            submit: { type: 'boolean', description: 'Press Enter after filling.' },
            mode: { type: 'string', description: "How the text lands: 'fill' (default) sets the value directly; 'type' replays real key events for keystroke-sensitive widgets but needs OS focus, so under focusPolicy=preserve it degrades to fill and reports inputDegraded." },
            focusPolicy: { type: 'string', description: "Per-call override of the plugin's focusPolicy: 'preserve' keeps the user's tab untouched, 'steal' activates the tab so real key events land." },
            expect: {
                type: 'object',
                additionalProperties: false,
                description: EXPECT_PARAM_DESCRIPTION,
                properties: {
                    selector: { type: 'string', description: 'Wait until this CSS selector matches an element.' },
                    text: { type: 'string', description: 'Wait until the page text contains this string.' },
                    gone: { type: 'string', description: 'Wait until the page text no longer contains this string.' },
                    target: { type: 'string', description: 'With value: the CSS selector whose value is checked.' },
                    value: { type: 'string', description: 'With target: the exact value the element must reach.' },
                    timeoutMs: { type: 'number', description: 'Budget in ms; default 5000, max 120000.' },
                },
            },
        },
        output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value).slice(0, 300) }],
        },
        presentCall: args => ({ card: 'generic', title: `Type into ${args.ref ?? args.selector ?? 'element'}`, kind: 'other' }),
        async execute(args, exec) {
            const params = { selector: targetSelector(args), value: args.value };
            if (args.tabId !== undefined)
                params.tabId = args.tabId;
            if (args.mode !== undefined)
                params.mode = args.mode;
            if (args.focusPolicy !== undefined)
                params.focusPolicy = args.focusPolicy;
            if (args.expect !== undefined)
                params.expect = args.expect;
            const filled = await controller.execute('input', params, exec.signal);
            if (args.submit === true) {
                await controller.execute('press', args.tabId === undefined ? { key: 'Enter' } : { key: 'Enter', tabId: args.tabId }, exec.signal);
            }
            return filled;
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_press',
        description: 'Send a real keyboard event to the page (Enter, Tab, Escape, arrows, or a single character).',
        parameters: {
            key: { type: 'string', required: true, description: 'Named key (Enter, Escape, ArrowDown…) or a single character.' },
            tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
            focusPolicy: { type: 'string', description: "Per-call override of the plugin's focusPolicy: 'preserve' dispatches an untrusted in-page KeyboardEvent, 'steal' activates the tab for a real key event." },
            expect: {
                type: 'object',
                additionalProperties: false,
                description: EXPECT_PARAM_DESCRIPTION,
                properties: {
                    selector: { type: 'string', description: 'Wait until this CSS selector matches an element.' },
                    text: { type: 'string', description: 'Wait until the page text contains this string.' },
                    gone: { type: 'string', description: 'Wait until the page text no longer contains this string.' },
                    target: { type: 'string', description: 'With value: the CSS selector whose value is checked.' },
                    value: { type: 'string', description: 'With target: the exact value the element must reach.' },
                    timeoutMs: { type: 'number', description: 'Budget in ms; default 5000, max 120000.' },
                },
            },
        },
        output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value).slice(0, 300) }],
        },
        presentCall: args => ({ card: 'generic', title: `Press ${args.key}`, kind: 'other' }),
        async execute(args, exec) {
            const params = { key: args.key };
            if (args.tabId !== undefined)
                params.tabId = args.tabId;
            if (args.focusPolicy !== undefined)
                params.focusPolicy = args.focusPolicy;
            if (args.expect !== undefined)
                params.expect = args.expect;
            return await controller.execute('press', params, exec.signal);
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_scroll',
        description: 'Scroll the page viewport by a delta and report the resulting position.',
        parameters: {
            x: { type: 'number', description: 'Horizontal delta in pixels; defaults to 0.' },
            y: { type: 'number', description: 'Vertical delta in pixels; positive scrolls down.' },
            tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
        },
        output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value).slice(0, 300) }],
        },
        presentCall: () => ({ card: 'generic', title: 'Scroll browser page', kind: 'other' }),
        async execute(args, exec) {
            const params = { x: args.x ?? 0, y: args.y ?? 0 };
            if (args.tabId !== undefined)
                params.tabId = args.tabId;
            return await controller.execute('scroll', params, exec.signal);
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_tabs',
        description: 'List tabs, or open/close/activate one. Actions act on real browser windows. Tabs on another extension\'s pages or on chrome:// pages carry a "restricted" marker: they can be listed, opened, closed and navigated, but never read or clicked, because Chrome blocks the debugger protocol there.',
        parameters: {
            action: { type: 'string', required: true, description: 'One of: list, open, close, activate.' },
            url: { type: 'string', description: 'URL for the open action.' },
            tabId: { type: 'number', description: 'Target tab for close/activate.' },
            active: { type: 'boolean', description: 'Whether a newly opened tab becomes active; defaults to true.' },
        },
        output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => [{ type: 'text', text: summarizeTabs(value) }],
        },
        presentCall: args => ({ card: 'generic', title: `Browser tabs: ${args.action}`, kind: 'other' }),
        async execute(args, exec) {
            switch (args.action) {
                case 'list':
                    return await controller.execute('tabs.list', {}, exec.signal);
                case 'open': {
                    if (typeof args.url !== 'string' || args.url.length === 0)
                        throw new Error('open requires url');
                    const params = { url: args.url };
                    if (args.active !== undefined)
                        params.active = args.active;
                    return await controller.execute('tabs.open', params, exec.signal);
                }
                case 'close':
                    return await controller.execute('tabs.close', { tabId: requireTabId(args, 'close') }, exec.signal);
                case 'activate':
                    return await controller.execute('tabs.activate', { tabId: requireTabId(args, 'activate') }, exec.signal);
                default:
                    throw new Error(`unknown tabs action: ${String(args.action)} (use list|open|close|activate)`);
            }
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_evaluate',
        description: 'Run JavaScript in the page and get the JSON result back as a string. Prefer read-only inspection.',
        parameters: {
            expression: { type: 'string', required: true, description: 'JavaScript expression or statement sequence; awaited like a promise body.' },
            tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
            timeoutMs: { type: 'number', description: 'Wall-clock budget in ms (100-120000). Omit for no client-side deadline; set it when the expression may await something slow.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    tabId: { type: 'number', required: true },
                    json: { type: 'string', required: true },
                },
            },
            render: (_args, value) => [{ type: 'text', text: value.json.slice(0, 300) }],
        },
        presentCall: () => ({ card: 'generic', title: 'Evaluate in page', kind: 'other' }),
        async execute(args, exec) {
            const evalParams = { expression: args.expression };
            if (args.tabId !== undefined)
                evalParams.tabId = args.tabId;
            if (args.timeoutMs !== undefined)
                evalParams.timeoutMs = args.timeoutMs;
            const raw = await controller.execute('eval', evalParams, exec.signal);
            let json;
            try {
                json = JSON.stringify(raw.value) ?? String(raw.value);
            }
            catch {
                json = String(raw.value);
            }
            return { tabId: raw.tabId, json };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_screenshot',
        description: 'Capture the tab as PNG/JPEG, save it under the configured shots directory, and return the absolute file path.',
        parameters: {
            tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
            fullPage: { type: 'boolean', description: 'Capture beyond the viewport.' },
            format: { type: 'string', description: '"png" (default) or "jpeg".' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    file: { type: 'string', required: true },
                    bytes: { type: 'number', required: true },
                    tabId: { type: 'number', required: true },
                    title: { type: 'string' },
                    url: { type: 'string' },
                },
            },
            render: (_args, value) => [{ type: 'text', text: `Saved ${value.file} (${value.bytes} bytes)` }],
        },
        presentCall: () => ({ card: 'generic', title: 'Browser screenshot', kind: 'other' }),
        async execute(args, exec) {
            const format = args.format === 'jpeg' ? 'jpeg' : 'png';
            const params = { format };
            if (args.tabId !== undefined)
                params.tabId = args.tabId;
            if (args.fullPage !== undefined)
                params.fullPage = args.fullPage;
            const payload = await controller.execute('screenshot', params, exec.signal);
            return saveScreenshot(controller, payload);
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_cleanup',
        description: 'Delete generated screenshots and agent scratch files (__-prefixed temp scripts/artifacts) from their top-level directories.',
        parameters: {},
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    shotsRemoved: { type: 'number', required: true },
                    scratchRemoved: { type: 'array', required: true, items: { type: 'string' } },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: `Cleaned ${value.shotsRemoved} screenshot(s) and ${value.scratchRemoved.length} scratch file(s)`,
                }],
        },
        presentCall: () => ({ card: 'generic', title: 'Clean up browser artifacts', kind: 'other' }),
        async execute() {
            const result = await controller.cleanup();
            return { shotsRemoved: result.shotsRemoved, scratchRemoved: Array.from(result.scratchRemoved) };
        },
    }));
    // v1.0.7: console + network capture, PDF export, device emulation.
    ctx.tools.register(defineTool({
        name: 'browser_console_log',
        description: 'Read the captured `console.log/info/warn/error` entries for a tab. Set `clear:true` to also empty the buffer so the next call shows only entries recorded after this one. Useful for "what did the page log after I clicked submit".',
        parameters: {
            tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
            levels: { type: 'array', items: { type: 'string' }, description: 'Filter to one or more of: log, info, warn, error, debug.' },
            pattern: { type: 'string', description: 'Regex (case-insensitive) matched against the formatted text.' },
            limit: { type: 'number', description: 'Maximum entries to return; default 100, capped at 500.' },
            clear: { type: 'boolean', description: 'Empty the buffer after reading.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    tabId: { type: 'number', required: true },
                    count: { type: 'number', required: true },
                    total: { type: 'number', required: true },
                    entries: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {} } },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: `Tab ${value.tabId}: ${value.count} of ${value.total} console entries`,
                }],
        },
        presentCall: () => ({ card: 'generic', title: 'Read browser console', kind: 'other' }),
        async execute(args, exec) {
            const params = {};
            if (args.tabId !== undefined)
                params.tabId = args.tabId;
            if (Array.isArray(args.levels))
                params.levels = args.levels;
            if (typeof args.pattern === 'string')
                params.pattern = args.pattern;
            if (typeof args.limit === 'number')
                params.limit = args.limit;
            if (args.clear === true)
                params.clear = true;
            return await controller.execute('console.log', params, exec.signal);
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_network_log',
        description: 'Read captured HTTP request/response pairs for a tab. `includeStatic:true` adds images / fonts / stylesheets / scripts (filtered by default — they dominate the buffer). `methodPattern` / `urlPattern` / `status` filter server-side results; `clear:true` empties the buffer.',
        parameters: {
            tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
            includeStatic: { type: 'boolean', description: 'Include images / fonts / stylesheets / scripts. Default false.' },
            methodPattern: { type: 'string', description: 'Regex (case-insensitive) matched against the HTTP method.' },
            urlPattern: { type: 'string', description: 'Regex (case-insensitive) matched against the URL.' },
            status: { type: 'string', description: 'One of: 2xx, 3xx, 4xx, 5xx, failed, pending.' },
            limit: { type: 'number', description: 'Maximum entries to return; default 200, capped at 1000.' },
            clear: { type: 'boolean', description: 'Empty the buffer after reading.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    tabId: { type: 'number', required: true },
                    count: { type: 'number', required: true },
                    total: { type: 'number', required: true },
                    requests: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {} } },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: `Tab ${value.tabId}: ${value.count} of ${value.total} network requests`,
                }],
        },
        presentCall: () => ({ card: 'generic', title: 'Read browser network log', kind: 'other' }),
        async execute(args, exec) {
            const params = {};
            if (args.tabId !== undefined)
                params.tabId = args.tabId;
            if (args.includeStatic === true)
                params.includeStatic = true;
            if (typeof args.methodPattern === 'string')
                params.methodPattern = args.methodPattern;
            if (typeof args.urlPattern === 'string')
                params.urlPattern = args.urlPattern;
            if (typeof args.status === 'string')
                params.status = args.status;
            if (typeof args.limit === 'number')
                params.limit = args.limit;
            if (args.clear === true)
                params.clear = true;
            return await controller.execute('network.log', params, exec.signal);
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_network_clear',
        description: 'Empty the per-tab network capture buffer without returning the rows.',
        parameters: {
            tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    tabId: { type: 'number', required: true },
                    cleared: { type: 'boolean', required: true },
                },
            },
            render: (_args, value) => [{ type: 'text', text: `Tab ${value.tabId}: network log cleared` }],
        },
        presentCall: () => ({ card: 'generic', title: 'Clear browser network log', kind: 'other' }),
        async execute(args, exec) {
            const params = {};
            if (args.tabId !== undefined)
                params.tabId = args.tabId;
            return await controller.execute('network.clear', params, exec.signal);
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_pdf',
        description: 'Export the current page to a PDF. `path` may be absolute (saved there) or omitted (saved under the configured shotsDir). Returns the absolute path + size; the PDF preserves text (selectable, searchable) and print-media CSS.',
        parameters: {
            tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
            path: { type: 'string', description: 'Absolute path. Omit to save under the configured shotsDir with a timestamped name.' },
            landscape: { type: 'boolean', description: 'Use landscape orientation.' },
            printBackground: { type: 'boolean', description: 'Render CSS backgrounds. Default true.' },
            paperWidth: { type: 'number', description: 'Paper width in inches.' },
            paperHeight: { type: 'number', description: 'Paper height in inches.' },
            scale: { type: 'number', description: 'Page scale (0.1–2.0).' },
            pageRanges: { type: 'string', description: 'Sub-range, e.g. "1-3" or "1,4-6".' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    file: { type: 'string', required: true },
                    bytes: { type: 'number', required: true },
                    tabId: { type: 'number', required: true },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: `PDF written to ${value.file} (${(value.bytes / 1024).toFixed(1)} KB)`,
                }],
        },
        presentCall: args => ({ card: 'generic', title: `Save PDF${args.path ? ' → ' + args.path : ''}`, kind: 'other' }),
        async execute(args, exec) {
            const params = {};
            if (args.tabId !== undefined)
                params.tabId = args.tabId;
            if (args.landscape === true)
                params.landscape = true;
            if (args.printBackground === false)
                params.printBackground = false;
            if (typeof args.paperWidth === 'number')
                params.paperWidth = args.paperWidth;
            if (typeof args.paperHeight === 'number')
                params.paperHeight = args.paperHeight;
            if (typeof args.scale === 'number')
                params.scale = args.scale;
            if (typeof args.pageRanges === 'string')
                params.pageRanges = args.pageRanges;
            const payload = await controller.execute('pdf', params, exec.signal);
            return await savePdf(controller, payload, typeof args.path === 'string' ? args.path : undefined);
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_emulate',
        description: 'Switch the tab into a device viewport (mobile / tablet / desktop) for responsive-UI testing. `device:"reset"` restores the user\'s actual viewport. Custom `width`/`height`/`deviceScaleFactor`/`isMobile`/`hasTouch` override any preset field.',
        parameters: {
            tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
            device: { type: 'string', description: 'Preset: desktop | mobile-iphone-13 | mobile-pixel-7 | tablet-ipad | reset. Or pass custom width/height below.' },
            width: { type: 'number', description: 'Custom viewport width in CSS px.' },
            height: { type: 'number', description: 'Custom viewport height in CSS px.' },
            deviceScaleFactor: { type: 'number', description: 'Custom DPR (1 = standard, 2 = retina, 3 = super-retina).' },
            isMobile: { type: 'boolean', description: 'Pass as mobile to the page (affects responsive meta).' },
            hasTouch: { type: 'boolean', description: 'Enable touch event dispatch.' },
            userAgent: { type: 'string', description: 'Custom User-Agent string. Empty string clears.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    tabId: { type: 'number', required: true },
                    reset: { type: 'boolean' },
                    width: { type: 'number' },
                    height: { type: 'number' },
                    deviceScaleFactor: { type: 'number' },
                    isMobile: { type: 'boolean' },
                    hasTouch: { type: 'boolean' },
                    userAgent: { type: 'string' },
                },
            },
            render: (_args, value) => {
                if (value.reset)
                    return [{ type: 'text', text: `Tab ${value.tabId}: emulation reset to default` }];
                return [{
                        type: 'text',
                        text: `Tab ${value.tabId}: ${value.width || '?'}×${value.height || '?'} DPR=${value.deviceScaleFactor ?? '?'} mobile=${value.isMobile ?? false} touch=${value.hasTouch ?? false}`,
                    }];
            },
        },
        presentCall: args => ({ card: 'generic', title: `Emulate${args.device ? ' ' + args.device : ' device'}`, kind: 'other' }),
        async execute(args, exec) {
            const params = {};
            if (args.tabId !== undefined)
                params.tabId = args.tabId;
            if (typeof args.device === 'string')
                params.device = args.device;
            if (typeof args.width === 'number')
                params.width = args.width;
            if (typeof args.height === 'number')
                params.height = args.height;
            if (typeof args.deviceScaleFactor === 'number')
                params.deviceScaleFactor = args.deviceScaleFactor;
            if (typeof args.isMobile === 'boolean')
                params.isMobile = args.isMobile;
            if (typeof args.hasTouch === 'boolean')
                params.hasTouch = args.hasTouch;
            if (typeof args.userAgent === 'string')
                params.userAgent = args.userAgent;
            return await controller.execute('emulate', params, exec.signal);
        },
    }));
}
/** Cordis plugin entry: wire the settings-driven lifecycle plus the model-facing tools. */
export function apply(ctx, config) {
    const resolved = config;
    if (resolved.enabled && resolved.token.trim().length === 0) {
        throw new Error('browser-bridge: token must be a non-empty string when enabled');
    }
    const controller = new BridgeController(line => ctx.logger.info(line));
    let current = () => resolved;
    // Equivalent of @deepseek-ai/dsh-settings' `installSettingsSection`, inlined so
    // the plugin still loads on dsh-settings builds that predate the helper. The
    // underlying `sctx.settings.register` API is the one stable across every
    // dsh-settings version a consumer is realistically pinned to.
    ctx.inject(['settings'], (sctx) => {
        const scope = sctx.settings.register(BROWSER_BRIDGE_SETTINGS_NAMESPACE, Config, {
            base: config,
            validate: (value) => {
                if (value.enabled && (value.token ?? '').trim().length === 0) {
                    throw new Error('browser-bridge: token must be a non-empty string when enabled');
                }
            },
        });
        current = () => scope.get();
        ctx.effect(() => () => {
            // Mirror `isUnloading` from dsh-settings (private): the fiber's own
            // unload path runs the disposer too, and there re-applying the
            // composition entry and firing `onChange` would re-register routes
            // against a fiber whose resources are being released.
            if (ctx.fiber.state === 4 /* FiberState.DISPOSED */ || ctx.fiber.state === 5 /* FiberState.UNLOADING */)
                return;
            current = () => resolved;
            void controller.reconcile(current());
        }, 'browser-bridge: settings cleanup');
        void controller.reconcile(current());
        scope.watch(() => {
            if (ctx.fiber.state === 4 /* FiberState.DISPOSED */ || ctx.fiber.state === 5 /* FiberState.UNLOADING */)
                return;
            void controller.reconcile(current());
        });
    });
    // Activation converges loudly so a bad port fails the plugin at load;
    // later settings commits degrade to recorded errors instead.
    controller.reconcile(resolved, { throwOnError: resolved.enabled }).catch((error) => {
        throw new Error(`browser-bridge: ${errorMessage(error)}`);
    });
    applyBrowserTools(ctx, controller);
    ctx.effect(() => () => {
        void controller.stop();
    }, 'browser-bridge: server lifecycle');
}
