import { createHash, randomUUID } from 'node:crypto';
import { AgentClient, clientFailure } from '../agent-client/client.js';
import { canonicalJson, METHOD_SPECS, type AgentEvent, type RpcResult } from '../agent-server/protocol.js';
import { parseArguments, parseJsonObject, tokenizeCommand, usage, type ParsedArguments } from './arguments.js';
import { COMMAND_SPECS, executeCommand, parseBudget, parseCommand, renderHelp, supportsServerSecretImport, type CommandExecution, type CommandSpec } from './commands.js';
import { DraftBuffer, readCommandInput } from './input.js';
import { TerminalSession, type TerminalKey } from './terminal.js';
import { TerminalRenderer, cleanText, terminalSafeText, wrapText, type TerminalView } from './renderer.js';
import { cancelExecution, ConversationMonitor, eventText, resolveRunResult } from './watch.js';
import { decodeArtifactJson } from '../agent-client/artifacts.js';
import type { CliStreams } from './main.js';
import type { MascotState } from './graphics/assets.js';
import { editDraftText } from './editor.js';
import { artifactMetadata, formatExecutionText, humanJson } from './presentation.js';
import { conversationSummary, graphicsSummary, interactiveResultLines } from './ui-results.js';
import { prepareCliInputReferences } from './references.js';
import { readConfigurationCliPreferences } from './configuration-commands.js';
import type { AmbiguousWidth } from './configuration-width.js';

type MenuItem = { label: string; detail?: string; action: () => void | Promise<void>; disabled?: string };
type Menu = { title: string; items: MenuItem[]; index: number; startup?: boolean; query?: string; commandMenu?: boolean; sourceItems?: MenuItem[] };
type Field = { key: string; label: string; defaultValue?: string; choices?: string[]; hidden?: boolean; required?: boolean; preserveWhitespace?: boolean;
    validate?: (text: string, values: Readonly<Record<string, string>>) => string | undefined };
type Form = { title: string; fields: Field[]; index: number; values: Record<string, string>; draft: DraftBuffer; complete: (values: Record<string, string>) => Promise<void> };
type PendingDraft = { commandId: string; conversationId: string; revision: number; draft: DraftBuffer; text?: string };

function rows(data: unknown): Record<string, unknown>[] {
    if (Array.isArray(data)) return data as Record<string, unknown>[];
    if (data && typeof data === 'object') {
        const value = data as Record<string, unknown>;
        for (const key of ['items', 'entries', 'profiles', 'models', 'interactions']) if (Array.isArray(value[key])) return value[key] as Record<string, unknown>[];
    }
    return [];
}
function valueObject(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function terminalRun(run: Record<string, unknown>): boolean { return ['succeeded', 'failed', 'cancelled'].includes(String(run.state)); }
function amountMicros(text: string): number {
    if (!/^\d+(?:\.\d{1,6})?$/.test(text)) throw usage('金额需为非负数，最多六位小数');
    const [whole, fraction = ''] = text.split('.');
    const value = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw usage('金额超过安全整数范围');
    return Number(value);
}

export class InteractiveCli {
    private readonly terminal: TerminalSession;
    private readonly renderer: TerminalRenderer;
    private readonly drafts = new Map<string, DraftBuffer>();
    private draft = new DraftBuffer();
    private commandDraft?: DraftBuffer;
    private menu?: Menu;
    private form?: Form;
    private conversation?: Record<string, unknown>;
    private run?: Record<string, unknown>;
    private monitor?: ConversationMonitor;
    private readonly pendingDrafts = new Map<string, PendingDraft>();
    private readonly referencePreparations = new WeakMap<DraftBuffer, { conversationId: string; revision: number; commandId: string }>();
    private viewEpoch = 0;
    private readonly pendingCommands = new Map<string, { commandId: string; conversationId?: string; method?: string }>();
    private logs: string[] = [];
    private details: string[] = [];
    private detailsOffset = 0;
    private detailCache?: { source: string[]; width: number; lines: string[] };
    private state: MascotState = 'idle';
    private stateStartedAt = Date.now();
    private status = '空闲 · 草稿可直接输入';
    private connection = '正在连接Agent Server，输入已可用';
    private observing: boolean;
    private enterBehavior: 'send' | 'newline' = 'send';
    private historyPageSize = 50;
    private motionMode: 'full' | 'reduced' | 'off';
    private readonly startupOptions: ParsedArguments['options'];
    private readonly localPreferences = new Set<string>();
    private preferencesGeneration = 0;
    private preferencesRevision?: number;
    private preferencesLoad?: Promise<void>;
    private busy = false;
    private disposed = false;
    private quitResolve?: (code: number) => void;
    private renderTimer?: NodeJS.Timeout;
    private renderInFlight = false;
    private renderAgain = false;
    private animationTimer?: NodeJS.Timeout;
    private readonly startedAt = Date.now();
    private readonly history: { text: string; conversationId: string }[] = [];
    private historyIndex = -1;
    private interruptCount = 0;
    private lastOutputRun?: string;
    private lastOutputContentId?: string;
    private loadingOutput = false;
    private completionShownForRun?: string;
    private outputText = '';
    private selectedProfile?: string;
    private selectedModel?: string;
    private budget?: Record<string, unknown>;
    private menuPage = 0;
    private lastLinearFrame = '';
    private errorSerial = 0;
    private geometryRevision = 0;
    private graphicsNegotiation?: { timer: NodeJS.Timeout; finish: () => void };
    private editing = false;
    private editorAbort?: AbortController;
    private switching = false;
    private readonly signalHandler = () => { void this.finish(143); };
    private readonly lostControl = (event: { message?: string }) => { this.log(event.message ?? '控制权已失效'); this.status = '控制待申请 · 接管须明确确认'; this.scheduleRender(); };

    constructor(readonly initial: ParsedArguments, readonly client: AgentClient, readonly streams: CliStreams) {
        const options = initial.options;
        this.startupOptions = { ...options };
        const linear = options.plain === true || options.accessible === true || process.env.TERM === 'dumb';
        this.motionMode = linear ? 'off' : options['reduce-motion'] === true ? 'reduced' : 'full';
        this.terminal = new TerminalSession(streams.stdin, streams.stderr, linear);
        const color = options.color !== 'never' && process.env.NO_COLOR === undefined && !linear;
        const graphics = linear || options.graphics === 'none' ? 'none' : 'blocks';
        this.renderer = new TerminalRenderer({ color, graphics, reducedMotion: options['reduce-motion'] === true || linear, fullRedraw: options.renderer === 'full', cacheEnabled: options['image-cache'] !== 'off' });
        this.observing = options.observe === true;
        this.selectedProfile = typeof options.profile === 'string' ? options.profile : undefined;
        this.selectedModel = typeof options.model === 'string' ? options.model : undefined;
        try { this.budget = parseBudget(initial); } catch {}
    }

    async start(): Promise<number> {
        try { await this.terminal.open(); }
        catch (error) { await this.terminal.dispose().catch(() => {}); throw error; }
        this.terminal.on('key', key => { void this.handleKey(key).catch(error => this.showError(clientFailure(error))); });
        this.terminal.on('inputError', message => { this.log(message); this.scheduleRender(); });
        this.terminal.on('resize', () => { void this.resizeTerminal().catch(error => this.showError(clientFailure(error))); });
        this.client.on('controlLost', this.lostControl);
        process.once('SIGTERM', this.signalHandler);
        this.showStartup();
        if (this.renderer.assets.reason) this.log(this.renderer.assets.reason);
        this.scheduleRender(true);
        void this.client.connect().then(async () => {
            if (this.disposed) return;
            this.connection = 'Agent Server已连接';
            void this.loadSavedPreferences();
            await this.negotiateGraphics();
            const conversationId = this.initial.options.conversation ?? this.initial.options['conversation-id'];
            if (typeof conversationId === 'string') await this.openConversation(conversationId);
            else if (this.initial.options.mode) {
                if (!['archive', 'temporary', 'ttl'].includes(String(this.initial.options.mode))) throw usage('--mode可选archive|temporary|ttl');
                await this.newConversation(String(this.initial.options.mode));
            }
            else if (this.menu?.startup) this.showStartup();
            this.scheduleRender();
        }).catch(error => { this.connection = this.client.connected ? 'Agent Server已连接' : '连接失败'; this.showError(clientFailure(error)); });
        this.animate();
        return new Promise<number>(resolveQuit => { this.quitResolve = resolveQuit; });
    }

    private loadSavedPreferences(): Promise<void> {
        const generation = ++this.preferencesGeneration;
        const loading = (async () => {
            try {
                const preferences = await readConfigurationCliPreferences(this.client, this.startupOptions);
                if (this.disposed || generation !== this.preferencesGeneration) return;
                if (!this.localPreferences.has('terminal.enterBehavior')) this.enterBehavior = preferences.enterBehavior;
                this.historyPageSize = preferences.historyPageSize;
                if (!this.localPreferences.has('terminal.width')) this.renderer.options.ambiguousWidth = preferences.ambiguousWidth;
                if (!this.localPreferences.has('terminal.motion')) {
                    const requested = this.startupOptions['reduce-motion'] === undefined ? preferences.motion
                        : preferences.options['reduce-motion'] === true ? 'reduced' : 'full';
                    this.setMotionMode(requested);
                }
                if (!this.localPreferences.has('terminal.graphics')) this.initial.options.graphics = preferences.options.graphics;
                this.renderer.options.color = preferences.options.color !== 'never' && process.env.NO_COLOR === undefined && !this.terminal.linear;
                this.preferencesRevision = preferences.revision;
                this.detailCache = undefined;
                this.renderer.reset();
                if (!this.terminal.linear) await this.terminal.write('\x1b[0m\x1b[2J\x1b[H');
                if (this.disposed || generation !== this.preferencesGeneration) return;
                await this.negotiateGraphics();
                this.scheduleRender(true);
            } catch (error) {
                if (this.disposed || generation !== this.preferencesGeneration) return;
                const failure = clientFailure(error);
                this.log(`全局偏好读取失败：${failure.error?.code ?? 'UNKNOWN'} ${failure.error?.message ?? ''}，继续使用本前台设置`);
                this.scheduleRender();
            }
        })();
        this.preferencesLoad = loading;
        return loading;
    }

    private setMotionMode(mode: 'full' | 'reduced' | 'off'): void {
        const effective = this.terminal.linear ? 'off' : mode;
        if (effective === this.motionMode && this.renderer.options.reducedMotion === (effective !== 'full')) return;
        this.motionMode = effective;
        this.renderer.options.reducedMotion = effective !== 'full';
        this.stateStartedAt = Date.now();
        if (this.animationTimer) clearTimeout(this.animationTimer);
        this.animationTimer = undefined;
        this.animate();
    }

    private async handleKey(key: TerminalKey): Promise<void> {
        if (this.disposed || this.editing) return;
        if (key.name === 'eof') { await this.quit(valueObject(this.conversation?.retention).mode !== 'temporary'); return; }
        if (key.name === 'interrupt') {
            if (this.run && !terminalRun(this.run)) {
                this.interruptCount += 1;
                if (this.interruptCount === 1) void this.cancelRun();
                else if (this.interruptCount === 2) this.log('取消仍在收尾，再按一次Ctrl+C只退出前台，后台状态继续可查');
                else await this.finish(7);
            } else this.showQuit();
            this.scheduleRender(); return;
        }
        if (key.name === 'escape') {
            if (this.form) { this.form = undefined; this.log('表单已关闭，原草稿仍保留'); }
            else { this.menu = undefined; this.commandDraft = undefined; }
            this.scheduleRender(); return;
        }
        if (key.paste) {
            const target = this.form?.draft ?? this.commandDraft ?? this.draft;
            target.insert(key.text ?? '');
            if (!this.form) this.menu = undefined;
            this.scheduleRender(); return;
        }
        if (this.form && key.name === 'backtab') {
            const form = this.form;
            form.values[form.fields[form.index].key] = form.draft.text;
            form.index = Math.max(0, form.index - 1);
            form.draft.replace(form.values[form.fields[form.index].key] ?? form.fields[form.index].defaultValue ?? '');
            this.scheduleRender(); return;
        }
        if (this.menu) {
            if (key.name === 'up' || key.name === 'down') {
                const offset = key.name === 'up' ? -1 : 1;
                this.menu.index = (this.menu.index + offset + this.menu.items.length) % Math.max(1, this.menu.items.length);
            } else if (key.name === 'enter') {
                const item = this.menu.items[this.menu.index];
                if (item?.disabled) this.log(item.disabled);
                else if (item) { this.menu = undefined; await item.action(); }
            } else if (key.name === 'text') {
                if (this.menu.startup) {
                    this.menu = undefined;
                    if (key.text === '/') this.showCommands();
                    else if (key.text?.startsWith('/') && !key.text.startsWith('//')) { this.commandDraft = new DraftBuffer(); this.commandDraft.insert(key.text); }
                    else this.draft.insert(key.text ?? '');
                }
                else {
                    const query = (this.menu.query ?? '') + (key.text ?? '');
                    if (!this.menu.commandMenu) { this.filterMenu(query); this.scheduleRender(); return; }
                    const names = COMMAND_SPECS.flatMap(spec => [spec.name, ...spec.aliases]);
                    if (query.startsWith('/')) {
                        this.menu = undefined; this.commandDraft = undefined; this.draft.insert('/' + query);
                    } else if (names.some(name => query.startsWith(name + ' ')) && !names.some(name => name.startsWith(query))) {
                        this.menu = undefined;
                        this.commandDraft = new DraftBuffer(); this.commandDraft.replace('/' + query);
                    } else this.showCommands(query);
                }
            } else if (key.name === 'backspace' && this.menu.query) {
                if (this.menu.commandMenu) this.showCommands(this.menu.query.slice(0, -1));
                else this.filterMenu(this.menu.query.slice(0, -1));
            }
            this.scheduleRender(); return;
        }
        const target = this.form?.draft ?? this.commandDraft ?? this.draft;
        if (key.name === 'text') {
            if (!this.form && target.text === '' && key.text === '/') this.showCommands();
            else if (!this.form && !this.commandDraft && this.draft.text === '' && key.text?.startsWith('/') && !key.text.startsWith('//')) { this.commandDraft = new DraftBuffer(); this.commandDraft.insert(key.text); }
            else target.insert(key.text ?? '');
        } else if (key.name === 'left') target.move(-1);
        else if (key.name === 'right') target.move(1);
        else if (key.name === 'home') target.home();
        else if (key.name === 'end') target.end();
        else if (key.name === 'backspace') target.erase(true);
        else if (key.name === 'delete') target.erase(false);
        else if (key.name === 'clear-line') target.clearLine();
        else if (key.name === 'undo') target.undo();
        else if (key.name === 'redo') target.redo();
        else if (key.name === 'newline') target.insert('\n');
        else if (key.name === 'menu') this.showCommands();
        else if (key.name === 'pageup' || key.name === 'pagedown') this.detailsOffset = Math.max(0, Math.min(Math.max(0, this.detailLines().length - 1), this.detailsOffset + (key.name === 'pageup' ? -7 : 7)));
        else if (key.name === 'tab') this.completeCommand(target);
        else if (key.name === 'up' || key.name === 'down') {
            if (this.form?.fields[this.form.index].choices) {
                const values = this.form.fields[this.form.index].choices!;
                const index = values.indexOf(target.text);
                target.replace(values[(index + (key.name === 'up' ? -1 : 1) + values.length) % values.length]);
            } else if (!target.text || this.historyIndex >= 0) {
                this.historyIndex = Math.max(-1, Math.min(this.history.length - 1, this.historyIndex + (key.name === 'up' ? 1 : -1)));
                target.replace(this.historyIndex < 0 ? '' : this.history[this.history.length - 1 - this.historyIndex].text);
            }
        } else if (key.name === 'history') this.showInputHistory();
        else if (key.name === 'editor') await this.editDraft();
        else if (key.name === 'alt-enter') await this.sendDraft('steer');
        else if (key.name === 'enter') {
            if (this.form) await this.advanceForm();
            else if (this.commandDraft) await this.executeLine(this.commandDraft.text);
            else if (this.enterBehavior === 'newline') this.draft.insert('\n');
            else await this.sendDraft();
        }
        this.scheduleRender();
    }

    private showStartup(): void {
        if (this.terminal.linear) {
            this.menu = undefined;
            this.details = ['开始工作 · 线性文字模式', '/new --mode archive：新建归档会话', '/sessions：查看已有会话', '/profile list：配置服务商与模型', '/help：查看实际命令', '/terminal set enterBehavior newline：Enter换行，/send发送'];
            return;
        }
        this.menu = { title: '开始工作', index: 0, startup: true, items: [
            { label: '新建归档会话', detail: '保留原文和恢复资料', action: () => this.newConversation('archive') },
            { label: '已有会话', action: () => this.listConversations() },
            { label: '新建临时会话', detail: '关闭即清除内容', action: () => this.newConversation('temporary') },
            { label: '新建限时会话', detail: '显式填写保存时长', action: () => this.newConversation('ttl') },
            { label: '服务商与API', action: () => this.listProfiles() },
            { label: '模型与预算', action: () => this.modelMenu() },
            { label: '命令与帮助', action: () => this.showCommands() },
        ] };
    }

    private showCommands(query = ''): void {
        if (this.terminal.linear) { this.menu = undefined; this.details = renderHelp(query || undefined).split('\n'); this.detailsOffset = 0; return; }
        const rank = (spec: CommandSpec) => [spec.name, ...spec.aliases].some(name => name === query) ? 0 : [spec.name, ...spec.aliases].some(name => name.startsWith(query)) ? 1 : 2;
        const matches = COMMAND_SPECS.filter(spec => `${spec.name} ${spec.aliases.join(' ')} ${spec.summary}`.toLowerCase().includes(query.toLowerCase())).sort((left, right) => rank(left) - rank(right));
        this.menu = { title: `命令与帮助${query ? ' · ' + query : ''}`, index: 0, query, commandMenu: true, items: matches.map(spec => ({
            label: '/' + spec.name, detail: `${spec.mutates ? '修改状态' : '只读/本地'} · ${spec.summary}`, disabled: spec.availability().available ? undefined : spec.availability().reason,
            action: async () => {
                if (['send', 'input current', 'input next'].includes(spec.name)) { await this.sendDraft(spec.name === 'input current' ? 'steer' : 'queue'); return; }
                if (['help', 'model', 'queue', 'artifact list', 'run control', 'quit', 'clear', 'editor', 'reconnect', 'terminal show'].includes(spec.name)) { await this.executeLine('/' + spec.name); return; }
                this.commandForm(spec);
            },
        })) };
        if (!this.menu.items.length) this.menu.items.push({ label: '没有匹配命令', action: () => this.showCommands() });
    }

    private filterMenu(query: string): void {
        if (!this.menu) return;
        this.menu.sourceItems ??= this.menu.items;
        this.menu.query = query;
        this.menu.items = this.menu.sourceItems.filter(item => `${item.label} ${item.detail ?? ''}`.toLowerCase().includes(query.toLowerCase()));
        this.menu.index = 0;
        if (!this.menu.items.length) this.menu.items.push({ label: '当前页没有匹配，Backspace修改筛选或Esc返回', action: () => this.filterMenu('') });
    }

    private commandForm(spec: CommandSpec): void {
        const fields: Field[] = spec.argsSchema.positionals.filter(name => name !== 'conversationId' || !this.conversation)
            .map(name => ({ key: name, label: `必填参数 ${name}`, required: true }));
        const optionNames = Object.keys(spec.argsSchema.options).filter(name => !['params', 'command-id', 'lease-id', 'control-epoch'].includes(name));
        if (optionNames.length) fields.push({ key: 'options', label: '可选参数：' + optionNames.map(name => '--' + name).join(' ') });
        if (!fields.length) fields.push({ key: 'options', label: spec.summary + '（Enter查看等价命令）' });
        this.openForm('/' + spec.name, fields, async values => {
            const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
            const positional = spec.argsSchema.positionals.map(name => name === 'conversationId' && this.conversation ? String(this.conversation.conversationId) : values[name]).filter(value => value !== undefined);
            const line = '/' + spec.name + (positional.length ? ' ' + positional.map(quote).join(' ') : '') + (values.options ? ' ' + values.options : '');
            parseCommand(parseArguments(tokenizeCommand(line)));
            this.commandDraft = new DraftBuffer(); this.commandDraft.replace(line);
            this.log('等价命令：' + line);
            this.menu = { title: '确认等价命令', index: 0, items: [
                { label: '返回编辑命令', detail: line, action: () => {} },
                { label: spec.mutates ? '确认执行修改' : '执行查询/本地操作', detail: line, action: async () => { await this.executeLine(line); } },
            ] };
        });
    }

    private showInputHistory(): void {
        this.menu = { title: '本次人工输入历史', index: 0, items: [...this.history].reverse().map(entry => ({ label: cleanText(entry.text), action: () => { this.draft.replace(entry.text); } })) };
        if (!this.menu.items.length) this.menu.items.push({ label: '本次还没有已确认的人工输入', action: () => { this.menu = undefined; } });
    }

    private completeCommand(draft: DraftBuffer): void {
        const matches = COMMAND_SPECS.filter(spec => ('/' + spec.name).startsWith(draft.text));
        if (matches.length === 1) draft.replace('/' + matches[0].name + ' ');
        else this.showCommands(draft.text.replace(/^\//, ''));
    }

    private openForm(title: string, fields: Field[], complete: Form['complete']): void {
        this.menu = undefined;
        const draft = new DraftBuffer(); draft.replace(fields[0]?.defaultValue ?? '');
        this.form = { title, fields, index: 0, values: {}, draft, complete };
        this.scheduleRender();
    }

    private async advanceForm(): Promise<void> {
        const form = this.form!;
        const field = form.fields[form.index];
        const text = field.preserveWhitespace ? form.draft.text : form.draft.text.trim();
        if (field.required && !text.trim()) { this.log('请填写' + field.label); return; }
        if (field.choices && !field.choices.includes(text)) { this.log('可选：' + field.choices.join(' / ')); return; }
        const problem = field.validate?.(text, { ...form.values, [field.key]: text });
        if (problem) { this.log(problem); this.scheduleRender(); return; }
        form.values[field.key] = text;
        form.index += 1;
        if (form.index < form.fields.length) {
            const next = form.fields[form.index];
            form.draft.replace(form.values[next.key] ?? next.defaultValue ?? '');
            return;
        }
        this.form = undefined;
        const errorSerial = this.errorSerial;
        try { await form.complete(form.values); }
        catch (error) { this.showError(clientFailure(error)); }
        if (this.errorSerial !== errorSerial && !this.form && !this.menu) {
            form.index = form.fields.length - 1;
            form.draft.replace(form.values[form.fields[form.index].key] ?? '');
            this.form = form;
        }
    }

    private async newConversation(mode: string): Promise<void> {
        const configuredRoots = Array.isArray(this.initial.options['write-root']) ? this.initial.options['write-root'] : [];
        const fields: Field[] = [{ key: 'title', label: '会话名称', defaultValue: String(this.initial.options.title ?? '新的会话') }, { key: 'root', label: '可写目录', defaultValue: configuredRoots[0] ?? this.streams.cwd ?? process.cwd(), required: true }];
        if (mode === 'ttl') fields.push({ key: 'ttl', label: '保存时长（例如2h）', defaultValue: typeof this.initial.options.ttl === 'string' ? this.initial.options.ttl : undefined, required: true });
        this.openForm('新建' + ({ archive: '归档', temporary: '临时', ttl: '限时' } as Record<string, string>)[mode] + '会话', fields, async values => {
            const args = ['conversation', 'create', '--mode', mode, '--title', values.title, '--write-root', values.root];
            for (const root of configuredRoots.slice(1)) args.push('--write-root', root);
            if (values.ttl) args.push('--ttl', values.ttl);
            if (this.selectedProfile) args.push('--profile', this.selectedProfile);
            if (this.selectedModel) args.push('--model', this.selectedModel);
            await this.perform(args);
        });
    }

    private async listConversations(cursor?: string): Promise<void> {
        const result = await this.client.request('conversations.list', { limit: 20, ...(cursor ? { cursor } : {}) });
        if (!result.ok) { this.showError(result); return; }
        const page = valueObject(result.data);
        const items: MenuItem[] = rows(page).map(conversation => ({ label: String(valueObject(conversation.options).title ?? conversation.conversationId), detail: `${valueObject(conversation.retention).mode} · ${conversation.state}`, action: () => this.openConversation(String(conversation.conversationId)) }));
        if (page.nextCursor) items.push({ label: '下一页', action: () => this.listConversations(String(page.nextCursor)) });
        items.push({ label: '返回启动菜单', action: () => this.showStartup() });
        this.menu = { title: '已有会话', index: 0, items };
    }

    private async openConversation(conversationId: string, observe = this.initial.options.observe === true, preserveDetails = false): Promise<void> {
        if (this.switching) { this.log('原临时会话正在收尾，完成后再切换'); return; }
        if (!this.observing && this.conversation && this.conversation.conversationId !== conversationId && valueObject(this.conversation.retention).mode === 'temporary') {
            this.menu = { title: '切换前关闭临时会话', index: 0, items: [
                { label: '取消所属执行并清理临时正文，再打开目标', action: () => this.closeTemporaryAndOpen(conversationId, observe) },
                { label: '返回原临时会话', action: () => { this.menu = undefined; } },
            ] }; this.scheduleRender(); return;
        }
        const viewEpoch = ++this.viewEpoch;
        const previousId = this.conversation ? String(this.conversation.conversationId) : undefined;
        if (previousId) this.drafts.set(previousId, this.draft);
        const result = await this.client.request<Record<string, unknown>>('conversations.get', { conversationId });
        if (viewEpoch !== this.viewEpoch || this.disposed) return;
        if (!result.ok || !result.data) { this.showError(result); return; }
        if (previousId && (previousId !== conversationId || observe) && this.client.getControlLease('conversation', previousId)) {
            const released = await this.client.releaseControl('conversation', previousId);
            if (!released.ok && (released.error?.mayHaveStarted || !['CONTROL_REQUIRED', 'CONTROL_CONFLICT', 'NOT_FOUND', 'TEMPORARY_GONE'].includes(released.error?.code ?? ''))) { this.showError(released); this.log('原会话控制释放仍待确认，请查询原控制状态'); return; }
        }
        if (viewEpoch !== this.viewEpoch || this.disposed) return;
        await this.monitor?.stop();
        if (viewEpoch !== this.viewEpoch || this.disposed) return;
        this.observing = observe;
        this.conversation = result.data;
        if (!preserveDetails) {
            this.details = conversationSummary(result.data) ?? [];
            this.detailsOffset = 0; this.detailCache = undefined;
        }
        this.form = undefined; this.commandDraft = undefined;
        this.run = result.data.run ? valueObject(result.data.run) : undefined;
        this.outputText = '';
        this.draft = this.drafts.get(conversationId) ?? new DraftBuffer();
        this.menu = undefined;
        if (!this.observing) {
            const claim = await this.client.claimControl('conversation', conversationId);
            if (viewEpoch !== this.viewEpoch || this.disposed) {
                if (this.conversation?.conversationId !== conversationId && this.client.getControlLease('conversation', conversationId)) await this.client.releaseControl('conversation', conversationId);
                return;
            }
            if (!claim.ok) { this.observing = true; this.showError(claim); this.log('已改为只读观察，可用/run control明确申请或接管'); }
            else if (this.conversation.state === 'closed') {
                const reopened = await this.client.request('conversations.reopen', { conversationId });
                if (!reopened.ok) this.showError(reopened);
            }
        }
        const monitor = new ConversationMonitor(this.client, conversationId, {
            snapshot: async snapshot => {
                if (viewEpoch !== this.viewEpoch || this.disposed) return;
                this.conversation = snapshot;
                if (snapshot.run) this.run = valueObject(snapshot.run);
                else if (this.run && !terminalRun(this.run)) {
                    const final = await this.client.request<Record<string, unknown>>('runs.get', { conversationId, runId: this.run.runId });
                    if (final.ok && final.data && viewEpoch === this.viewEpoch) this.run = final.data;
                }
                if (viewEpoch !== this.viewEpoch || this.disposed) return;
                this.updateState();
                await this.loadRunOutput();
            },
            event: event => viewEpoch === this.viewEpoch ? this.onEvent(event) : undefined,
            error: error => { if (viewEpoch === this.viewEpoch && !this.disposed) this.showError(error, false); },
        });
        this.monitor = monitor;
        await monitor.start();
        if (viewEpoch !== this.viewEpoch || this.disposed) { await monitor.stop(); return; }
        this.log('已打开会话 ' + conversationId + '，执行恢复需要明确选择');
        this.updateState();
    }

    private async listProfiles(cursor?: string): Promise<void> {
        if (!METHOD_SPECS['profiles.list']) { this.showError({ ok: false, error: { code: 'METHOD_NOT_AVAILABLE', message: '服务商配置能力尚未安装', retryable: false, mayHaveStarted: false } }); return; }
        const result = await this.client.request('profiles.list', { limit: 20, ...(cursor ? { cursor } : {}) });
        if (!result.ok) { this.showError(result); return; }
        const items: MenuItem[] = rows(result.data).map(profile => ({ label: String(profile.label ?? profile.profileId), detail: `${profile.protocol} · ${profile.credentialRef ? '凭据已配置' : '尚未配置Key'}`, action: () => this.profileMenu(valueObject(profile.profile ?? profile)) }));
        items.unshift({ label: '添加服务商/API', action: () => this.addProfile() });
        const page = valueObject(result.data);
        if (page.nextCursor) items.push({ label: '下一页服务商', action: () => this.listProfiles(String(page.nextCursor)) });
        this.menu = { title: '服务商与API', index: 0, items };
    }

    private addProfile(): void {
        this.openForm('添加服务商/API（保存不发送模型请求）', [
            { key: 'label', label: '配置名称', required: true },
            { key: 'protocol', label: '协议', choices: ['compatible_chat', 'openai_responses', 'anthropic', 'gemini', 'progrok'], defaultValue: 'compatible_chat', required: true },
            { key: 'url', label: 'API base URL', required: true }, { key: 'model', label: '默认模型ID（可留空）' },
        ], async values => {
            const args = ['profile', 'add', '--label', values.label, '--protocol', values.protocol, '--base-url', values.url];
            if (values.model) args.push('--model', values.model);
            const execution = await this.perform(args);
            if (execution?.result.ok) {
                const profile = valueObject(valueObject(execution.result.data).profile ?? execution.result.data);
                this.profileMenu(profile);
            }
        });
    }

    private profileMenu(profile: Record<string, unknown>): void {
        const profileId = String(profile.profileId);
        if (this.selectedProfile !== profileId) this.selectedModel = typeof profile.defaultModel === 'string' ? profile.defaultModel : undefined;
        this.selectedProfile = profileId;
        this.menu = { title: String(profile.label ?? profileId), index: 0, items: [
            { label: '选择模型', action: () => this.listModels(profileId) },
            { label: '从私有文件导入API Key（仅服务端读取）', disabled: supportsServerSecretImport() ? undefined : '服务端文件导入隐藏通道尚未安装', action: () => {
                this.openForm('服务端隐藏Key导入', [
                    { key: 'format', label: '文件格式', choices: ['plain', 'env', 'json'], defaultValue: 'plain', required: true },
                    { key: 'field', label: 'env变量名或JSON字段（plain可留空）' },
                    { key: 'path', label: '私有Key文件路径（输入隐藏）', hidden: true, required: true },
                ], async values => {
                    const args = ['key', 'set', profileId, '--secret-file', values.path, '--secret-format', values.format, '--revision', String(profile.revision ?? 0)];
                    if (values.field) args.push('--secret-field', values.field);
                    await this.perform(args);
                    await this.listProfiles();
                });
            } },
            { label: '校验配置（无模型请求）', action: async () => { await this.perform(['profile', 'validate', profileId]); } },
            { label: '配置供应商总限额并关联此Profile', detail: String(profile.quotaLimitId ?? '尚未关联总限额'), action: () => this.quotaLimitForm(profile) },
            { label: '刷新模型目录（明确联网）', action: async () => { await this.perform(['model', 'refresh', '--profile', profileId]); await this.listModels(profileId); } },
            { label: '返回服务商列表', action: () => this.listProfiles() },
        ] };
    }

    private async listModels(profileId = this.selectedProfile, cursor?: string): Promise<void> {
        if (!profileId) { await this.listProfiles(); return; }
        const result = await this.client.request('models.list', { profileId, limit: 20, ...(cursor ? { cursor } : {}) });
        if (!result.ok) { this.showError(result); return; }
        const page = valueObject(result.data);
        const items: MenuItem[] = rows(page).map(model => ({ label: String(model.displayName ?? model.modelId), detail: String(model.modelId), action: async () => {
            await this.selectModel(profileId, String(model.modelId));
        } }));
        if (page.nextCursor) items.push({ label: '下一页模型', action: () => this.listModels(profileId, String(page.nextCursor)) });
        items.push({ label: '手工输入精确模型ID', action: () => this.openForm('选择模型', [{ key: 'model', label: '精确模型ID', required: true }], async values => {
            await this.selectModel(profileId, values.model);
        }) });
        this.menu = { title: '选择模型 · ' + profileId, index: 0, items };
    }

    private async selectModel(profileId: string, modelId: string): Promise<void> {
        if (this.conversation) {
            const applied = await this.perform(['model', 'set', '--profile', profileId, '--model', modelId, '--revision', String(this.conversation.revision)]);
            if (!applied?.result.ok) return;
        }
        this.selectedProfile = profileId; this.selectedModel = modelId;
        this.log('已选择模型 ' + modelId); this.menu = undefined;
    }

    private modelMenu(): void {
        this.menu = { title: '模型与本次预算', index: 0, items: [
            { label: '选择服务商与模型', action: () => this.listProfiles() },
            { label: '设置本次根任务预算', detail: this.budget ? JSON.stringify(this.budget) : '尚未授权模型预算', action: () => this.budgetForm() },
            { label: '配置供应商跨任务总限额', action: () => this.quotaLimitForm() },
            { label: '返回启动菜单', action: () => this.showStartup() },
        ] };
    }

    private budgetForm(after?: () => Promise<void>): void {
        const positiveInteger = (text: string): string | undefined =>
            /^\d+$/.test(text) && Number.isSafeInteger(Number(text)) && Number(text) > 0 ? undefined : '请输入有限正整数';
        this.openForm('本次根任务预算', [
            { key: 'mode', label: '金额约束模式', choices: ['hard', 'estimated'], defaultValue: 'hard', required: true },
            { key: 'wall', label: '最长运行毫秒', defaultValue: '3600000', required: true, validate: positiveInteger },
            { key: 'calls', label: '最多模型请求次数', defaultValue: '128', required: true, validate: positiveInteger },
            { key: 'cost', label: '本根任务金额上限（币种单位，hard必填）', validate: (text, values) => {
                if (!text) return values.mode === 'hard' ? 'hard模式需填写金额上限；Shift+Tab可返回选择estimated模式' : undefined;
                try { amountMicros(text); return undefined; }
                catch (error) { return error instanceof Error ? error.message : '金额格式有误'; }
            } },
            { key: 'currency', label: '三字母币种（如USD或CNY）', defaultValue: 'USD', required: true,
                validate: text => /^[A-Za-z]{3}$/.test(text) ? undefined : '币种请填写USD、CNY这类三字母代码' },
            { key: 'output', label: '最大输出tokens', defaultValue: '4096', required: true, validate: positiveInteger },
        ], async values => {
            const candidate = { costMode: values.mode, wallMs: Number(values.wall), maxModelCalls: Number(values.calls), maxOutputTokens: Number(values.output),
                ...(values.cost ? { maxCostMicros: amountMicros(values.cost) } : {}), ...(values.currency ? { currency: values.currency.toUpperCase() } : {}) };
            this.budget = parseBudget({ words: [], options: { budget: JSON.stringify(candidate) } });
            this.log('预算已选择，发送时由核心核验并冻结');
            if (after) await after();
        });
    }

    private quotaLimitForm(profile?: Record<string, unknown>): void {
        if (!METHOD_SPECS['budgets.configureLimit']) { this.log('供应商总限额能力尚未安装'); return; }
        const quotaLimitId = String(profile?.quotaLimitId ?? 'limit-' + randomUUID());
        this.openForm('供应商总限额（所有关联根任务共同使用）', [
            { key: 'amountMode', label: '金额约束（estimated允许单次实际费超估算）', choices: ['hard', 'estimated'], defaultValue: 'hard', required: true },
            { key: 'id', label: '总限额ID', defaultValue: quotaLimitId, required: true },
            { key: 'currency', label: '三字母币种', defaultValue: 'USD', required: true },
            { key: 'amount', label: '总金额上限（币种单位）', required: true },
            { key: 'scopes', label: '账户额度组ID数组（JSON）', defaultValue: JSON.stringify(profile?.quotaScopeId ? [profile.quotaScopeId] : []), required: true },
            { key: 'source', label: '本次额度授权来源', defaultValue: 'manual-cli-confirmation', required: true },
        ], async values => {
            let quotaScopeIds: unknown;
            try { quotaScopeIds = JSON.parse(values.scopes); } catch { throw usage('账户额度组须为JSON数组'); }
            const definition = { quotaLimitId: values.id, currency: values.currency.toUpperCase(), maxCostMicros: amountMicros(values.amount), quotaScopeIds, sourceRef: values.source };
            const configured = await this.client.request('budgets.configureLimit', { definition: { ...definition,
                ...(values.amountMode === 'estimated' ? { amountMode: 'estimated' } : {}) } });
            this.showResult({ result: configured });
            if (!configured.ok || !profile) return;
            const current = await this.client.request('profiles.get', { profileId: profile.profileId });
            if (!current.ok) { this.showError(current); this.log('总限额已配置，Profile引用仍待更新'); return; }
            const previous = valueObject(valueObject(current.data).profile ?? current.data);
            const updated = await this.client.request('profiles.put', { profile: { ...previous, quotaLimitId: values.id }, expectedRevision: previous.revision });
            this.showResult({ result: updated });
            this.log(updated.ok ? '供应商总限额与Profile引用已提交' : '总限额已配置，Profile引用更新失败，请保留原限额ID继续处理');
        });
    }

    private async sendDraft(mode: 'queue' | 'steer' = 'queue'): Promise<void> {
        if (this.busy) { this.log('命令回执仍在等待，草稿可继续编辑'); return; }
        const pending = this.pendingDraft;
        if (pending) {
            this.busy = true;
            try {
                const receipt = await this.client.getReceipt(pending.commandId, pending.conversationId);
                if (this.pendingDrafts.get(pending.conversationId)?.commandId !== pending.commandId) return;
                const original = valueObject(receipt.data).result;
                if (original && typeof original === 'object' && typeof (original as RpcResult).ok === 'boolean') {
                    if ((original as RpcResult).ok) {
                        pending.draft.clearIfAcknowledged(pending.revision);
                        if (pending.text !== undefined) { this.history.push({ text: pending.text, conversationId: pending.conversationId }); if (this.history.length > 100) this.history.shift(); }
                    }
                    this.pendingDrafts.delete(pending.conversationId);
                    this.referencePreparations.delete(pending.draft);
                    if (this.conversation?.conversationId === pending.conversationId) this.showResult({ result: original as RpcResult });
                } else this.log('原命令状态仍待确认，本次只查回执，草稿保留');
            } finally { this.busy = false; }
            return;
        }
        if (this.observing) { this.log('当前为只读观察，先用/run control申请控制'); return; }
        if (!this.draft.text.trim()) return;
        if (!this.conversation) { this.log('请先新建或打开会话，草稿仍保留'); this.showStartup(); return; }
        if (this.run?.kind === 'maintenance' && !terminalRun(this.run)) { this.log('维护中，草稿已保留，维护结束后再次发送'); return; }
        if (this.run?.state === 'outcome_unknown') { this.log('原执行结果仍待核实，草稿已保留，请先查询原动作'); return; }
        const current = this.run && !terminalRun(this.run);
        if (!current && !this.budget) { this.budgetForm(() => this.sendDraft(mode)); return; }
        const draft = this.draft;
        const revision = draft.revision;
        const conversationId = String(this.conversation.conversationId);
        const previousPreparation = this.referencePreparations.get(draft);
        const commandId = previousPreparation?.conversationId === conversationId && previousPreparation.revision === revision
            ? previousPreparation.commandId : randomUUID();
        this.referencePreparations.set(draft, { conversationId, revision, commandId });
        const params: Record<string, unknown> = current ? { conversationId, runId: this.run!.runId, expectedRunEpoch: this.run!.runEpoch,
            expectedHistoryEpoch: this.conversation.historyEpoch, mode, draftId: draft.draftId, draftRevision: revision,
            ...(mode === 'steer' ? { targetRoundId: this.run!.activeRoundId } : {}) }
            : { conversationId, budget: structuredClone(this.budget), options: this.selectedModel || this.selectedProfile
                ? { profileId: this.selectedProfile, modelId: this.selectedModel, modelSelection: { profileId: this.selectedProfile, modelId: this.selectedModel } } : {} };
        this.busy = true;
        try {
            const prepared = await prepareCliInputReferences(this.client, { conversationId, text: draft.text, existing: draft.references,
                cwd: process.cwd(), commandId });
            const content = { ...prepared, text: prepared.text.startsWith('//') || prepared.text.startsWith('@@') ? prepared.text.slice(1) : prepared.text };
            params[current ? 'content' : 'input'] = content;
            this.pendingDrafts.set(conversationId, { commandId, conversationId, revision, draft, text: content.text });
            const result = await this.client.request(current ? 'inputs.submit' : 'runs.start', params, { clientCommandId: commandId });
            if (this.pendingDrafts.get(conversationId)?.commandId !== commandId) return;
            if (result.ok && result.receiptId) {
                this.history.push({ text: content.text, conversationId }); if (this.history.length > 100) this.history.shift();
                draft.clearIfAcknowledged(revision); this.pendingDrafts.delete(conversationId);
                this.referencePreparations.delete(draft);
                if (!current && this.conversation?.conversationId === conversationId) { this.run = valueObject(result.data); this.outputText = ''; this.lastOutputRun = undefined; }
                this.log('输入已取得回执 ' + result.receiptId);
            } else {
                if (!result.error?.mayHaveStarted) { this.pendingDrafts.delete(conversationId); this.referencePreparations.delete(draft); }
                if (this.conversation?.conversationId === conversationId) this.showError(result);
                else this.log('原会话输入回执待核对：' + conversationId);
            }
            this.updateState();
        } finally { this.busy = false; }
    }

    private async executeLine(line: string): Promise<void> {
        const parsed = parseArguments(tokenizeCommand(line));
        parseCommand(parsed);
        const words = parsed.words.map((word, index) => index === 0 ? word.replace(/^\//, '') : word);
        const name = words.join(' ');
        const hasOptions = Object.keys(parsed.options).length > 0;
        if (words[0] === 'help' || words[0] === 'h') {
            this.details = renderHelp(words.slice(1).join(' ') || undefined, parsed.options.diagnostics === true).split('\n'); this.detailsOffset = 0; this.menu = undefined; this.commandDraft = undefined; return;
        }
        if (words[0] === 'quit' || words[0] === 'q' || words[0] === 'exit') {
            if (parsed.options.detach === true && parsed.options.cancel === true) throw usage('/quit只能选择--cancel或--detach');
            this.commandDraft = undefined;
            if (parsed.options.detach === true) await this.quit(true);
            else if (parsed.options.cancel === true) await this.quit(false);
            else this.showQuit();
            return;
        }
        if (name === 'send' || name === 'input current' || name === 'input next') { this.commandDraft = undefined; await this.sendDraft(name === 'input current' ? 'steer' : 'queue'); return; }
        if (name === 'input interrupt') { this.commandDraft = undefined; await this.cancelRun(true); return; }
        if (name === 'cancel' || name === 'stop') { this.commandDraft = undefined; await this.cancelRun(); return; }
        if ((name === 'session list' || name === 'sessions') && !hasOptions) { this.commandDraft = undefined; await this.listConversations(); return; }
        if ((name === 'profile list' || name === 'profile') && !hasOptions) { this.commandDraft = undefined; await this.listProfiles(); return; }
        if (name === 'profile add' && !hasOptions) { this.commandDraft = undefined; this.addProfile(); return; }
        if (name === 'model') { this.commandDraft = undefined; this.modelMenu(); return; }
        if (name === 'model list' && !hasOptions) { this.commandDraft = undefined; await this.listModels(); return; }
        if (name === 'run control') { this.commandDraft = undefined; this.controlMenu(); return; }
        if (name === 'run detach') { this.commandDraft = undefined; await this.quit(true); return; }
        if (name === 'queue') { this.commandDraft = undefined; await this.queueMenu(); return; }
        if (name === 'approvals' && !hasOptions) { this.commandDraft = undefined; await this.approvalsMenu(); return; }
        if (name === 'artifact list' && !hasOptions) { this.commandDraft = undefined; await this.artifactsMenu(); return; }
        if (name === 'status') { this.commandDraft = undefined; if (this.run) await this.perform(['runs', 'get', String(this.run.runId)]); else this.log('当前没有已选执行，可用/run list查看记录'); return; }
        if (name === 'clear') { this.commandDraft = undefined; this.logs = []; this.details = []; this.renderer.reset(); return; }
        if (name === 'editor') { this.commandDraft = undefined; await this.editDraft(); return; }
        if (name === 'reconnect') {
            this.commandDraft = undefined; this.connection = '正在恢复原连接与游标'; this.scheduleRender(true);
            await this.monitor?.stop(); await this.client.reconnect();
            this.connection = 'Agent Server已重新连接，原写命令只查回执';
            void this.loadSavedPreferences();
            if (this.conversation) await this.openConversation(String(this.conversation.conversationId), this.observing);
            return;
        }
        if (words[0] === 'terminal') { this.commandDraft = undefined; await this.terminalCommand(words.slice(1)); return; }
        if (this.observing) parsed.options.observe = true;
        const execution = await this.performParsed(parsed);
        if (execution?.result.ok) this.commandDraft = undefined;
    }

    private async perform(args: string[]): Promise<CommandExecution | undefined> { return this.performParsed(parseArguments(args)); }
    private async performParsed(parsed: ParsedArguments): Promise<CommandExecution | undefined> {
        if (this.busy) { this.log('正在等待命令回执，请稍后明确提交'); return; }
        this.busy = true;
        try {
            const command = parseCommand(parsed);
            if (['conversations.readHistory', 'conversations.search'].includes(command.spec.method ?? '') && parsed.options.limit === undefined) {
                const params = typeof parsed.options.params === 'string' ? parseJsonObject(parsed.options.params, '--params') : {};
                if (params.limit === undefined) parsed.options.limit = this.historyPageSize;
            }
            if (this.observing) parsed.options.observe = true;
            const snapshot = this.conversation;
            const viewEpoch = this.viewEpoch;
            const intentOptions: Record<string, unknown> = { ...parsed.options };
            for (const option of ['json', 'plain', 'diagnostics', 'color', 'graphics', 'reduce-motion', 'accessible', 'cell-size', 'renderer', 'image-cache', 'observe', 'lease-id', 'control-epoch', 'timeout-ms', 'startup-timeout-ms', 'deadline-at', 'data-dir', 'client-id', 'server-entry']) delete intentOptions[option];
            if (typeof intentOptions.params === 'string') {
                const params = parseJsonObject(intentOptions.params, '--params'); delete params.controlLeaseId; delete params.controlEpoch; intentOptions.params = params;
            }
            const scope = command.spec.method ? METHOD_SPECS[command.spec.method]?.scope : undefined;
            const key = createHash('sha256').update(canonicalJson({ command: command.spec.name, positionals: command.positionals, options: intentOptions,
                ...(scope === 'conversation' ? { conversationId: parsed.options.conversation ?? parsed.options['conversation-id'] ?? snapshot?.conversationId } : {}) })).digest('hex');
            const pending = this.pendingCommands.get(key);
            let execution: CommandExecution;
            if (pending) {
                const receipt = await this.client.getReceipt(pending.commandId, pending.conversationId);
                const original = valueObject(receipt.data).result;
                if (!original || typeof original !== 'object' || typeof (original as RpcResult).ok !== 'boolean') {
                    this.log('原命令仍待确认，本次仅查回执：' + pending.commandId);
                    return { result: { ok: false, error: { code: 'RECEIPT_UNKNOWN', message: '原命令回执仍待确认，未重新提交', retryable: true, mayHaveStarted: true, details: pending } } };
                }
                execution = { method: pending.method, clientCommandId: pending.commandId, result: original as RpcResult };
                this.pendingCommands.delete(key);
            } else {
                if (snapshot && ['conversation update', 'model set'].includes(command.spec.name) && parsed.options.revision === undefined) parsed.options.revision = Number(snapshot.revision);
                execution = await executeCommand(command, { client: this.client, cwd: this.streams.cwd ?? process.cwd(), conversationId: snapshot ? String(snapshot.conversationId) : undefined,
                    readInput: () => { if (parsed.options.stdin) throw usage('交互前台使用草稿或输入文件'); return readCommandInput(parsed, this.streams.stdin); } });
            }
            if (execution.result.error?.mayHaveStarted && execution.clientCommandId) this.pendingCommands.set(key, {
                commandId: execution.clientCommandId, method: execution.method,
                ...(execution.method && METHOD_SPECS[execution.method]?.scope === 'conversation' && snapshot ? { conversationId: String(snapshot.conversationId) } : {}),
            });
            if (viewEpoch !== this.viewEpoch) { this.log('原视图操作已返回：' + (execution.method ?? command.spec.name)); return execution; }
            const rawDetails = parsed.options.json === true || parsed.options.diagnostics === true || command.spec.name === 'rpc';
            this.showResult(execution, { raw: rawDetails, titleHint: typeof parsed.options.title === 'string' ? parsed.options.title : undefined });
            if (execution.result.ok && execution.method === 'server.settings.put') void this.loadSavedPreferences();
            const data = valueObject(execution.result.data);
            if (execution.result.ok && command.spec.name === 'attach') await this.openConversation(String(command.positionals[0] ?? parsed.options.conversation), parsed.options.observe === true, rawDetails);
            else if (execution.result.ok && command.spec.name === 'conversation create' && typeof data.conversationId === 'string') await this.openConversation(data.conversationId, this.initial.options.observe === true, rawDetails);
            else if (execution.result.ok && command.spec.name === 'runs start') { this.run = data; this.outputText = ''; this.updateState(); }
            return execution;
        } catch (error) { this.showError(clientFailure(error)); }
        finally { this.busy = false; this.scheduleRender(); }
    }

    private async onEvent(event: AgentEvent): Promise<void> {
        if (event.conversationId !== this.conversation?.conversationId) return;
        const viewEpoch = this.viewEpoch;
        if (this.run && event.runId && (event.runId !== this.run.runId || typeof event.runEpoch === 'number' && event.runEpoch < Number(this.run.runEpoch))) return;
        const text = eventText(event);
        if (text) { this.outputText = (this.outputText + text).slice(-1024 * 1024); this.log(cleanText(text)); }
        if (event.type === 'run.progress') {
            if (this.run && event.runId === this.run.runId) this.run = { ...this.run, phase: event.payload.phase, ...event.payload };
        }
        if (event.runId && /^(?:run\.(?:succeeded|failed|cancelled|paused|outcome_unknown|stopping|cleanup)|round.completed)$/.test(event.type)) {
            const result = await this.client.request<Record<string, unknown>>('runs.get', { conversationId: event.conversationId, runId: event.runId });
            if (result.ok && result.data && viewEpoch === this.viewEpoch) this.run = result.data;
        }
        if (viewEpoch !== this.viewEpoch || this.disposed) return;
        if (/interaction|approval/.test(event.type)) this.log('有新的待批或提问，使用/approvals查看对象与范围');
        this.updateState();
        await this.loadRunOutput();
        this.scheduleRender();
    }

    private async loadRunOutput(): Promise<void> {
        if (!this.run || !this.conversation || this.loadingOutput || this.editing) return;
        const run = this.run;
        const conversationId = String(this.conversation.conversationId);
        const viewEpoch = this.viewEpoch;
        const contentId = typeof run.resultContentId === 'string' ? run.resultContentId : undefined;
        if (!contentId || contentId === this.lastOutputContentId || !METHOD_SPECS['conversations.readArtifact']) return;
        this.loadingOutput = true;
        try {
            const result = await resolveRunResult(this.client, conversationId, { ok: true, data: run });
            if (viewEpoch !== this.viewEpoch || this.disposed) return;
            if (!result.ok || !result.data) { this.showError(result, false); return; }
            this.lastOutputContentId = contentId;
            const text = formatExecutionText(result.data.result, conversationId, this.client.dataDir) ?? humanJson(result.data.result);
            if (text) await this.printTranscript(text);
            if (terminalRun(run) && ['released', 'not_needed'].includes(String(run.cleanupState))) {
                this.lastOutputRun = String(run.runId);
                this.log(`执行${run.state} · 清理${run.cleanupState}`);
            }
        } finally { this.loadingOutput = false; }
    }

    private updateState(): void {
        const run = this.run;
        let state: MascotState = 'idle';
        if (run && !terminalRun(run)) {
            state = run.kind === 'maintenance' ? 'compact' : ['waiting', 'stopping', 'paused', 'outcome_unknown'].includes(String(run.state)) ? 'approval' : 'thinking';
            if (run.phase === 'executing_tools') state = run.effectKind === 'write' ? 'typing' : run.effectKind === 'read' ? 'searching' : 'thinking';
        } else if (run?.state === 'succeeded' && ['released', 'not_needed'].includes(String(run.cleanupState)) && this.completionShownForRun !== run.runId) {
            state = 'complete'; this.completionShownForRun = String(run.runId);
        }
        if (this.state === 'complete' && Date.now() - this.stateStartedAt < 750 && state === 'idle') state = 'complete';
        if (state !== this.state) {
            this.state = state;
            this.stateStartedAt = Date.now();
            this.animate();
        }
        this.status = this.run ? `${this.run.state} · ${this.run.phase ?? '无活动步骤'} · 清理 ${this.run.cleanupState ?? '未知'}${this.observing ? ' · 只读观察' : ''}` : '空闲 · ' + (this.observing ? '只读观察' : '输入已可用');
        this.scheduleRender();
    }

    private async cancelRun(interrupt = false): Promise<void> {
        if (!this.run || !this.conversation || terminalRun(this.run)) { this.log('当前没有活动执行'); return; }
        const conversationId = String(this.conversation.conversationId);
        const runId = String(this.run.runId);
        const viewEpoch = this.viewEpoch;
        const fresh = await this.client.request<Record<string, unknown>>('runs.get', { conversationId, runId });
        if (!fresh.ok || !fresh.data) { this.showError(fresh); return; }
        if (interrupt && fresh.data.phase === 'executing_tools') { this.log('E_TOOL_ACTIVE：工具仍在执行，请使用/cancel取消整次执行'); return; }
        const result = await this.client.request(interrupt ? 'runs.interrupt' : 'runs.cancel', { conversationId, runId: fresh.data.runId, expectedRunEpoch: fresh.data.runEpoch, reason: '人工前台请求' });
        if (viewEpoch !== this.viewEpoch) {
            this.log(`原会话${conversationId}取消回执：${result.ok ? '已确认' : result.error?.code}`);
            if (this.client.getControlLease('conversation', conversationId)) await this.client.releaseControl('conversation', conversationId);
            return;
        }
        if (result.ok) { this.run = valueObject(result.data); this.log('取消/中断回执已确认，正在核对资源收尾'); }
        else this.showError(result);
        this.updateState();
    }

    private controlMenu(): void {
        if (!this.conversation) { this.log('先打开一个会话'); return; }
        this.menu = { title: '会话控制', index: 0, items: [
            { label: '正常申请控制', action: async () => { const result = await this.client.claimControl('conversation', String(this.conversation!.conversationId)); if (result.ok) this.observing = false; this.showResult({ result }); } },
            { label: '明确接管（旧控制代次将失效）', action: async () => { const result = await this.client.claimControl('conversation', String(this.conversation!.conversationId), true); if (result.ok) this.observing = false; this.showResult({ result }); } },
        ] };
    }

    private async approvalsMenu(): Promise<void> {
        if (!this.conversation) { this.log('先打开会话'); return; }
        const result = await this.client.request('interactions.list', { conversationId: this.conversation.conversationId, limit: 50 });
        if (!result.ok) { this.showError(result); return; }
        this.menu = { title: '真实待批与提问', index: 0, items: rows(result.data).map(interaction => ({
            label: String(interaction.summary ?? interaction.interactionId), detail: String(interaction.expiresAt ?? ''), action: () => {
                this.details = Object.entries(interaction).filter(([key]) => !/secret|credential|token/i.test(key)).map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`);
                this.menu = { title: '核对动作与范围后答复', index: 0, items: [
                    { label: '拒绝本动作', action: () => this.respondInteraction(interaction, 'deny') },
                    { label: '仅批准本次', action: () => this.respondInteraction(interaction, 'approve') },
                    { label: '填写提问答复', action: () => this.openForm('答复提问', [{ key: 'answer', label: '答复', required: true }], values => this.respondInteraction(interaction, 'answer', values.answer)) },
                ] };
            },
        })) };
        if (!this.menu.items.length) this.menu.items.push({ label: '当前没有待办', action: () => { this.menu = undefined; } });
    }

    private async queueMenu(): Promise<void> {
        if (!this.conversation || !this.run) { this.log('当前没有可查看的执行队列'); return; }
        const conversationId = String(this.conversation.conversationId);
        const runId = String(this.run.runId);
        const snapshot = await this.client.request<Record<string, unknown>>('runs.get', { conversationId, runId });
        const result = await this.client.request('inputs.list', { conversationId, runId, limit: 100 });
        if (!result.ok || !snapshot.ok || !snapshot.data) { this.showError(!result.ok ? result : snapshot); return; }
        const run = snapshot.data;
        const queued = rows(result.data).filter(input => input.state === 'queued');
        const items: MenuItem[] = queued.map(input => ({ label: String(input.inputId), detail: String(input.mode), action: () => {
            this.menu = { title: '未认领输入 · ' + input.inputId, index: 0, items: [
                { label: '查看完整原输入', disabled: METHOD_SPECS['conversations.readArtifact'] ? undefined : '原文读取入口尚未安装', action: async () => {
                    const content = await this.readInputContent(conversationId, input);
                    if (content) { this.details = humanJson(content).split('\n'); this.detailsOffset = 0; }
                } },
                { label: '编辑正文', disabled: METHOD_SPECS['conversations.readArtifact'] ? undefined : '原文读取入口尚未安装', action: async () => {
                    const content = await this.readInputContent(conversationId, input);
                    if (!content) return;
                    this.openForm('编辑排队输入', [{ key: 'text', label: '新的完整正文', defaultValue: String(content.text ?? ''), required: true, preserveWhitespace: true }], async values => {
                    const response = await this.client.request('inputs.update', { conversationId, runId, expectedRunEpoch: run.runEpoch,
                        inputId: input.inputId, content: { ...content, text: values.text }, expectedRevision: run.queueRevision });
                    this.showResult({ result: response });
                    if (response.ok) await this.queueMenu();
                    });
                } },
                { label: '撤回这条输入', action: async () => {
                    const response = await this.client.request('inputs.remove', { conversationId, runId, expectedRunEpoch: run.runEpoch,
                        inputId: input.inputId, expectedRevision: run.queueRevision });
                    this.showResult({ result: response }); if (response.ok) await this.queueMenu();
                } },
                { label: '移到最前面', action: async () => {
                    const inputIds = [input.inputId, ...queued.filter(item => item.inputId !== input.inputId).map(item => item.inputId)];
                    const response = await this.client.request('inputs.reorder', { conversationId, runId, expectedRunEpoch: run.runEpoch, inputIds, expectedRevision: run.queueRevision });
                    this.showResult({ result: response }); if (response.ok) await this.queueMenu();
                } },
            ] };
        } }));
        if (run.state === 'paused') items.push({ label: '明确继续原执行', action: async () => {
            const response = await this.client.request('runs.resume', { conversationId, runId, expectedRunEpoch: run.runEpoch, expectedHistoryEpoch: this.conversation!.historyEpoch });
            this.showResult({ result: response });
        } });
        if (!items.length) items.push({ label: '当前没有未消费输入', action: () => { this.menu = undefined; } });
        this.menu = { title: '输入队列 · ' + runId, index: 0, items };
    }

    private async artifactsMenu(cursor?: string): Promise<void> {
        if (!this.conversation) { this.log('先打开一个会话再查看所属产物'); return; }
        const conversationId = String(this.conversation.conversationId);
        const result = await this.client.request<Record<string, unknown>>('conversations.listArtifacts', { conversationId, limit: 20, maxBytes: 256 * 1024, ...(cursor ? { cursor } : {}) });
        if (!result.ok || !result.data) { this.showError(result); return; }
        if (this.terminal.linear) { this.showResult({ result }); return; }
        const items: MenuItem[] = rows(result.data).map(artifact => {
            const metadata = artifactMetadata(artifact, conversationId, this.client.dataDir);
            const artifactId = String(artifact.artifactId);
            return { label: `${artifact.type ?? '文件'} · ${artifact.mime ?? '未知类型'}`, detail: `${artifact.state} · ${metadata.totalBytes ?? '未知'}字节 · ${artifactId}`, action: () => {
                this.menu = { title: '原件 · ' + artifactId, index: 0, items: [
                    { label: '查看元数据或完整文本', action: async () => { await this.perform(['artifact', 'show', artifactId, '--conversation', conversationId]); } },
                    { label: '保存原字节（完整校验后写入）', disabled: artifact.state === 'remote_pending' ? '原件仍待获取，请先处理核心给出的获取状态' : undefined,
                        action: () => this.openForm('保存所属产物', [{ key: 'path', label: '明确的目标文件路径，默认保留已有文件', required: true }], async values => { await this.perform(['artifact', 'save', artifactId, values.path, '--conversation', conversationId]); }) },
                    { label: '返回产物列表', action: () => this.artifactsMenu(cursor) },
                ] };
            } };
        });
        if (result.data.nextCursor) items.push({ label: '下一页原件', action: () => this.artifactsMenu(String(result.data!.nextCursor)) });
        if (!items.length) items.push({ label: '本会话当前没有媒体原件', action: () => { this.menu = undefined; } });
        this.menu = { title: '实际产物 · ' + conversationId, index: 0, items };
    }

    private async readInputContent(conversationId: string, input: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
        if (input.content && typeof input.content === 'object') return valueObject(input.content);
        if (typeof input.contentId !== 'string') { this.log('这条输入缺少原文引用，请刷新队列'); return; }
        const artifact = await this.client.readArtifact(conversationId, input.contentId);
        if (!artifact.ok || !artifact.data) { this.showError(artifact); return; }
        return valueObject(decodeArtifactJson(artifact.data));
    }

    private async respondInteraction(interaction: Record<string, unknown>, decision: string, answer?: string): Promise<void> {
        const result = await this.client.request('interactions.respond', { conversationId: this.conversation!.conversationId, interactionId: interaction.interactionId,
            decision, ...(answer !== undefined ? { answer } : {}), scopeHash: interaction.scopeHash, actionHash: interaction.actionHash,
            policyRevision: interaction.policyRevision, expectedRevision: interaction.revision });
        this.showResult({ result });
    }

    private async terminalCommand(words: string[]): Promise<void> {
        if (words[0] === 'set' && words[1] === 'enterBehavior' && ['send', 'newline'].includes(words[2])) {
            this.localPreferences.add('terminal.enterBehavior'); this.enterBehavior = words[2] as 'send' | 'newline';
        }
        else if (words[0] === 'motion' && ['full', 'reduced', 'off'].includes(words[1])) {
            this.localPreferences.add('terminal.motion'); this.setMotionMode(words[1] as 'full' | 'reduced' | 'off');
        }
        else if (words[0] === 'graphics' && ['auto', 'blocks', 'sixel', 'kitty', 'none'].includes(words[1])) {
            this.localPreferences.add('terminal.graphics'); this.initial.options.graphics = words[1]; await this.negotiateGraphics();
        }
        else if (words[0] === 'width' && ['narrow', 'wide'].includes(words[1])) {
            this.localPreferences.add('terminal.width'); this.renderer.options.ambiguousWidth = words[1] as AmbiguousWidth; this.detailCache = undefined;
        }
        else if (words[0] !== 'show') throw usage('使用/terminal set enterBehavior send|newline、/terminal graphics auto|blocks|sixel|none、/terminal motion full|reduced|off或/terminal width narrow|wide');
        this.details = [`Enter行为：${this.enterBehavior}`, `图像模式：${graphicsSummary(this.renderer.options.graphics, this.renderer.options.color)} · 动效：${this.motionMode}`,
            `颜色：${this.renderer.options.color ? '开启' : '关闭'} · 模糊宽度：${this.renderer.options.ambiguousWidth ?? 'narrow'}`,
            `历史页大小：${this.historyPageSize} · 偏好版本：${this.preferencesRevision ?? '尚未读取'}`, `终端尺寸：${this.terminal.width}×${this.terminal.height}`,
            `字体格：${this.renderer.options.cellSize ? `${this.renderer.options.cellSize.width}×${this.renderer.options.cellSize.height}` : '终端尚未回报，字符按10×20估计'}`];
        this.renderer.reset();
    }

    private async negotiateGraphics(): Promise<void> {
        this.graphicsNegotiation?.finish();
        const revision = ++this.geometryRevision;
        const width = this.terminal.width;
        const height = this.terminal.height;
        const requested = String(this.initial.options.graphics ?? 'auto');
        if (this.terminal.linear || requested === 'none') { this.renderer.options.graphics = 'none'; this.renderer.options.cellSize = undefined; return; }
        let sixel = false;
        let cell: [number, number] | undefined;
        const manual = /^(\d+)x(\d+)$/.exec(String(this.initial.options['cell-size'] ?? ''));
        if (manual) cell = [Number(manual[1]), Number(manual[2])];
        const listener = (reply: string) => {
            if (revision !== this.geometryRevision || width !== this.terminal.width || height !== this.terminal.height) return;
            const size = /^\x1b\[6;(\d+);(\d+)t$/.exec(reply);
            if (size && !manual) cell = [Number(size[2]), Number(size[1])];
            const pixels = /^\x1b\[4;(\d+);(\d+)t$/.exec(reply);
            if (pixels && !manual && !cell) cell = [Number(pixels[2]) / width, Number(pixels[1]) / height];
            if (/^\x1b\[\?[\d;]*c$/.test(reply) && reply.slice(3, -1).split(';').includes('4')) sixel = true;
        };
        this.terminal.on('reply', listener);
        if (requested === 'auto' || requested === 'sixel' || requested === 'blocks') {
            await this.terminal.write((requested === 'blocks' ? '' : '\x1b[c') + '\x1b[16t\x1b[14t');
            await new Promise<void>(resolveWait => {
                const finish = () => { clearTimeout(timer); this.terminal.removeListener('reply', listener); if (this.graphicsNegotiation?.finish === finish) this.graphicsNegotiation = undefined; resolveWait(); };
                const timer = setTimeout(finish, 150);
                this.graphicsNegotiation = { timer, finish };
                if (this.disposed || revision !== this.geometryRevision) finish();
            });
        }
        this.terminal.removeListener('reply', listener);
        if (this.disposed || revision !== this.geometryRevision) return;
        const dimensions = cell && cell.every(value => Number.isFinite(value) && value > 0 && value <= 512) ? { width: cell[0], height: cell[1] } : undefined;
        this.renderer.options.cellSize = dimensions;
        this.renderer.options.graphics = this.renderer.options.color && sixel && dimensions && requested !== 'blocks' ? 'sixel' : 'blocks';
        if (requested === 'sixel' && this.renderer.options.graphics !== 'sixel') this.log('终端尚未确认Sixel图片能力和字格尺寸，当前显示字符兼容画面');
        if (requested === 'kitty') this.log('Kitty帧尚未打包，当前使用同面积字符');
        this.renderer.reset();
        this.detailCache = undefined;
    }

    private async resizeTerminal(): Promise<void> {
        if (this.disposed) return;
        this.renderer.options.graphics = this.terminal.linear ? 'none' : 'blocks';
        if (!this.terminal.linear) await this.terminal.write('\x1b[2J\x1b[H');
        this.renderer.reset(); this.scheduleRender(true);
        await this.negotiateGraphics();
        this.scheduleRender();
    }

    private showQuit(): void {
        const temporary = valueObject(this.conversation?.retention).mode === 'temporary';
        const items: MenuItem[] = [{ label: '取消所属执行、关闭会话并退出', action: () => this.quit(false) }];
        if (!temporary) items.push({ label: '明确脱离前台，后台按原预算继续', action: () => this.quit(true) });
        items.push({ label: '返回，继续编辑', action: () => { this.menu = undefined; } });
        this.menu = { title: '退出前确认', items, index: 0 };
    }

    private async quit(detach: boolean): Promise<void> {
        if (detach && valueObject(this.conversation?.retention).mode === 'temporary') { this.log('临时会话关闭即清，退出需要取消并关闭'); this.showQuit(); return; }
        if (!detach && this.conversation && !this.observing) {
            if (this.run && !terminalRun(this.run)) {
                await this.cancelRun();
                const end = Date.now() + 30_000;
                const runId = String(this.run.runId);
                while (Date.now() < end) {
                    const result: RpcResult<Record<string, unknown>> = await this.client.request('runs.get', { conversationId: this.conversation.conversationId, runId });
                    if (result.ok && result.data) {
                        const snapshot = result.data;
                        this.run = snapshot; this.updateState();
                        if (terminalRun(snapshot) && ['released', 'not_needed'].includes(String(snapshot.cleanupState))) break;
                    }
                    await new Promise(resolveWait => setTimeout(resolveWait, 100));
                }
                if (this.run && !['released', 'not_needed'].includes(String(this.run.cleanupState))) { this.log('资源收尾仍待确认，退出前台后按原runId查询'); await this.finish(7); return; }
            }
            const result = await this.client.request('conversations.close', { conversationId: this.conversation.conversationId, reason: '人工前台退出' });
            if (!result.ok) { this.showError(result); return; }
            await this.client.releaseControl('conversation', String(this.conversation.conversationId));
        } else if (this.conversation && !this.observing) await this.client.releaseControl('conversation', String(this.conversation.conversationId));
        await this.finish(0);
    }

    private async closeTemporaryAndOpen(targetId: string, observe: boolean): Promise<void> {
        if (!this.conversation || this.switching) return;
        if (this.busy) { this.log('原命令回执仍在等待，先核对原回执后再关闭临时会话'); return; }
        const conversationId = String(this.conversation.conversationId);
        const runId = this.run && !terminalRun(this.run) ? String(this.run.runId) : undefined;
        this.switching = true; this.busy = true;
        let closed = false;
        try {
            if (runId) {
                const stopped = await cancelExecution(this.client, conversationId, runId);
                if (!stopped.ok) { this.showError(stopped); return; }
                if (!terminalRun(valueObject(stopped.data)) || !['released', 'not_needed'].includes(String(valueObject(stopped.data).cleanupState))) {
                    this.showError({ ok: false, error: { code: 'CLEANUP_UNCONFIRMED', message: '原执行结果或资源收尾仍待确认，临时会话继续保留', retryable: true, mayHaveStarted: true, details: { conversationId, runId } } }); return;
                }
            }
            const result = await this.client.request('conversations.close', { conversationId, reason: '明确关闭临时会话后切换' });
            if (!result.ok) { this.showError(result); return; }
            await this.monitor?.stop(); this.monitor = undefined;
            this.drafts.delete(conversationId); this.pendingDrafts.delete(conversationId);
            for (let index = this.history.length - 1; index >= 0; index -= 1) if (this.history[index].conversationId === conversationId) this.history.splice(index, 1);
            for (const [key, pending] of this.pendingCommands) if (pending.conversationId === conversationId) this.pendingCommands.delete(key);
            this.conversation = undefined; this.run = undefined; this.draft = new DraftBuffer(); this.outputText = '';
            this.logs = []; this.details = []; this.detailCache = undefined; this.form = undefined; this.commandDraft = undefined; this.renderer.reset();
            closed = true;
        } finally { this.switching = false; this.busy = false; }
        if (closed) await this.openConversation(targetId, observe);
    }

    private async printTranscript(text: string): Promise<void> {
        if (this.editing) return;
        if (!this.terminal.linear) await this.terminal.write(`\x1b[${this.terminal.height};1H\x1b[0m\r\n`);
        await new Promise<void>((resolveWrite, rejectWrite) => this.streams.stdout.write(terminalSafeText(text) + '\n', error => error ? rejectWrite(error) : resolveWrite()));
        if (!this.terminal.linear) await this.terminal.write('\n'.repeat(this.terminal.height));
        this.renderer.reset();
    }

    private showResult(execution: CommandExecution, options: { raw?: boolean; titleHint?: string } = {}): void {
        if (!execution.result.ok) { this.showError(execution.result); return; }
        this.details = interactiveResultLines(execution, options);
        this.detailsOffset = 0;
        this.log(execution.result.receiptId ? '操作回执 ' + execution.result.receiptId : '查询已返回');
        this.scheduleRender();
    }
    private showError(result: RpcResult, operation = true): void {
        if (operation) this.errorSerial += 1;
        const message = `${result.error?.code ?? 'ERROR'}：${result.error?.message ?? '操作未完成'}`;
        this.log(message);
        this.details = [message, ...(result.error?.details ? JSON.stringify(result.error.details, null, 2).split('\n') : [])];
        this.detailsOffset = 0;
        this.scheduleRender();
    }
    private log(message: string): void { if (this.logs.at(-1) !== message) this.logs.push(message); this.logs = this.logs.slice(-50); }

    private view(): TerminalView {
        let details = this.detailLines().slice(this.detailsOffset);
        if (this.menu) {
            const geometry = this.renderer.geometry(this.terminal.width, this.terminal.height);
            const pageSize = Math.max(3, geometry.bodyRows - 3);
            const start = Math.floor(this.menu.index / pageSize) * pageSize;
            this.menuPage = start;
            const selected = this.menu.items[this.menu.index];
            details = [this.menu.title + (!this.menu.commandMenu && this.menu.query ? ' · 当前页筛选：' + this.menu.query : ''), ...this.menu.items.slice(start, start + pageSize).map((item, index) => `${start + index === this.menu!.index ? '›' : ' '} ${item.label}${item.disabled ? ' [不可用]' : ''}`), selected?.disabled ?? selected?.detail ?? '', `${this.menu.index + 1}/${this.menu.items.length} · ↑↓选择 · Enter确认`];
        } else if (this.form) {
            const field = this.form.fields[this.form.index];
            details = [this.form.title, `${this.form.index + 1}/${this.form.fields.length} · ${field.label}`, ...(field.choices ? ['可选：' + field.choices.join(' / '), '↑↓切换选项'] : []), 'Enter下一项 · Shift+Tab上一项 · Esc保留原稿并返回'];
        } else if (!details.length) {
            const retention = valueObject(this.conversation?.retention);
            details = ['准备工作', `会话：${this.conversation?.conversationId ?? '尚未选择'}`, `保存：${retention.mode ?? '新建默认archive'}`, `模型：${this.selectedModel ?? '使用会话配置'}`, `控制：${this.observing ? '只读观察' : '取得后自动续租'}`, 'Enter：发送/下一轮 · Ctrl+J换行', '/help命令 · /approvals待办', '/run control控制 · /quit退出'];
        }
        return { state: this.state, status: this.status,
            connection: `${this.connection} | ${graphicsSummary(this.renderer.options.graphics, this.renderer.options.color)}`, details, logs: this.logs,
            draft: this.form?.draft ?? this.commandDraft ?? this.draft, hidden: this.form?.fields[this.form.index].hidden,
            inputLabel: this.form?.fields[this.form.index].label,
            hint: this.form ? '表单输入 · Esc返回' : this.pendingDraft ? '原发送状态待确认，再次发送只查原回执' : this.run?.kind === 'maintenance' && !terminalRun(this.run) ? '维护中，草稿保留；结束后再次发送' : `Enter${this.enterBehavior === 'newline' ? '换行' : this.run && !terminalRun(this.run) ? '下一轮' : '发送'} · Ctrl+J换行 · Alt+Enter当前轮 · /命令`, stateStartedAt: this.stateStartedAt };
    }

    private detailLines(): string[] {
        const geometry = this.renderer.geometry(this.terminal.width, this.terminal.height);
        const sprite = geometry.canDraw && this.renderer.options.graphics !== 'none' && this.renderer.assets.sprites ? geometry.graphicColumns : 0;
        const width = Math.max(8, this.terminal.width - (sprite ? sprite + 9 : 4));
        if (this.detailCache?.source === this.details && this.detailCache.width === width) return this.detailCache.lines;
        const lines = this.details.flatMap(line => wrapText(line, width, this.renderer.options.ambiguousWidth));
        this.detailCache = { source: this.details, width, lines };
        return lines;
    }

    private get pendingDraft(): PendingDraft | undefined { return this.conversation ? this.pendingDrafts.get(String(this.conversation.conversationId)) : undefined; }

    private scheduleRender(immediate = false): void {
        if (this.disposed || this.editing || this.renderTimer) return;
        if (this.renderInFlight) { this.renderAgain = true; return; }
        this.renderTimer = setTimeout(async () => {
            this.renderTimer = undefined;
            if (this.disposed) return;
            this.renderInFlight = true;
            try {
                if (this.terminal.linear) {
                    const view = this.view();
                    const frame = [view.connection, ...view.details, view.status, ...view.logs.slice(-1), view.inputLabel ?? '输入', view.hidden ? '（隐藏）' : view.draft.text].join('\n') + '\n';
                    if (frame !== this.lastLinearFrame) { await this.terminal.write(terminalSafeText(frame)); this.lastLinearFrame = frame; }
                } else await this.terminal.write(this.renderer.render(this.view(), this.terminal.width, this.terminal.height));
            } catch { await this.finish(4); }
            finally {
                this.renderInFlight = false;
                if (this.renderAgain) { this.renderAgain = false; this.scheduleRender(); }
            }
        }, immediate ? 0 : 40);
    }

    private animate(): void {
        if (this.animationTimer) clearTimeout(this.animationTimer);
        this.animationTimer = undefined;
        if (this.disposed || this.motionMode === 'off') return;
        const compact = this.renderer.geometry(this.terminal.width, this.terminal.height).compact;
        const delay = this.renderer.assets.nextFrameDelay(this.state, compact, Math.max(0, Date.now() - this.stateStartedAt), this.renderer.options.reducedMotion);
        this.animationTimer = setTimeout(() => {
            this.animationTimer = undefined;
            if (this.state === 'complete' && Date.now() - this.stateStartedAt >= 750) { this.state = 'idle'; this.stateStartedAt = Date.now(); }
            this.scheduleRender(); this.animate();
        }, delay);
    }

    private async finish(code: number): Promise<void> {
        if (this.disposed) return;
        this.disposed = true;
        this.preferencesGeneration += 1;
        this.viewEpoch += 1;
        this.geometryRevision += 1;
        this.graphicsNegotiation?.finish();
        this.editorAbort?.abort();
        if (this.renderTimer) clearTimeout(this.renderTimer);
        if (this.animationTimer) clearTimeout(this.animationTimer);
        this.renderTimer = undefined;
        this.animationTimer = undefined;
        process.removeListener('SIGTERM', this.signalHandler);
        this.client.removeListener('controlLost', this.lostControl);
        let exitCode = code;
        try { await this.monitor?.stop(); } catch { exitCode ||= 4; }
        this.renderer.dispose();
        try { await this.terminal.dispose(); } catch { exitCode ||= 4; }
        this.quitResolve?.(exitCode);
    }

    private async editDraft(): Promise<void> {
        const retention = String(valueObject(this.conversation?.retention).mode ?? '');
        if (retention === 'temporary') { this.showError({ ok: false, error: { code: 'E_TEMPORARY_EDITOR_UNAVAILABLE', message: '临时会话继续使用内置多行编辑，外部编辑器需要先转换保存方式', retryable: false, mayHaveStarted: false } }); return; }
        if (!this.conversation || this.editing) { this.log('先打开归档或限时会话'); return; }
        const revision = this.draft.revision;
        this.editing = true; this.editorAbort = new AbortController();
        if (this.renderTimer) clearTimeout(this.renderTimer);
        this.renderTimer = undefined;
        try {
            await this.terminal.suspend();
            const text = await editDraftText(this.draft.text, { cwd: this.streams.cwd ?? process.cwd(), signal: this.editorAbort.signal, retention });
            if (this.draft.revision === revision) { this.draft.replace(text); this.log('编辑器草稿已读回，尚未发送'); }
            else this.log('草稿已出现更新，编辑器结果未覆盖当前版本');
        } catch (error) { this.showError(clientFailure(error)); }
        finally {
            this.editing = false; this.editorAbort = undefined;
            if (!this.disposed) { await this.terminal.open(); this.renderer.reset(); this.scheduleRender(true); }
        }
    }
}

export async function runInteractiveCli(initial: ParsedArguments, client: AgentClient, streams: CliStreams): Promise<number> {
    return new InteractiveCli(initial, client, streams).start();
}
