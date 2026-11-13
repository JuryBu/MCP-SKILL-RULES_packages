import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, resolve, sep } from 'node:path';
import { AgentClient, clientFailure } from '../agent-client/client.js';
import { canonicalJson, METHOD_SPECS, type AgentEvent, type RpcResult } from '../agent-server/protocol.js';
import { parseArguments, parseJsonObject, tokenizeCommand, usage, type ParsedArguments } from './arguments.js';
import { COMMAND_SPECS, commandEffect, executeCommand, parseBudget, parseCommand, renderHelp, supportsServerSecretImport, type CommandExecution, type CommandSpec } from './commands.js';
import { DraftBuffer, readCommandInput } from './input.js';
import { TerminalSession, terminalGraphicsHost, type TerminalKey } from './terminal.js';
import { TerminalRenderer, cleanText, terminalSafeText, visibleWidth, wrapText, layoutDraftInput, type TerminalView } from './renderer.js';
import { cancelExecution, ConversationMonitor, eventText, resolveRunResult } from './watch.js';
import { decodeArtifactJson } from '../agent-client/artifacts.js';
import type { CliStreams } from './main.js';
import type { MascotState } from './graphics/assets.js';
import { editDraftText } from './editor.js';
import { artifactMetadata, formatExecutionText, humanJson, markdownDisplayLines } from './presentation.js';
import { conversationSummary, graphicsSummary, interactiveResultLines, profileCatalogRefreshLines, workspaceUpdateLines } from './ui-results.js';
import { prepareCliInputReferences } from './references.js';
import { readConfigurationCliPreferences, refreshSavedProfileCatalog } from './configuration-commands.js';
import type { AmbiguousWidth } from './configuration-width.js';
import { directoryPage, filePreview } from './selection.js';
import type { UsageOverview } from './usage-view.js';
import { appendTranscriptLines, historyMessage, modelHistoryText, TRANSCRIPT_HISTORY_LIMITS } from './history-view.js';
import { FolderPickerError, pickDirectory } from './folder-picker.js';
import { PartialAnswerBuffer, type PartialAnswerState } from './partial-answer.js';
import { runFailureLines } from './run-view.js';
import { NativeConsoleGraphics, type NativeGraphicsEvent } from './graphics/native-console.js';
import { chatUsageLines, declaredParameterFields, detailedUsageLines, groupProviderProfiles, idleAppearance, localTime, modelToolSupport, optionalDateTime, projectFromOptions, protocolLabel, readParameterValues, type CliPreparation, type CliProject, type CliProviderGroup } from './ui-workflow.js';

type MenuItem = { label: string; detail?: string; action: () => void | Promise<void>; disabled?: string };
type Menu = { title: string; items: MenuItem[]; index: number; startup?: boolean; query?: string; commandMenu?: boolean; sourceItems?: MenuItem[]; context?: string[]; contextOffset?: number; back?: () => void | Promise<void> };
type Field = { key: string; label: string; defaultValue?: string; choices?: string[]; hidden?: boolean; sensitive?: boolean; required?: boolean; preserveWhitespace?: boolean;
    validate?: (text: string, values: Readonly<Record<string, string>>) => string | undefined };
type Form = { title: string; fields: Field[]; index: number; values: Record<string, string>; draft: DraftBuffer; complete: (values: Record<string, string>) => Promise<void>; back?: () => void | Promise<void>; error?: string };
type InputHistoryEntry = { text: string; conversationId: string; references?: unknown[]; inputMode?: 'queue' | 'steer' };
type PendingDraft = { commandId: string; conversationId: string; revision: number; draft: DraftBuffer; text?: string; historyEntry?: InputHistoryEntry };

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
    private readonly conversationUpdateReceipts = new Map<string, CommandExecution>();
    private logs: string[] = [];
    private details: string[] = [];
    private transcript: string[] = [];
    private transcriptFollow = true;
    private detailsOffset = 0;
    private detailCache?: { source: string[]; width: number; ambiguousWidth?: AmbiguousWidth; emojiFallback?: boolean; lines: string[] };
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
    private appearanceTimer?: NodeJS.Timeout;
    private lastUserActivityAt = Date.now();
    private lastReplyFinishedAt = 0;
    private lastFinishedActivityRun?: string;
    private readonly startedAt = Date.now();
    private readonly history: InputHistoryEntry[] = [];
    private historyIndex = -1;
    private interruptCount = 0;
    private lastOutputRun?: string;
    private lastOutputContentId?: string;
    private loadingOutput = false;
    private completionShownForRun?: string;
    private outputText = '';
    private partialAnswer?: PartialAnswerBuffer;
    private partialVisible = false;
    private partialFollow = true;
    private readonly modelContentReads = new Set<string>();
    private lastFormalAnswer?: { runId: string; text: string };
    private failureKey?: string;
    private failureDetails: string[] = [];
    private historyCursor?: string;
    private selectedProfile?: string;
    private selectedModel?: string;
    private selectedProfileLabel?: string;
    private modelSetting?: 'default' | 'compression';
    private selectingModel = false;
    private conversationCompression = false;
    private pendingCreationArguments?: string[];
    private readonly pendingSessionCloses = new Map<string, { commandId: string; result?: RpcResult }>();
    private lastOperationReceipt?: CommandExecution;
    private lastFailure?: RpcResult;
    private readonly controlEvents: { asOf: string; event: unknown }[] = [];
    private newSelection: { profileId?: string; modelId?: string } = {};
    private selectionTarget: 'conversation' | 'new' = 'conversation';
    private setupContinuation?: () => Promise<void>;
    private creation?: CliPreparation;
    private project: CliProject;
    private providerGroup?: CliProviderGroup;
    private projectConversationsOnly = false;
    private readonly withoutKey = new Set<string>();
    private readonly pendingSecrets = new Map<string, string>();
    private readonly profileCatalogRefreshes = new Map<string, Record<string, unknown>>();
    private readonly catalogAutoRefreshes = new Set<string>();
    private usageScope = '';
    private usageOverview?: UsageOverview;
    private usageState = '用量正在加载';
    private usageLoadedAt = 0;
    private usageRequest?: Promise<void>;
    private usageTimer?: NodeJS.Timeout;
    private printingTranscript = false;
    private budget?: Record<string, unknown>;
    private menuPage = 0;
    private lastLinearFrame = '';
    private errorSerial = 0;
    private geometryRevision = 0;
    private graphicsNegotiation?: { timer: NodeJS.Timeout; finish: () => void };
    private nativeGraphics?: NativeConsoleGraphics;
    private nativeGraphicsReady = false;
    private nativeGraphicsAttempted = false;
    private nativeLayoutRevision = 0;
    private nativePaintRevision = -1;
    private nativeFrameKey = '';
    private nativeRectangle = '';
    private terminalGraphicsMode: 'blocks' | 'sixel' | 'kitty' = 'blocks';
    private readonly createNativeGraphics = (onEvent: (event: NativeGraphicsEvent) => void) => new NativeConsoleGraphics(onEvent);
    private editing = false;
    private pickerAbort?: AbortController;
    private readonly folderPicker = pickDirectory;
    private pickerFailure?: FolderPickerError;
    private editorAbort?: AbortController;
    private switching = false;
    private readonly signalHandler = () => { void this.finish(143); };
    private readonly lostControl = (event: { message?: string; lease?: { scope?: string; conversationId?: string } }) => {
        this.controlEvents.push({ asOf: new Date().toISOString(), event: structuredClone(event) });
        if (this.controlEvents.length > 20) this.controlEvents.shift();
        if (this.conversation && event.lease?.scope === 'conversation' && event.lease.conversationId === this.conversation.conversationId) {
            this.observing = true; this.status = '只读观察 · /run control可申请继续编辑';
        }
        this.scheduleRender();
    };

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
        this.newSelection = { profileId: this.selectedProfile, modelId: this.selectedModel };
        this.project = projectFromOptions({ writeRoots: options['write-root'] }, streams.cwd ?? process.cwd());
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
            await this.loadSavedPreferences();
            const conversationId = this.initial.options.conversation ?? this.initial.options['conversation-id'];
            if (typeof conversationId === 'string') await this.openConversation(conversationId);
            else if (this.initial.options.mode) {
                if (!['archive', 'temporary', 'ttl'].includes(String(this.initial.options.mode))) throw usage('--mode可选archive|temporary|ttl');
                await this.newConversation(String(this.initial.options.mode));
            }
            else if (this.menu?.startup) this.showStartup();
            void this.refreshUsage(true);
            this.usageTimer = setInterval(() => { void this.refreshUsage(); }, 15_000);
            this.usageTimer.unref();
            this.scheduleRender();
        }).catch(error => { this.connection = this.client.connected ? 'Agent Server已连接' : '连接失败'; this.showError(clientFailure(error)); });
        this.animate();
        this.scheduleAppearanceDeadline();
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
                this.hideNativeGraphics();
                if (!this.terminal.linear) await this.terminal.write(this.renderer.clearFrame());
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
        if (key.name !== 'eof') this.noteUserActivity();
        if (this.form && ['text', 'backspace', 'delete', 'up', 'down'].includes(key.name)) this.form.error = undefined;
        if (this.pickerAbort) { if (['escape', 'interrupt', 'eof'].includes(key.name)) this.pickerAbort.abort(); return; }
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
            const overlay = Boolean(this.form || this.menu || this.commandDraft);
            const back = this.form?.back ?? this.menu?.back;
            if (this.form) { this.clearFormSecrets(this.form); this.form = undefined; }
            this.menu = undefined; this.commandDraft = undefined;
            if (back) await back();
            else if (this.creation) await this.creationMenu();
            else if (!this.conversation) this.showStartup();
            else if (!overlay) this.sessionNavigationMenu();
            this.scheduleRender(); return;
        }
        if (key.paste) {
            const target = this.form?.draft ?? this.commandDraft ?? this.draft;
            target.insert(key.text ?? '');
            if (!this.form) this.menu = undefined;
            this.scheduleRender(); return;
        }
        if (key.name.startsWith('alt-') && key.name !== 'alt-enter' && !this.form) {
            if (key.name === 'alt-m') this.modelMenu();
            else if (key.name === 'alt-w') await this.workspaceMenu();
            else if (key.name === 'alt-s') this.settingsMenu();
            else if (key.name === 'alt-n') this.conversationModeMenu();
            else if (key.name === 'alt-r') await this.listConversations();
            else return;
            this.scheduleRender(); return;
        }
        if (this.form && key.name === 'backtab') {
            const form = this.form;
            const previous = form.fields[form.index];
            if (!previous.sensitive) form.values[previous.key] = form.draft.text;
            else form.draft.replace('');
            form.index = Math.max(0, form.index - 1);
            form.draft = new DraftBuffer(form.fields[form.index].sensitive);
            form.draft.replace(form.values[form.fields[form.index].key] ?? form.fields[form.index].defaultValue ?? '');
            this.scheduleRender(); return;
        }
        if (this.menu) {
            if ((key.name === 'pageup' || key.name === 'pagedown') && key.source === 'mouse') {
                this.menu.index = Math.max(0, Math.min(this.menu.items.length - 1, this.menu.index + (key.scrollRows ?? (key.name === 'pageup' ? -3 : 3))));
            } else if ((key.name === 'pageup' || key.name === 'pagedown') && this.menu.context) {
                const offset = (this.menu.contextOffset ?? 0) + (key.name === 'pageup' ? -3 : 3);
                this.menu.contextOffset = Math.max(0, Math.min(Math.max(0, this.menuContextLines().length - 3), offset));
            } else if (key.name === 'up' || key.name === 'down') {
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
            else if (!this.form && !this.commandDraft && key.text === '@' && (!target.text || /\s$/.test(target.text))) await this.referenceMenu();
            else if (!this.form && !this.commandDraft && this.draft.text === '' && key.text?.startsWith('/') && !key.text.startsWith('//')) { this.commandDraft = new DraftBuffer(); this.commandDraft.insert(key.text); }
            else target.insert(key.text ?? '');
        } else if (key.name === 'left') target.move(-1);
        else if (key.name === 'right') target.move(1);
        else if (key.name === 'home') target.home();
        else if (key.name === 'end' && !target.text && !this.form && !this.commandDraft) { this.scrollDetails(Number.MAX_SAFE_INTEGER); }
        else if (key.name === 'end') target.end();
        else if (key.name === 'backspace') target.erase(true);
        else if (key.name === 'delete') target.erase(false);
        else if (key.name === 'clear-line') target.clearLine();
        else if (key.name === 'undo') target.undo();
        else if (key.name === 'redo') target.redo();
        else if (key.name === 'newline') target.insert('\n');
        else if (key.name === 'menu') this.showCommands();
        else if (key.name === 'pageup' || key.name === 'pagedown') {
            const { pageRows } = this.detailPage();
            this.scrollDetails(key.scrollRows ?? (key.name === 'pageup' ? -pageRows : pageRows));
        }
        else if (key.name === 'tab') {
            if (this.form?.fields[this.form.index].key === 'path') await this.completePath(this.form);
            else if (this.form) await this.advanceForm();
            else if (!target.text || target.text.startsWith('/')) this.completeCommand(target);
        }
        else if (key.name === 'up' || key.name === 'down') {
            if (this.form?.fields[this.form.index].choices) {
                const values = this.form.fields[this.form.index].choices!;
                const index = values.indexOf(target.text);
                target.replace(values[(index + (key.name === 'up' ? -1 : 1) + values.length) % values.length]);
            } else if (!target.text || this.historyIndex >= 0) {
                this.historyIndex = Math.max(-1, Math.min(this.history.length - 1, this.historyIndex + (key.name === 'up' ? 1 : -1)));
                if (this.historyIndex < 0) { target.replace(''); if (target === this.draft) target.references = []; }
                else this.restoreInputHistory(this.history[this.history.length - 1 - this.historyIndex], target);
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
        if (this.conversation) { this.sessionNavigationMenu(); return; }
        if (this.terminal.linear) {
            this.menu = undefined;
            this.details = [`项目：${this.project.name}`, `工作目录：${this.project.roots[0]}`, '/new：选择保存方式、API Key和模型后开聊', '/back：返回项目 · /close：关闭当前对话 · /quit：退出应用', '/providers：管理API与Key · /sessions：查看已有对话'];
            return;
        }
        this.menu = { title: '项目与对话 · ' + this.project.name, index: 0, startup: true, context: [`工作目录：${this.project.roots[0]}`, '选择目录后，新对话仅在确认的目录范围内工作'], items: [
            { label: '新建对话', detail: '选择临时或归档，再选API Key与模型', action: () => this.conversationModeMenu() },
            { label: '这个项目的对话', action: async () => { this.projectConversationsOnly = true; await this.listConversations(); } },
            { label: '选择另一个项目目录', action: () => this.selectProjectDirectory() },
            { label: '项目名称', detail: this.project.name, action: () => this.openForm('项目名称', [{ key: 'name', label: '项目名称', defaultValue: this.project.name, required: true }], async values => { this.project.name = values.name; this.showStartup(); }, () => this.showStartup()) },
            { label: 'API与Key管理', detail: '编辑、轮换和刷新目录在这里', action: async () => { this.selectionTarget = 'conversation'; this.modelSetting = undefined; this.selectingModel = false; await this.listProfiles(); } },
            { label: '退出应用', action: () => this.showQuit() },
        ] };
    }

    private conversationModeMenu(): void {
        this.menu = { title: '新对话 · 保存方式', index: 0, context: [`项目：${this.project.name}`, `工作目录：${this.project.roots[0]}`], back: () => this.cancelCreation(), items: [
            { label: '临时对话', detail: '关闭后清除正文和本对话草稿', action: () => this.newConversation('temporary') },
            { label: '归档对话', detail: '返回项目后可继续打开', action: () => this.newConversation('archive') },
            { label: '限时保存', detail: '按指定时长保留', action: () => this.newConversation('ttl') },
            { label: '返回项目', action: () => this.cancelCreation() },
        ] };
        this.scheduleRender();
    }

    private cancelCreation(): void {
        this.creation = undefined; this.setupContinuation = undefined; this.providerGroup = undefined;
        this.selectionTarget = 'conversation'; this.modelSetting = undefined; this.selectingModel = false;
        this.showStartup();
    }

    private async selectProjectDirectory(): Promise<void> {
        if (this.conversation) { this.sessionNavigationMenu(() => this.selectProjectDirectory()); return; }
        await this.browseDirectory(this.project.roots[0], async path => {
            this.project = projectFromOptions({ writeRoots: [path] }, this.streams.cwd ?? process.cwd());
            this.creation = undefined; this.setupContinuation = undefined; this.selectionTarget = 'conversation';
            this.showStartup();
        });
        if (this.menu) this.menu.back = () => this.showStartup();
    }

    private showCommands(query = ''): void {
        if (this.terminal.linear) { this.menu = undefined; this.details = renderHelp(query || undefined).split('\n'); this.detailsOffset = 0; return; }
        const shortcuts: MenuItem[] = [
            { label: '/new', detail: '在当前项目新建临时或归档对话', action: () => this.conversationModeMenu() },
            { label: '/sessions', detail: '查看、打开已有对话', action: () => this.listConversations() },
            { label: '/models', detail: '选择当前主模型与本对话压缩模型', action: () => this.modelMenu() },
            { label: '/connect', detail: '独立管理服务商、API和Key', action: () => this.executeLine('/connect') },
            { label: '/back', detail: '返回项目，应用继续运行', action: () => this.sessionNavigationMenu() },
            { label: '/close', detail: '关闭当前对话并返回项目', action: () => this.sessionNavigationMenu(undefined, true) },
            { label: '/exit', detail: '退出整个应用', action: () => this.showQuit() },
            { label: '/model', detail: '当前对话的服务商、模型与参数', action: () => this.modelMenu() },
            { label: '/providers', detail: '新增、编辑服务商和遮挡Key', action: async () => { this.selectionTarget = 'conversation'; await this.listProfiles(); } },
            { label: '/workspace', detail: '目录浏览、补全与多个可写根', action: () => this.workspaceMenu() },
            { label: '/settings', detail: '主模型、压缩模型与终端设置', action: () => this.settingsMenu() },
            { label: '/usage', detail: '用量、缓存率、费用与余额来源', action: () => this.executeLine('/usage') },
            { label: '/status', detail: '当前状态与最近设置的原始回执详情', action: () => this.executeLine('/status') },
            { label: '/references', detail: '选择文件、图片与会话引用', action: () => this.referenceMenu() },
        ];
        const rank = (spec: CommandSpec) => [spec.name, ...spec.aliases].some(name => name === query) ? 0 : [spec.name, ...spec.aliases].some(name => name.startsWith(query)) ? 1 : 2;
        const matches = COMMAND_SPECS.filter(spec => `${spec.name} ${spec.aliases.join(' ')} ${spec.summary}`.toLowerCase().includes(query.toLowerCase())).sort((left, right) => rank(left) - rank(right));
        this.menu = { title: `命令与帮助${query ? ' · ' + query : ''}`, index: 0, query, commandMenu: true, items: matches.map(spec => ({
            label: '/' + spec.name, detail: `${spec.name === 'rpc' ? '按实际方法核对 · 高级操作' : spec.name === 'session mode' ? '预览只读，确认时修改保存状态' : spec.mutates ? '修改状态' : '只读/本地'} · ${spec.summary}`, disabled: spec.availability().available ? undefined : spec.availability().reason,
            action: async () => {
                if (['send', 'input current', 'input next'].includes(spec.name)) { await this.sendDraft(spec.name === 'input current' ? 'steer' : 'queue'); return; }
                if (spec.name === 'conversation create') { this.conversationModeMenu(); return; }
                if (['help', 'model', 'queue', 'artifact list', 'run control', 'quit', 'clear', 'editor', 'reconnect', 'terminal show', 'compact'].includes(spec.name)) { await this.executeLine('/' + spec.name); return; }
                this.commandForm(spec);
            },
        })) };
        this.menu.items.unshift(...shortcuts.filter(item => `${item.label} ${item.detail}`.toLowerCase().includes(query.toLowerCase())));
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
            const effect = commandEffect(parseCommand(parseArguments(tokenizeCommand(line))));
            this.commandDraft = new DraftBuffer(); this.commandDraft.replace(line);
            this.log('等价命令：' + line);
            this.menu = { title: '确认等价命令', index: 0, items: [
                { label: '返回编辑命令', detail: line, action: () => {} },
                { label: effect.writes ? '确认执行修改' : '执行查询/本地操作', detail: `${effect.label} · ${effect.method ?? spec.name} · ${line}`, action: async () => { await this.executeLine(line); } },
            ] };
        });
    }

    private showInputHistory(): void {
        this.menu = { title: '选择要回填的输入', index: 0, items: [...this.history].reverse().map(entry => ({ label: cleanText(entry.text), detail: `${entry.references?.length ?? 0}份材料 · ${entry.inputMode === 'steer' ? '补充当前轮' : '新消息或排队'}`, action: () => this.restoreInputHistory(entry) })) };
        if (!this.menu.items.length) this.menu.items.push({ label: '本次还没有已确认的人工输入', action: () => { this.menu = undefined; } });
    }

    private restoreInputHistory(entry: InputHistoryEntry, target = this.draft): void {
        target.replace(entry.text);
        target.references = structuredClone(entry.references ?? []);
        target.inputMode = entry.inputMode ?? 'queue';
        this.referencePreparations.delete(target);
        if (target === this.draft) {
            this.details = ['已回填所选输入 · 仍可修改后发送', entry.text, ...target.references.map(reference => {
                const value = valueObject(reference);
                return '材料：' + String(value.displayName ?? value.path ?? value.source ?? value.sourceId ?? value.referenceId ?? reference);
            })];
            this.detailsOffset = 0; this.detailCache = undefined;
        }
        this.scheduleRender();
    }

    private completeCommand(draft: DraftBuffer): void {
        const matches = COMMAND_SPECS.filter(spec => ('/' + spec.name).startsWith(draft.text));
        if (matches.length === 1) draft.replace('/' + matches[0].name + ' ');
        else this.showCommands(draft.text.replace(/^\//, ''));
    }

    private openForm(title: string, fields: Field[], complete: Form['complete'], back?: Form['back']): void {
        this.menu = undefined;
        const draft = new DraftBuffer(fields[0]?.sensitive); draft.replace(fields[0]?.defaultValue ?? '');
        this.form = { title, fields, index: 0, values: {}, draft, complete, back };
        this.scheduleRender();
    }

    private async advanceForm(): Promise<void> {
        const form = this.form!;
        const field = form.fields[form.index];
        const text = field.preserveWhitespace ? form.draft.text : form.draft.text.trim();
        if (field.required && !text.trim()) { form.error = '请填写' + field.label; this.scheduleRender(); return; }
        if (field.choices && !field.choices.includes(text)) { form.error = '可选：' + field.choices.join(' / '); this.scheduleRender(); return; }
        const problem = field.validate?.(text, { ...form.values, [field.key]: text });
        if (problem) { form.error = problem; this.scheduleRender(); return; }
        form.error = undefined;
        form.values[field.key] = text;
        form.index += 1;
        if (form.index < form.fields.length) {
            const next = form.fields[form.index];
            if (field.sensitive) form.draft.replace('');
            form.draft = new DraftBuffer(next.sensitive);
            form.draft.replace(form.values[next.key] ?? next.defaultValue ?? '');
            return;
        }
        this.form = undefined;
        const errorSerial = this.errorSerial;
        try { await form.complete(form.values); }
        catch (error) { this.showError(clientFailure(error)); }
        finally { this.clearFormSecrets(form); }
        if (this.errorSerial !== errorSerial && !this.form && !this.menu) {
            form.index = form.fields.length - 1;
            form.draft = new DraftBuffer(form.fields[form.index].sensitive);
            form.draft.replace(form.fields[form.index].sensitive ? '' : form.values[form.fields[form.index].key] ?? '');
            form.error = this.lastFailure?.error?.message;
            this.form = form;
        }
    }

    private clearFormSecrets(form: Form): void {
        for (const field of form.fields) if (field.sensitive) { delete form.values[field.key]; if (form.fields[form.index]?.key === field.key || form.draft.sensitive) form.draft.replace(''); }
    }

    private async newConversation(mode: string): Promise<void> {
        if (this.conversation) { this.sessionNavigationMenu(() => this.newConversation(mode)); return; }
        this.creation = { mode, title: String(this.initial.options.title ?? ''), roots: [...this.project.roots], projectName: this.project.name, parameters: {} };
        this.newSelection = { profileId: typeof this.initial.options.profile === 'string' ? this.initial.options.profile : undefined,
            modelId: typeof this.initial.options.model === 'string' ? this.initial.options.model : undefined };
        this.selectionTarget = 'new'; this.modelSetting = undefined;
        this.providerGroup = undefined;
        this.setupContinuation = async () => { await this.creationMenu(); };
        if (this.newSelection.profileId && this.newSelection.modelId) await this.creationMenu();
        else await this.listProfiles();
    }

    private async creationMenu(): Promise<void> {
        if (!this.creation) return;
        const creation = this.creation;
        if (!this.newSelection.profileId || !this.newSelection.modelId) { await this.listProfiles(); return; }
        const selected = { ...this.newSelection };
        const [read, modelRead] = await Promise.all([
            this.client.request<Record<string, unknown>>('profiles.get', { profileId: selected.profileId }),
            this.client.request<Record<string, unknown>>('models.get', { profileId: selected.profileId, modelId: selected.modelId }),
        ]);
        if (this.creation !== creation) return;
        const profile = read.ok ? valueObject(read.data?.profile ?? read.data) : {};
        const tools = modelToolSupport(modelRead.ok ? valueObject(modelRead.data?.entry ?? modelRead.data) : undefined);
        const compression = creation.compression?.modelId ?? (creation.compression === null ? selected.modelId : profile.compressionModelRef ?? selected.modelId);
        const mode = ({ archive: '归档对话', temporary: '临时对话 · 关闭后清除', ttl: '限时保存' } as Record<string, string>)[creation.mode];
        this.menu = { title: creation.toolsEnabled === false ? '确认后开始普通聊天' : tools.supported ? '确认后开始聊天' : tools.label, index: 0, back: () => this.listProfiles(), context: [
            `${creation.projectName} · ${mode}`,
            `Key：${profile.label ?? selected.profileId} · ${creation.toolsEnabled === false ? '普通聊天 · 工具已关闭' : tools.label}`,
            `主模型：${selected.modelId} · 压缩模型：${compression}`,
        ], items: [
            { label: '开始聊天', detail: '工作目录：' + creation.roots[0], disabled: creation.toolsEnabled !== false && !tools.supported ? tools.reason : undefined, action: () => this.createSelectedConversation() },
            ...(!tools.supported ? [{ label: '刷新模型能力', detail: '重新读取模型目录，不发送聊天请求', action: async () => { const refreshed = await this.perform(['model', 'refresh', '--profile', selected.profileId!]); if (refreshed?.result.ok) await this.creationMenu(); } }] : []),
            ...(!tools.supported && creation.toolsEnabled !== false ? [{ label: '仅普通聊天（关闭工具）', detail: '需要明确确认，文件任务继续保留在草稿', action: () => this.confirmPlainChat() }] : []),
            { label: '主模型', detail: selected.modelId, action: async () => { this.modelSetting = undefined; await this.listModels(selected.profileId); } },
            { label: '压缩模型', detail: String(compression), action: () => this.preparationCompressionMenu() },
            { label: '模型参数', detail: '仅显示当前模型有依据的档位与范围，默认值可直接使用', action: () => this.parameterForm() },
            { label: '名称、目录与保存选项', detail: creation.title || '名称留空后采用首条消息', action: () => this.creationAdvancedMenu() },
            { label: '返回选择API Key', action: () => this.providerGroup ? this.listProviderKeys(this.providerGroup) : this.listProfiles() },
        ] };
        this.scheduleRender();
    }

    private preparationCompressionMenu(): void {
        if (!this.creation || !this.newSelection.profileId) return;
        this.menu = { title: '压缩模型 · 只整理本对话的上下文', index: 0, back: () => this.creationMenu(), items: [
            { label: '沿用这个Key的压缩设置', action: async () => { this.creation!.compression = undefined; await this.creationMenu(); } },
            { label: '使用本对话主模型', action: async () => { this.creation!.compression = null; await this.creationMenu(); } },
            { label: '从这个Key可用的模型中选择', action: async () => { this.modelSetting = 'compression'; await this.listModels(this.newSelection.profileId); } },
            { label: '选择其他服务商或Key', action: async () => { this.modelSetting = 'compression'; await this.listProfiles(); } },
            { label: '压缩模型参数', detail: '仅显示这个压缩模型支持的参数', action: () => this.parameterForm('compression') },
        ] };
    }

    private creationAdvancedMenu(): void {
        const creation = this.creation;
        if (!creation) return;
        this.menu = { title: '新对话选项', index: 0, back: () => this.creationMenu(), context: [`工作目录：${creation.roots[0]}`, `允许写入：${creation.roots.join('；')}`], items: [
            { label: '对话名称', detail: creation.title || '采用首条消息', action: () => this.openForm('对话名称', [{ key: 'title', label: '名称 · 可留空', defaultValue: creation.title }], async values => { creation.title = values.title; await this.creationMenu(); }, () => this.creationMenu()) },
            { label: '工作目录', action: () => this.browseDirectory(creation.roots[0], async path => { creation.roots = [path, ...creation.roots.slice(1).filter(root => root !== path)]; await this.creationMenu(); }) },
            { label: '添加可写目录', action: () => this.browseDirectory(creation.roots[0], async path => { if (!creation.roots.includes(path)) creation.roots.push(path); await this.creationMenu(); }) },
            ...(creation.mode === 'ttl' ? [{ label: '保留时长', detail: creation.ttl ?? '7d', action: () => this.openForm('限时保存', [{ key: 'ttl', label: '保留时长，例如2h或7d', defaultValue: creation.ttl ?? '7d', required: true }], async values => { creation.ttl = values.ttl; await this.creationMenu(); }, () => this.creationMenu()) }] : []),
            { label: '返回确认', action: () => this.creationMenu() },
        ] };
    }

    private confirmPlainChat(): void {
        this.menu = { title: '确认仅使用普通聊天', index: 0, context: [
            '这次选择会关闭文件读写、命令执行和其它工具。',
            '当前草稿会保留；文件任务需要切换到已确认支持工具的模型。',
        ], items: [
            { label: '返回选择支持工具的模型', action: () => this.creation ? this.creationMenu() : this.modelMenu() },
            { label: '确认仅普通聊天', action: async () => {
                if (this.creation) { this.creation.toolsEnabled = false; await this.creationMenu(); }
                else if (await this.updateConversationOptions({ toolsEnabled: false })) { this.menu = undefined; this.log('已选择普通聊天，草稿保留，按Enter发送'); }
            } },
        ] };
        this.scheduleRender();
    }

    private async requireModelTools(profileId: string, modelId: string): Promise<boolean> {
        const read = await this.client.request<Record<string, unknown>>('models.get', { profileId, modelId });
        if (!read.ok) { this.showError(read); return false; }
        const support = modelToolSupport(valueObject(read.data?.entry ?? read.data));
        if (support.supported) return true;
        this.menu = { title: support.label, index: 0, context: [support.reason, '消息尚未发送，草稿和附件保留。'], items: [
            { label: '刷新模型能力', detail: '只读取目录，不发送聊天请求', action: async () => {
                const refreshed = await this.perform(['model', 'refresh', '--profile', profileId]);
                if (refreshed?.result.ok && await this.requireModelTools(profileId, modelId)) {
                    if (this.creation) await this.creationMenu(); else { this.menu = undefined; this.log('工具能力已确认，按Enter发送保留的草稿'); }
                }
            } },
            { label: '选择其他模型', action: () => this.listModels(profileId) },
            { label: '仅普通聊天（关闭工具）', action: () => this.confirmPlainChat() },
            { label: '返回并保留草稿', action: () => { this.menu = undefined; } },
        ] };
        this.scheduleRender();
        return false;
    }

    private async createSelectedConversation(): Promise<void> {
        const creation = this.creation;
        if (!creation || !this.newSelection.profileId || !this.newSelection.modelId) { await this.listProfiles(); return; }
        if (!this.pendingCreationArguments && creation.toolsEnabled !== false && !await this.requireModelTools(this.newSelection.profileId, this.newSelection.modelId)) return;
        const draft = this.draft;
        const args = ['conversation', 'create', '--mode', creation.mode, '--profile', this.newSelection.profileId, '--model', this.newSelection.modelId];
        const compressionModelSelection = creation.compression === null ? { profileId: this.newSelection.profileId, modelId: this.newSelection.modelId } : creation.compression;
        args.push('--params', JSON.stringify({ options: { projectName: creation.projectName, workingDirectory: creation.roots[0], parameters: creation.parameters, toolsEnabled: creation.toolsEnabled !== false,
            ...(compressionModelSelection ? { compressionModelSelection } : {}) } }));
        if (creation.title) args.push('--title', creation.title);
        for (const root of creation.roots) args.push('--write-root', root);
        if (creation.mode === 'ttl') args.push('--ttl', creation.ttl ?? '7d');
        const execution = await this.perform(this.pendingCreationArguments ?? args);
        if (execution?.result.error?.mayHaveStarted) this.pendingCreationArguments ??= [...args];
        else this.pendingCreationArguments = undefined;
        if (execution?.result.ok) {
            if (draft.text || draft.references.length) this.draft = draft;
            this.creation = undefined; this.setupContinuation = undefined; this.selectionTarget = 'conversation';
            this.details = ['直接输入消息开始聊天', 'Enter发送 · Ctrl+J换行 · @添加材料', '/model切模型 · /settings设置 · /workspace工作区'];
        }
    }

    private async listConversations(cursor?: string): Promise<void> {
        const result = await this.client.request('conversations.list', { limit: 20, ...(cursor ? { cursor } : {}) });
        if (!result.ok) { this.showError(result); return; }
        const page = valueObject(result.data);
        const conversations = rows(page);
        let nextMetadata = 0;
        await Promise.all(Array.from({ length: Math.min(4, conversations.length) }, async () => {
            while (nextMetadata < conversations.length) {
                const index = nextMetadata++;
                const conversation = conversations[index];
                if (Object.hasOwn(conversation, 'options') || typeof conversation.conversationId !== 'string') continue;
                try {
                    const detail = await this.client.request<Record<string, unknown>>('conversations.get', { conversationId: conversation.conversationId });
                    if (detail.ok && detail.data) conversations[index] = { ...conversation, ...detail.data };
                    else conversations[index] = { ...conversation, metadataUnavailable: true };
                } catch { conversations[index] = { ...conversation, metadataUnavailable: true }; }
            }
        }));
        const selectedProjectRoot = resolve(this.project.roots[0]).toLowerCase();
        const shown = this.projectConversationsOnly ? conversations.filter(conversation => conversation.metadataUnavailable || resolve(projectFromOptions(conversation.options, this.streams.cwd ?? process.cwd()).roots[0]).toLowerCase() === selectedProjectRoot) : conversations;
        const items: MenuItem[] = shown.map(conversation => {
            const options = valueObject(conversation.options);
            const roots = Array.isArray(options.writeRoots) ? options.writeRoots.map(String) : [];
            const selection = valueObject(options.modelSelection);
            return { label: conversation.metadataUnavailable ? '会话信息暂未取得' : String(options.title || '未命名对话'),
                detail: conversation.metadataUnavailable ? '详情读取未完成，选择后打开原会话核对' : `${options.modelId ?? selection.modelId ?? '沿服务商默认模型'} · ${options.workingDirectory ?? roots[0] ?? '工作区未指定'} · ${({ archive: '归档', temporary: '临时', ttl: '限时' } as Record<string, string>)[String(valueObject(conversation.retention).mode)] ?? ''}`,
                action: () => this.openConversation(String(conversation.conversationId)) };
        });
        if (page.nextCursor) items.push({ label: '下一页', action: () => this.listConversations(String(page.nextCursor)) });
        if (this.projectConversationsOnly) items.push({ label: '查看所有项目的对话', action: async () => { this.projectConversationsOnly = false; await this.listConversations(); } });
        items.push({ label: this.conversation ? '返回当前对话' : '返回项目', action: () => { if (this.conversation) this.menu = undefined; else this.showStartup(); } });
        this.menu = { title: this.projectConversationsOnly ? this.project.name + ' · 对话' : '所有项目的对话', index: 0, items, back: () => { if (!this.conversation) this.showStartup(); } };
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
        this.restoreSelection(result.data);
        this.usageOverview = undefined; this.usageLoadedAt = 0;
        if (!preserveDetails) {
            this.transcript = []; this.transcriptFollow = true;
            this.details = conversationSummary(result.data) ?? [];
            this.detailsOffset = 0; this.detailCache = undefined;
        }
        this.form = undefined; this.commandDraft = undefined;
        this.run = result.data.run ? valueObject(result.data.run) : undefined;
        this.outputText = '';
        this.partialAnswer = undefined; this.partialVisible = false; this.partialFollow = true;
        this.modelContentReads.clear(); this.lastFormalAnswer = undefined;
        this.failureKey = undefined; this.failureDetails = [];
        this.historyCursor = undefined;
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
        if (!preserveDetails && Number(result.data.appendSeq) > 0) await this.restoreTranscript(conversationId, viewEpoch);
        if (viewEpoch !== this.viewEpoch || this.disposed) return;
        const monitor = new ConversationMonitor(this.client, conversationId, {
            snapshot: async snapshot => {
                if (viewEpoch !== this.viewEpoch || this.disposed) return;
                this.conversation = snapshot;
                this.restoreSelection(snapshot);
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
        this.log('已打开「' + String(valueObject(result.data.options).title || '未命名对话') + '」');
        void this.refreshUsage(true);
        this.updateState();
    }

    private restoreSelection(conversation: Record<string, unknown>): void {
        const options = valueObject(conversation.options);
        this.project = projectFromOptions(options, this.streams.cwd ?? process.cwd());
        const selection = valueObject(options.modelSelection);
        this.selectedProfile = typeof options.profileId === 'string' ? options.profileId : typeof selection.profileId === 'string' ? selection.profileId : undefined;
        this.selectedModel = typeof options.modelId === 'string' ? options.modelId : typeof selection.modelId === 'string' ? selection.modelId : undefined;
        this.selectedProfileLabel = undefined;
    }

    private async restoreTranscript(conversationId: string, viewEpoch = this.viewEpoch, cursor?: string): Promise<void> {
        const sections: { seq: number; role: string; text: string }[] = [];
        let nextCursor = cursor;
        let hasMore = false;
        let artifactReads = 0;
        let artifactBytes = TRANSCRIPT_HISTORY_LIMITS.artifactBytes;
        let omitted = 0;
        const seenCursors = new Set<string>();
        for (let pageIndex = 0; pageIndex < TRANSCRIPT_HISTORY_LIMITS.pages; pageIndex += 1) {
            const result = await this.client.request<Record<string, unknown>>('conversations.readHistory', { conversationId, direction: 'backward', limit: TRANSCRIPT_HISTORY_LIMITS.itemsPerPage, maxBytes: TRANSCRIPT_HISTORY_LIMITS.pageBytes, ...(nextCursor ? { cursor: nextCursor } : {}) });
            if (viewEpoch !== this.viewEpoch || this.disposed || this.conversation?.conversationId !== conversationId) return;
            if (!result.ok || !result.data) { this.showError(result, false); return; }
            const page = result.data;
            for (const item of rows(page)) {
                if (!['user', 'assistant'].includes(String(item.role))) continue;
                let entry = item;
                if (item.value === undefined && typeof item.contentId === 'string') {
                    const bytes = Number(valueObject(item.objectRef).rawBytes);
                    if (!Number.isFinite(bytes) || bytes < 1 || bytes > artifactBytes || bytes > TRANSCRIPT_HISTORY_LIMITS.artifactItemBytes || artifactReads >= TRANSCRIPT_HISTORY_LIMITS.artifactReads || !this.client.readArtifact) { omitted += 1; continue; }
                    artifactReads += 1; artifactBytes -= bytes;
                    const artifact = await this.client.readArtifact(conversationId, item.contentId, { maxTotalBytes: bytes });
                    if (viewEpoch !== this.viewEpoch || this.disposed || this.conversation?.conversationId !== conversationId) return;
                    if (!artifact.ok || !artifact.data) { omitted += 1; continue; }
                    entry = { ...item, value: decodeArtifactJson(artifact.data) };
                }
                const text = historyMessage(entry);
                if (text) sections.push({ seq: Number(item.seq) || 0, role: String(item.role), text });
            }
            hasMore = page.hasMore === true;
            const previousCursor = nextCursor;
            nextCursor = hasMore && typeof page.nextCursor === 'string' ? page.nextCursor : undefined;
            if (!nextCursor || nextCursor === previousCursor || seenCursors.has(nextCursor)) break;
            seenCursors.add(nextCursor);
            if (sections.some(section => section.role === 'user') && sections.some(section => section.role === 'assistant')) break;
        }
        this.historyCursor = nextCursor;
        if (sections.length) await this.printTranscript(sections.sort((left, right) => left.seq - right.seq).map(section => section.text).join('\n\n'), true);
        if (omitted || hasMore) this.log(`${omitted ? omitted + '条原文受本次读取预算限制 · ' : ''}${hasMore ? '当前显示最近可用正文，/history读取更早记录' : '/history查看原文页'}`);
    }

    private async refreshUsage(force = false): Promise<void> {
        if (this.disposed || this.usageRequest || !force && Date.now() - this.usageLoadedAt < 10_000) return;
        const conversationId = this.conversation?.conversationId;
        const profileId = this.selectedProfile;
        const scope = JSON.stringify([conversationId, profileId]); this.usageScope = scope;
        this.usageRequest = (async () => {
            try {
                const result = await this.client.request<UsageOverview>('usage.overview', { ...(conversationId ? { conversationId } : {}), ...(profileId ? { profileId } : {}) });
                if (this.disposed || scope !== JSON.stringify([this.conversation?.conversationId, this.selectedProfile])) return;
                this.usageLoadedAt = Date.now();
                if (result.ok && result.data?.account && result.data?.conversation && result.data?.providerUsage) { this.usageOverview = result.data; this.usageState = ''; }
                else { this.usageOverview = undefined; this.usageState = '用量暂不可用 · ' + (result.error?.code ?? '核心尚未返回统计'); }
            } catch {
                if (scope === JSON.stringify([this.conversation?.conversationId, this.selectedProfile])) { this.usageOverview = undefined; this.usageState = '用量暂不可用 · 连接恢复后再取'; }
            }
            finally { this.usageRequest = undefined; this.scheduleRender(); }
        })();
        await this.usageRequest;
        if (!this.disposed && this.usageScope !== JSON.stringify([this.conversation?.conversationId, this.selectedProfile])) void this.refreshUsage(true);
    }

    private async listProfiles(cursor?: string): Promise<void> {
        if (!METHOD_SPECS['profiles.list']) { this.showError({ ok: false, error: { code: 'METHOD_NOT_AVAILABLE', message: '服务商配置能力尚未安装', retryable: false, mayHaveStarted: false } }); return; }
        const result = await this.client.request('profiles.list', { limit: 20, ...(cursor ? { cursor } : {}) });
        if (!result.ok) { this.showError(result); return; }
        const choosing = this.selectionTarget === 'new' || this.modelSetting !== undefined || this.selectingModel;
        const profiles = rows(result.data).map(value => valueObject(value.profile ?? value));
        const items: MenuItem[] = groupProviderProfiles(profiles).map(group => ({ label: group.label, detail: `${protocolLabel(group.protocol)} · ${group.profiles.length}个Key配置`, action: () => this.listProviderKeys(group) }));
        items.push({ label: '添加服务商/API', action: () => this.addProfile() });
        const page = valueObject(result.data);
        if (page.nextCursor) items.push({ label: '下一页服务商', action: () => this.listProfiles(String(page.nextCursor)) });
        items.push({ label: choosing && this.creation ? '取消新建，返回项目' : '返回', action: () => {
            if (this.creation) { this.creation = undefined; this.setupContinuation = undefined; this.selectionTarget = 'conversation'; this.modelSetting = undefined; }
            if (!this.conversation) this.showStartup();
        } });
        this.menu = { title: choosing ? '选择API服务商' : 'API与Key管理', index: 0, items, back: () => this.creation ? this.conversationModeMenu() : this.conversation ? this.settingsMenu() : this.showStartup() };
    }

    private async listProviderKeys(group: CliProviderGroup): Promise<void> {
        this.providerGroup = group;
        const choosing = this.selectionTarget === 'new' || this.modelSetting !== undefined || this.selectingModel;
        const items: MenuItem[] = group.profiles.map(profile => ({ label: String(profile.label ?? '未命名Key'), detail: profile.credentialRef ? 'Key已保存 · ********' : '需要填写Key', action: () => {
            if (choosing) return this.chooseProfile(profile);
            this.profileMenu(profile);
        } }));
        items.push({ label: '新增一个Key配置', detail: '用名称区分用途，已有Key保持原样', action: () => this.profileForm({ label: group.label, protocol: group.protocol, url: group.baseUrl }) });
        items.push({ label: '返回服务商', action: () => this.listProfiles() });
        this.menu = { title: `${group.label} · ${choosing ? '选择API Key' : '管理Key'}`, index: 0, context: [group.baseUrl || protocolLabel(group.protocol)], items, back: () => this.listProfiles() };
        this.scheduleRender();
    }

    private addProfile(): void {
        const presets = [
            { label: 'DeepSeek', protocol: 'compatible_chat', url: 'https://api.deepseek.com' },
            { label: 'OpenAI', protocol: 'openai_responses', url: 'https://api.openai.com/v1' },
            { label: 'Anthropic', protocol: 'anthropic', url: 'https://api.anthropic.com/v1' },
            { label: 'Gemini', protocol: 'gemini', url: 'https://generativelanguage.googleapis.com/v1beta' },
            { label: '其他兼容服务', protocol: 'compatible_chat', url: '' },
        ];
        this.menu = { title: '新增服务商 · 先选连接类型', index: 0, items: presets.map(preset => ({ label: preset.label, detail: preset.url || '填写自己的API地址', action: () => this.profileForm(preset) })) };
    }

    private profileForm(preset: { label: string; protocol: string; url: string }, profile?: Record<string, unknown>): void {
        this.openForm('添加服务商/API（保存不发送模型请求）', [
            { key: 'label', label: '这个Key的名称或用途', defaultValue: String(profile?.label ?? preset.label), required: true },
            { key: 'url', label: 'API地址', defaultValue: String(profile?.baseUrl ?? preset.url), required: true, validate: text => { try { return ['http:', 'https:'].includes(new URL(text).protocol) ? undefined : '地址需以https://或http://开头'; } catch { return '请填写完整API地址'; } } },
        ], async values => {
            const args = profile ? ['profile', 'edit', String(profile.profileId), '--label', values.label, '--base-url', values.url, '--revision', String(profile.revision)]
                : ['profile', 'add', '--label', values.label, '--protocol', preset.protocol, '--base-url', values.url];
            const execution = await this.perform(args);
            if (execution?.result.ok) {
                const saved = valueObject(valueObject(execution.result.data).profile ?? execution.result.data);
                if (profile) this.profileMenu(saved);
                else this.keyForm(saved, () => this.chooseProfile(saved));
            }
        });
    }

    private profileMenu(profile: Record<string, unknown>): void {
        const profileId = String(profile.profileId);
        this.menu = { title: String(profile.label ?? profileId), index: 0, items: [
            { label: '为当前对话选择模型', action: () => this.chooseProfile(profile) },
            { label: '编辑名称与API地址', action: () => this.profileForm({ label: String(profile.label), protocol: String(profile.protocol), url: String(profile.baseUrl) }, profile) },
            { label: '来源、用途与备注（可选）', detail: String(valueObject(profile.information).purpose ?? '保存这份Key配置的说明'), action: () => this.profileInformationForm(profile) },
            { label: '停止新请求的条件（可选）', detail: valueObject(profile.dispatchPolicy).enabled === false ? '当前已停发新请求' : '日期与累计费用均可留空', action: () => this.profileDispatchPolicyForm(profile) },
            { label: profile.credentialRef ? '更新/轮换Key · 全程遮挡' : '填写Key · 全程遮挡', action: () => this.keyForm(profile) },
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
            ...(this.profileCatalogRefreshes.has(profileId) ? [{ label: '查看上次保存后的模型目录刷新详情', action: async () => {
                const refresh = this.profileCatalogRefreshes.get(profileId)!;
                const result = valueObject(refresh.result);
                if (valueObject(result.error).mayHaveStarted && typeof refresh.clientCommandId === 'string') {
                    const receipt = await this.client.getReceipt(refresh.clientCommandId);
                    const original = valueObject(receipt.data).result;
                    if (original && typeof valueObject(original).ok === 'boolean') refresh.result = original;
                }
                this.details = humanJson(refresh).split('\n'); this.detailsOffset = 0;
            } }] : []),
            { label: '刷新模型目录（明确联网）', action: async () => { await this.perform(['model', 'refresh', '--profile', profileId]); await this.listModels(profileId); } },
            { label: '返回服务商列表', action: () => this.listProfiles() },
        ] };
    }

    private async saveProfileDetails(profile: Record<string, unknown>, patch: Record<string, unknown>): Promise<void> {
        const read = await this.client.request<Record<string, unknown>>('profiles.get', { profileId: profile.profileId });
        if (!read.ok || !read.data) { this.showError(read); return; }
        const current = valueObject(read.data.profile ?? read.data);
        for (const key of Object.keys(patch)) {
            if (current.revision !== profile.revision && canonicalJson(current[key] ?? null) !== canonicalJson(profile[key] ?? null)) {
                this.showError({ ok: false, error: { code: 'PROFILE_CHANGED', message: '这部分配置已在其它入口更新，请重新打开后核对再保存', retryable: false, mayHaveStarted: false } }); return;
            }
        }
        const result = await this.perform(['profile', 'put', '--params', JSON.stringify({ profile: { ...current, ...patch }, expectedRevision: current.revision })]);
        if (result?.result.ok) {
            const data = valueObject(result.result.data);
            this.profileMenu(valueObject(data.profile ?? { ...current, ...patch }));
        }
    }

    private profileInformationForm(profile: Record<string, unknown>): void {
        const information = valueObject(profile.information);
        this.openForm('这份Key配置的说明 · 全部可选', [
            { key: 'source', label: '来源 · 例如官方申请或资料链接', defaultValue: String(information.source ?? '') },
            { key: 'purpose', label: '用途', defaultValue: String(information.purpose ?? '') },
            { key: 'notes', label: '备注 · Ctrl+J可换行', defaultValue: String(information.notes ?? ''), preserveWhitespace: true },
            { key: 'tested', label: '手工记录的核验时间 · 本机时间，如2026-11-20 18:00，可留空', defaultValue: String(information.lastTestedAt ?? ''), validate: text => { try { optionalDateTime(text); return undefined; } catch (error) { return error instanceof Error ? error.message : '请核对时间'; } } },
        ], async values => {
            const next: Record<string, unknown> = { updatedAt: new Date().toISOString() };
            for (const key of ['source', 'purpose', 'notes']) if (values[key]) next[key] = values[key];
            next.lastTestedAt = optionalDateTime(values.tested);
            await this.saveProfileDetails(profile, { information: next });
        }, () => this.profileMenu(profile));
    }

    private profileDispatchPolicyForm(profile: Record<string, unknown>): void {
        const policy = valueObject(profile.dispatchPolicy);
        const cost = valueObject(policy.maxCumulativeCost);
        this.openForm('停止新请求的条件 · 留空即不设置该项', [
            { key: 'enabled', label: '是否允许发送新请求', choices: ['启用', '停发'], defaultValue: policy.enabled === false ? '停发' : '启用', required: true },
            { key: 'expires', label: '停止发送时间 · 本机时间，如2026-11-20 18:00，留空不限', defaultValue: String(policy.expiresAt ?? ''), validate: text => { try { optionalDateTime(text); return undefined; } catch (error) { return error instanceof Error ? error.message : '请核对时间'; } } },
            { key: 'cost', label: '累计费用停止额 · 币种单位，留空不设置', defaultValue: typeof cost.amountMicros === 'number' ? String(cost.amountMicros / 1_000_000) : '', validate: text => { try { if (text) amountMicros(text); return undefined; } catch (error) { return error instanceof Error ? error.message : '请核对金额'; } } },
            { key: 'currency', label: '累计费用币种 · 设置金额时使用，例如USD或CNY', defaultValue: String(cost.currency ?? 'USD'), validate: (text, values) => values.cost && !/^[A-Za-z]{3}$/.test(text) ? '请填写三字母币种' : undefined },
        ], async values => {
            const dispatchPolicy = { enabled: values.enabled === '启用', expiresAt: optionalDateTime(values.expires),
                ...(values.cost ? { maxCumulativeCost: { currency: values.currency.toUpperCase(), amountMicros: amountMicros(values.cost) } } : {}) };
            await this.saveProfileDetails(profile, { dispatchPolicy });
        }, () => this.profileMenu(profile));
    }

    private async chooseProfile(profile: Record<string, unknown>): Promise<void> {
        const latest = await this.client.request<Record<string, unknown>>('profiles.get', { profileId: profile.profileId });
        if (!latest.ok || !latest.data) { this.showError(latest); return; }
        const current = valueObject(latest.data.profile ?? latest.data);
        if (!current.credentialRef && current.protocol !== 'progrok') { this.keyForm(current, () => this.listModels(String(current.profileId))); return; }
        await this.listModels(String(current.profileId));
    }

    private keyForm(profile: Record<string, unknown>, after?: () => Promise<void>): void {
        const profileId = String(profile.profileId);
        const pending = this.pendingSecrets.get(profileId);
        if (pending) {
            this.menu = { title: '原Key保存结果待确认', index: 0, items: [{ label: '只查询原保存回执', action: async () => {
                const receipt = await this.client.getReceipt(pending);
                const original = valueObject(receipt.data).result as RpcResult | undefined;
                if (!original || typeof original.ok !== 'boolean') { this.log('原保存仍待确认，未重新提交Key'); this.keyForm(profile, after); return; }
                this.pendingSecrets.delete(profileId);
                if (!original.ok) { this.log('原Key保存失败，可重新填写'); this.keyForm(profile, after); return; }
                this.busy = true;
                try {
                    const restored = await refreshSavedProfileCatalog(this.client, original);
                    this.rememberProfileCatalog(restored);
                    for (const line of profileCatalogRefreshLines(restored.data)) this.log(line);
                } finally { this.busy = false; }
                if (after) await after(); else await this.listProfiles();
            } }, { label: '返回聊天，稍后再查', action: () => {} }] };
            return;
        }
        this.openForm(profile.credentialRef ? '轮换API Key · 旧Key在确认前保持有效' : '填写API Key', [
            { key: 'secret', label: 'API Key（遮挡输入，Enter保存）', hidden: true, sensitive: true, required: true },
        ], async values => {
            if (this.observing) { this.log('只读观察模式下保持原Key'); return; }
            if (this.busy) { this.log('原命令仍在等待，稍后再保存Key'); return; }
            const commandId = randomUUID(); this.pendingSecrets.set(profileId, commandId);
            this.busy = true;
            let result: RpcResult;
            try {
                result = await this.client.request(profile.credentialRef ? 'profiles.rotateSecret' : 'profiles.setSecret', {
                    profileId, expectedRevision: profile.revision, secret: values.secret,
                }, { clientCommandId: commandId });
            } catch {
                result = { ok: false, error: { code: 'RECEIPT_UNKNOWN', message: '原Key保存结果待确认', mayHaveStarted: true, retryable: true } };
            } finally { values.secret = ''; }
            if (!result.error?.mayHaveStarted) this.pendingSecrets.delete(profileId);
            if (!result.ok) {
                this.busy = false;
                this.status = result.error?.message ?? 'Key保存未完成，请检查后重试';
                this.log('Key保存未完成 · ' + (result.error?.code ?? '连接中断'));
                if (result.error?.mayHaveStarted) this.keyForm(profile, after);
                else await this.listProfiles();
                return;
            }
            this.pendingSecrets.delete(profileId);
            this.status = 'Key已保存，可以选择模型';
            this.log('Key已保存 · ********');
            try {
                const refreshed = await refreshSavedProfileCatalog(this.client, result);
                this.rememberProfileCatalog(refreshed);
                for (const line of profileCatalogRefreshLines(refreshed.data)) this.log(line);
            } finally { this.busy = false; }
            if (after) await after(); else await this.listProfiles();
        });
    }

    private async listModels(profileId = this.selectedProfile, cursor?: string): Promise<void> {
        if (!profileId) { await this.listProfiles(); return; }
        const result = await this.client.request('models.list', { profileId, limit: 20, ...(cursor ? { cursor } : {}) });
        if (!result.ok) { this.showError(result); return; }
        const page = valueObject(result.data);
        const catalog = valueObject(page.catalog);
        const freshness = String(catalog.freshness ?? page.freshness ?? (!page.catalogVersion && !rows(page).length ? 'missing' : 'unknown'));
        const refreshKey = profileId;
        if (!cursor && ['missing', 'expired', 'future'].includes(freshness) && !this.catalogAutoRefreshes.has(refreshKey)) {
            this.catalogAutoRefreshes.add(refreshKey);
            if (this.catalogAutoRefreshes.size > 100) this.catalogAutoRefreshes.delete(this.catalogAutoRefreshes.values().next().value!);
            const refreshed = await this.perform(['model', 'refresh', '--profile', profileId]);
            if (refreshed?.result.ok) { await this.listModels(profileId); return; }
        }
        const items: MenuItem[] = rows(page).filter(model => model.retired !== true).map(model => ({ label: String(model.displayName ?? model.modelId), detail: `${model.modelId} · ${modelToolSupport(model).label}`, action: () => {
            if (this.creation) return this.selectModel(profileId, String(model.modelId));
            this.menu = { title: '确认模型选择', index: 0, context: [String(model.displayName ?? model.modelId), modelToolSupport(model).label, this.modelSetting === 'compression' ? '用于整理上下文，主模型保持原样' : this.selectionTarget === 'new' ? '用于待创建的新对话' : '仅改变当前对话后续请求'], items: [
                { label: '确认使用', action: () => this.selectModel(profileId, String(model.modelId)) },
                { label: '返回列表', action: () => this.listModels(profileId) },
            ] };
        } }));
        if (page.nextCursor) items.push({ label: '下一页模型', action: () => this.listModels(profileId, String(page.nextCursor)) });
        items.push({ label: '联网读取/刷新模型目录', detail: '使用已保存Key查询列表，不发送模型任务', action: async () => { const result = await this.perform(['model', 'refresh', '--profile', profileId]); if (result?.result.ok) await this.listModels(profileId); } });
        items.push({ label: '目录时间与模型能力来源', action: () => {
            this.details = [`目录状态：${({ current: '当前有效', expired: '已过期', future: '记录时间超前', missing: '尚无目录', unknown: '时间信息不完整' } as Record<string, string>)[freshness] ?? freshness}`,
                `获取时间：${localTime(catalog.observedAt)}`, `有效期：${localTime(catalog.expiresAt)}`,
                ...rows(page).flatMap(model => [String(model.displayName ?? model.modelId) + (model.retired ? '（已退役）' : ''),
                    ...['contextWindow', 'maxOutputTokens', 'pricing', 'tools', 'streaming'].flatMap(name => { const evidence = valueObject(model[name]); return Object.keys(evidence).length ? [`${name}：${evidence.status ?? '未知'} · ${evidence.source ?? '来源未记录'} · ${evidence.sourceRef ?? ''} · ${localTime(evidence.observedAt)}`] : []; })])];
            this.detailsOffset = 0; this.detailCache = undefined;
        } });
        items.push({ label: '手工输入精确模型ID', action: () => this.openForm('选择模型', [{ key: 'model', label: '精确模型ID', required: true }], async values => {
            await this.selectModel(profileId, values.model);
        }) });
        this.menu = { title: this.modelSetting === 'compression' ? '选择压缩模型' : '选择主模型', index: 0,
            context: [({ current: '目录当前有效', expired: '目录已过期，可刷新后继续', future: '目录时间超前，请核对', missing: '正在准备模型目录', unknown: '目录时间可在详情查看' } as Record<string, string>)[freshness] ?? freshness],
            items, back: () => this.creation && this.newSelection.modelId ? this.creationMenu() : this.providerGroup ? this.listProviderKeys(this.providerGroup) : this.listProfiles() };
    }

    private async selectModel(profileId: string, modelId: string): Promise<void> {
        const read = await this.client.request<Record<string, unknown>>('profiles.get', { profileId });
        if (!read.ok || !read.data) { this.showError(read); return; }
        const profile = valueObject(read.data.profile ?? read.data);
        const policy = valueObject(profile.routePolicy);
        const allowed = Array.isArray(policy.allowedModels) ? policy.allowedModels as string[] : [];
        const patch: Record<string, unknown> = this.creation || this.conversationCompression && this.modelSetting === 'compression' ? {} : this.modelSetting === 'compression' ? { compressionModelRef: modelId }
            : this.modelSetting === 'default' || !profile.defaultModel ? { defaultModel: modelId } : {};
        if (!allowed.includes(modelId)) patch.routePolicy = { ...policy, allowedModels: [...allowed, modelId], version: randomUUID() };
        if (Object.keys(patch).length) {
            const applied = await this.perform(['profile', 'put', '--params', JSON.stringify({ profile: { ...profile, ...patch }, expectedRevision: profile.revision })]);
            if (!applied?.result.ok) return;
        }
        if (this.creation && this.modelSetting === 'compression') {
            this.creation.compression = { profileId, modelId }; this.modelSetting = undefined;
            await this.creationMenu(); return;
        }
        if (this.conversationCompression && this.modelSetting === 'compression' && this.conversation) {
            if (!await this.updateConversationOptions({ compressionModelSelection: { profileId, modelId } })) return;
            this.conversationCompression = false; this.modelSetting = undefined; this.settingsMenu(); return;
        }
        if (this.modelSetting) { this.log(this.modelSetting === 'compression' ? '压缩模型已保存' : '服务商默认模型已保存'); this.modelSetting = undefined; this.settingsMenu(); return; }
        if (this.selectionTarget === 'new') {
            if (this.creation && (this.newSelection.profileId !== profileId || this.newSelection.modelId !== modelId)) this.creation.parameters = {};
            this.newSelection = { profileId, modelId };
            if (this.setupContinuation) await this.setupContinuation();
            return;
        }
        if (this.conversation) {
            const applied = await this.perform(['model', 'set', '--profile', profileId, '--model', modelId, '--revision', String(this.conversation.revision), '--params', JSON.stringify({ options: valueObject(this.conversation.options) })]);
            if (!applied?.result.ok) return;
            const snapshot = await this.client.request<Record<string, unknown>>('conversations.get', { conversationId: this.conversation.conversationId });
            if (snapshot.ok && snapshot.data) this.conversation = snapshot.data;
        }
        this.selectedProfile = profileId; this.selectedModel = modelId; this.selectingModel = false;
        this.selectedProfileLabel = String(profile.label ?? '服务商');
        this.usageOverview = undefined; this.usageLoadedAt = 0; void this.refreshUsage(true);
        this.log('已选择模型 ' + modelId); this.menu = undefined;
    }

    private modelMenu(): void {
        if (!this.conversation) { if (this.creation) void this.creationMenu(); else this.conversationModeMenu(); return; }
        this.selectionTarget = 'conversation'; this.modelSetting = undefined; this.selectingModel = false; this.conversationCompression = false;
        this.menu = { title: '当前对话 · 模型与参数', index: 0, items: [
            { label: '选择服务商与模型', action: async () => { this.selectingModel = true; await this.listProfiles(); } },
            { label: '本对话模型参数', detail: '推理强度、温度与输出长度；留空沿服务商有效值', action: () => this.parameterForm() },
            { label: '主模型与压缩模型设置', action: () => this.settingsMenu() },
            { label: '用量、缓存率与余额来源', action: async () => { await this.refreshUsage(true); this.details = detailedUsageLines(this.usageOverview, this.usageState); } },
            { label: '返回聊天', action: () => {} },
        ] };
    }

    private settingsMenu(): void {
        if (this.creation) { void this.creationMenu(); return; }
        this.selectionTarget = 'conversation'; this.modelSetting = undefined; this.selectingModel = false; this.conversationCompression = false;
        const menu: Menu = { title: '设置 · 主模型与压缩模型', index: 0, context: [`当前对话主模型：${this.selectedModel ?? '尚未选择'}`, '压缩模型按服务商设置保存；留空沿核心已定选择规则'], items: [
            { label: '切换当前对话主模型', action: async () => { this.selectingModel = true; await this.listProfiles(); } },
            { label: '服务商默认主模型', action: async () => { this.modelSetting = 'default'; await this.listProfiles(); } },
            { label: '本对话压缩模型', detail: '只修改当前对话，服务商默认值保持原样', action: async () => { this.modelSetting = 'compression'; this.conversationCompression = true; await this.listModels(this.selectedProfile); } },
            { label: '本对话压缩模型参数', action: () => this.parameterForm('compression') },
            { label: '当前对话参数', action: () => this.parameterForm() },
            { label: '服务商、API地址与遮挡Key', action: () => this.listProfiles() },
            { label: '终端、换行与动画', action: () => this.executeLine('/terminal show') },
        ] };
        this.menu = menu;
        if (this.selectedProfile) void this.client.request<Record<string, unknown>>('profiles.get', { profileId: this.selectedProfile }).then(result => {
            if (this.menu !== menu || !result.ok || !result.data) return;
            const profile = valueObject(result.data.profile ?? result.data);
            const options = valueObject(this.conversation?.options);
            const compression = valueObject(options.compressionModelSelection).modelId ?? valueObject(options.compressionModel).modelId ?? (typeof options.compressionModel === 'string' ? options.compressionModel : undefined);
            menu.context = [`当前主模型：${this.selectedModel ?? '未选择'}`, `默认主模型：${profile.defaultModel ?? '未指定'}`, `本对话压缩模型：${compression ?? profile.compressionModelRef ?? this.selectedModel ?? '沿核心选择规则'}`]; this.scheduleRender();
        }).catch(() => {});
    }

    private async parameterForm(target: 'main' | 'compression' = 'main'): Promise<void> {
        const creation = this.creation;
        let profileId = creation ? this.newSelection.profileId : this.selectedProfile;
        let modelId = creation ? this.newSelection.modelId : this.selectedModel;
        if (!profileId || !modelId) { this.log('选择主模型后即可调整它支持的参数'); return; }
        const options = valueObject(this.conversation?.options);
        let configured: Record<string, unknown> = {};
        if (target === 'compression') {
            configured = creation ? valueObject(creation.compression) : valueObject(options.compressionModelSelection ?? options.compressionModel);
            const read = await this.client.request<Record<string, unknown>>('profiles.get', { profileId });
            if (!read.ok) { this.showError(read); return; }
            const profile = valueObject(read.data?.profile ?? read.data);
            profileId = typeof configured.profileId === 'string' ? configured.profileId : profileId;
            modelId = typeof configured.modelId === 'string' ? configured.modelId : creation?.compression === null ? modelId
                : !creation && typeof options.compressionModel === 'string' ? options.compressionModel
                : typeof profile.compressionModelRef === 'string' ? profile.compressionModelRef : modelId;
        }
        const result = await this.client.request<Record<string, unknown>>('models.get', { profileId, modelId });
        if (!result.ok || !result.data) { this.showError(result); return; }
        const entry = valueObject(result.data.entry ?? result.data);
        const inherited = profileId === (creation ? this.newSelection.profileId : this.selectedProfile) && modelId === (creation ? this.newSelection.modelId : this.selectedModel)
            ? creation?.parameters ?? valueObject(options.parameters) : {};
        const current = target === 'compression' ? { ...inherited, ...valueObject(configured.parameters) } : creation?.parameters ?? valueObject(options.parameters);
        if (target === 'compression') {
            if (typeof configured.maxOutputTokens === 'number') current.maxOutputTokens = configured.maxOutputTokens;
            else delete current.maxOutputTokens;
        }
        const fields: Field[] = declaredParameterFields(entry, current);
        if (target === 'compression') { const output = fields.find(field => field.key === 'maxOutputTokens'); if (output) output.label = output.label.replace(/留空[^）]+/, '留空沿核心默认上限'); }
        if (!fields.length) { this.log('当前模型没有可编辑的有效参数声明，沿用默认设置'); if (creation) await this.creationMenu(); return; }
        this.openForm(target === 'compression' ? '本对话压缩模型参数' : '当前主模型参数', fields, async values => {
            const parameters = readParameterValues(entry, values, current);
            const compressionModelSelection = { profileId: profileId!, modelId: modelId!, parameters,
                ...(typeof parameters.maxOutputTokens === 'number' ? { maxOutputTokens: parameters.maxOutputTokens } : {}) };
            if (creation && this.creation === creation) {
                if (target === 'compression') creation.compression = compressionModelSelection;
                else creation.parameters = parameters;
                await this.creationMenu();
            } else await this.updateConversationOptions(target === 'compression' ? { compressionModelSelection } : { parameters });
        }, () => creation ? this.creationMenu() : this.settingsMenu());
    }

    private workspacePath(): string {
        const options = valueObject(this.conversation?.options);
        return typeof options.workingDirectory === 'string' ? options.workingDirectory
            : Array.isArray(options.writeRoots) && typeof options.writeRoots[0] === 'string' ? options.writeRoots[0] : this.creation?.roots[0] ?? this.project.roots[0];
    }

    private async updateConversationOptions(patch: Record<string, unknown>): Promise<boolean> {
        if (!this.conversation || this.observing) { this.log('先打开可控制的对话'); return false; }
        const options = { ...valueObject(this.conversation.options), ...patch };
        const execution = await this.perform(['conversation', 'update', '--revision', String(this.conversation.revision), '--params', JSON.stringify({ options })]);
        if (!execution?.result.ok) return false;
        const snapshot = await this.client.request<Record<string, unknown>>('conversations.get', { conversationId: this.conversation.conversationId });
        if (snapshot.ok && snapshot.data) { this.conversation = snapshot.data; this.restoreSelection(snapshot.data); }
        if ('workingDirectory' in patch || 'writeRoots' in patch) {
            this.details = workspaceUpdateLines(valueObject(this.conversation?.options ?? options)); this.detailsOffset = 0; this.detailCache = undefined;
        }
        this.log('对话设置已保存，从后续请求生效'); return true;
    }

    private async workspaceMenu(): Promise<void> {
        if (!this.conversation) { await this.selectProjectDirectory(); return; }
        const options = valueObject(this.conversation.options);
        const roots = Array.isArray(options.writeRoots) ? options.writeRoots.map(String) : [];
        this.menu = { title: '工作区与允许写入的目录', index: 0, context: [`工作目录：${this.workspacePath()}`, ...roots.map(root => '可写：' + root)], items: [
            { label: '选择工作目录', detail: '选中后预览，确认才保存', action: () => this.browseDirectory(this.workspacePath(), async path => {
                this.menu = { title: '确认工作区与写入范围', index: 0, context: ['工作目录：' + path, '可写：' + [path, ...roots.filter(root => root !== path)].join('；')], items: [
                    { label: '确认使用', action: async () => { await this.updateConversationOptions({ workingDirectory: path, writeRoots: [path, ...roots.filter(root => root !== path)] }); } },
                    { label: '返回，保持原范围', action: () => this.workspaceMenu() },
                ] };
            }) },
            { label: '添加允许写入的目录', action: () => this.browseDirectory(this.workspacePath(), async path => {
                this.menu = { title: '确认新增可写目录', index: 0, context: ['新增可写：' + path, '原有目录：' + roots.join('；')], items: [
                    { label: '确认添加', action: async () => { await this.updateConversationOptions({ writeRoots: [...new Set([...roots, path])] }); } },
                    { label: '取消', action: () => this.workspaceMenu() },
                ] };
            }) },
            ...roots.map(root => ({ label: '移除可写目录：' + root, action: async () => { await this.updateConversationOptions({ writeRoots: roots.filter(value => value !== root) }); } })),
            { label: '返回聊天', action: () => {} },
        ] };
    }

    private async browseDirectory(directory: string, selected: (path: string) => Promise<void>, files = false, offset = 0): Promise<void> {
        let page: Awaited<ReturnType<typeof directoryPage>>;
        try { page = await directoryPage(directory, offset); }
        catch { this.openForm('打开目录', [{ key: 'path', label: '目录路径 · Tab补全', defaultValue: directory, required: true }], async values => { await this.browseDirectory(values.path, selected, files); }); return; }
        const items: MenuItem[] = [];
        if (!files) items.push({ label: '打开系统文件夹选择器…', detail: 'Windows原生窗口；取消后返回这里，原草稿保留', action: () => this.openFolderPicker(page.path, selected, () => this.browseDirectory(page.path, selected, files, offset)) });
        if (!files && this.pickerFailure) items.push({ label: '查看上次系统选择器退出详情', action: () => { this.details = [this.pickerFailure!.message,
            ...humanJson(this.pickerFailure!.details).split('\n'), '产品未设置自动关闭计时；取消只响应明确按键或前台关闭']; this.detailsOffset = 0; this.detailCache = undefined; } });
        if (!files) items.push({ label: '使用此目录', detail: page.path, action: () => selected(page.path) });
        items.push({ label: '手动输入路径 · Tab补全', action: () => this.openForm('目录路径', [{ key: 'path', label: '目录路径 · Tab补全', defaultValue: page.path, required: true }], async values => { await this.browseDirectory(values.path, selected, files); }) });
        if (dirname(page.path) !== page.path) items.push({ label: '.. 上一级', action: () => this.browseDirectory(dirname(page.path), selected, files) });
        for (const entry of page.entries) {
            if (entry.directory) items.push({ label: '[目录] ' + entry.name, action: () => this.browseDirectory(entry.path, selected, files) });
            else if (files) items.push({ label: entry.name, action: () => selected(entry.path) });
        }
        if (page.nextOffset !== undefined) items.push({ label: '下一页', action: () => this.browseDirectory(page.path, selected, files, page.nextOffset) });
        if (offset) items.push({ label: '返回目录首页', action: () => this.browseDirectory(page.path, selected, files) });
        this.menu = { title: files ? '选择引用文件' : '选择文件夹', index: 0, context: [page.path, '仅浏览，确认选择后带回原页面'], items };
        this.scheduleRender();
    }

    private async openFolderPicker(directory: string, selected: (path: string) => Promise<void>, cancelled?: () => Promise<void>): Promise<void> {
        if (this.pickerAbort) return;
        const previousMenu = this.menu;
        const previousForm = this.form;
        const controller = new AbortController(); this.pickerAbort = controller;
        this.log('正在等待系统文件夹选择；取消可返回原页面'); this.scheduleRender();
        try {
            const path = await this.folderPicker(directory, { signal: controller.signal });
            if (this.disposed) return;
            this.pickerFailure = undefined;
            if (path) { this.log('目录已选定，请核对后确认'); await selected(path); }
            else { this.menu = previousMenu; this.form = previousForm; if (cancelled) await cancelled(); this.log('已取消目录选择，原范围与输入草稿保留'); }
        } catch (error) {
            if (error instanceof FolderPickerError) this.pickerFailure = error;
            if (!this.disposed) { this.menu = previousMenu; this.form = previousForm; if (cancelled) await cancelled(); this.log(controller.signal.aborted ? '已取消目录选择，原草稿保留' : error instanceof FolderPickerError ? error.message + '，原目录和草稿保留' : '系统选择器暂不可用，可继续在终端内浏览或补全路径'); }
        } finally { if (this.pickerAbort === controller) this.pickerAbort = undefined; this.scheduleRender(); }
    }

    private async completePath(form: Form): Promise<void> {
        const input = form.draft.text;
        const path = resolve(this.workspacePath(), input || '.');
        const trailing = /[\\/]$/.test(input);
        try {
            const page = await directoryPage(trailing ? path : dirname(path), 0, 500);
            const prefix = trailing ? '' : basename(path).toLowerCase();
            const matches = page.entries.filter(entry => entry.directory && entry.name.toLowerCase().startsWith(prefix));
            if (matches.length === 1) form.draft.replace(matches[0].path + sep);
            else if (matches.length) {
                this.form = undefined;
                this.menu = { title: '路径补全 · 选择后继续输入', index: 0, items: matches.map(entry => ({ label: entry.name, detail: entry.path, action: () => { form.draft.replace(entry.path + sep); this.form = form; } })) };
            } else this.log('当前页没有匹配目录，可填写完整路径后Enter');
        } catch { this.log('该路径暂不可浏览，请检查目录后继续输入'); }
    }

    private async referenceMenu(): Promise<void> {
        this.menu = { title: '添加材料 · 选择后放入草稿，暂不发送', index: 0, items: [
            { label: '工作区文件或图片', action: () => this.browseDirectory(this.workspacePath(), path => this.previewReferenceFile(path), true) },
            { label: '输入文件路径', action: () => this.openForm('引用文件', [{ key: 'path', label: '文件完整路径', required: true }], async values => { await this.previewReferenceFile(resolve(this.workspacePath(), values.path)); }) },
            { label: '引用已有会话', action: () => this.referenceConversations() },
            { label: '返回输入', action: () => {} },
        ] };
    }

    private async previewReferenceFile(path: string, range?: string): Promise<void> {
        const preview = await filePreview(path, range);
        this.menu = { title: '确认引用 · ' + basename(path), index: 0, context: [preview.scope, ...preview.lines], items: [
            { label: '添加到草稿', action: () => {
                const token = `@file:"${path}"${range ? '#' + range.replace(/^#/, '') : ''}`;
                this.draft.insert((this.draft.text && !/\s$/.test(this.draft.text) ? ' ' : '') + token + ' ');
                this.log('文件已放入草稿，尚未发送');
            } },
            { label: '指定行范围', detail: '例如L12-L30，发送前仍会核对原件', action: () => this.openForm('文件引用范围', [{ key: 'range', label: '行范围 · 留空发送整个文件', defaultValue: range }], values => this.previewReferenceFile(path, values.range || undefined)) },
            { label: '返回文件选择', action: () => this.browseDirectory(dirname(path), value => this.previewReferenceFile(value), true) },
        ] };
    }

    private async referenceConversations(cursor?: string): Promise<void> {
        const result = await this.client.request('conversations.list', { limit: 20, ...(cursor ? { cursor } : {}) });
        if (!result.ok) { this.showError(result); return; }
        const page = valueObject(result.data);
        const items: MenuItem[] = rows(page).map(conversation => ({ label: String(valueObject(conversation.options).title || '未命名会话'), detail: String(valueObject(conversation.retention).mode ?? ''), action: () => {
            this.openForm('会话引用范围', [{ key: 'range', label: '轮次 · 例如12-15，留空为整个可读取会话' }], async values => {
                if (values.range && !/^\d+(?:-\d+)?$/.test(values.range)) throw usage('轮次请填写12或12-15');
                const token = `@conversation:agent-server:${conversation.conversationId}${values.range ? '#round=' + values.range : ''}`;
                this.menu = { title: '确认会话引用', index: 0, context: [String(valueObject(conversation.options).title || '未命名会话'), values.range ? '发送轮次：' + values.range : '发送整个可读取会话'], items: [
                    { label: '添加到草稿', action: () => { this.draft.insert((this.draft.text && !/\s$/.test(this.draft.text) ? ' ' : '') + token + ' '); this.log('会话引用已添加，尚未发送'); } },
                    { label: '取消', action: () => {} },
                ] };
            });
        } }));
        if (page.nextCursor) items.push({ label: '下一页会话', action: () => this.referenceConversations(String(page.nextCursor)) });
        items.push({ label: '返回材料选择', action: () => this.referenceMenu() });
        this.menu = { title: '引用会话 · 选择范围后确认', index: 0, items };
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
            const updated = await this.perform(['profile', 'put', '--params', JSON.stringify({ profile: { ...previous, quotaLimitId: values.id }, expectedRevision: previous.revision })]);
            this.log(updated?.result.ok ? '供应商总限额与Profile引用已提交' : '总限额已配置，Profile引用更新失败，请保留原限额ID继续处理');
        });
    }

    private async sendDraft(mode: 'queue' | 'steer' = this.draft.inputMode): Promise<void> {
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
                        if (pending.historyEntry || pending.text !== undefined) { this.history.push(pending.historyEntry ?? { text: pending.text!, conversationId: pending.conversationId }); if (this.history.length > 100) this.history.shift(); }
                    }
                    this.pendingDrafts.delete(pending.conversationId);
                    this.referencePreparations.delete(pending.draft);
                    if (this.conversation?.conversationId === pending.conversationId) this.showResult({ result: original as RpcResult });
                } else this.log('原命令状态仍待确认，本次只查回执，草稿保留');
            } finally { this.busy = false; }
            return;
        }
        if (this.observing) { this.log('当前为只读观察，先用/run control申请控制'); return; }
        if (!this.draft.text.trim() && !this.draft.references.length) return;
        if (!this.conversation) { this.log('草稿已保留，选择对话与模型后即可发送'); if (this.creation) await this.creationMenu(); else this.conversationModeMenu(); return; }
        if (this.run?.kind === 'maintenance' && !terminalRun(this.run)) { this.log('维护中，草稿已保留，维护结束后再次发送'); return; }
        if (this.run?.state === 'outcome_unknown') { this.log('原执行结果仍待核实，草稿已保留，请先查询原动作'); return; }
        const current = this.run && !terminalRun(this.run);
        if (!current && valueObject(this.conversation.options).toolsEnabled !== false && this.selectedProfile && this.selectedModel
            && !await this.requireModelTools(this.selectedProfile, this.selectedModel)) return;
        const draft = this.draft;
        const revision = draft.revision;
        const conversationId = String(this.conversation.conversationId);
        const historyEntry: InputHistoryEntry = { text: draft.text, references: structuredClone(draft.references), inputMode: mode, conversationId };
        const previousPreparation = this.referencePreparations.get(draft);
        const commandId = previousPreparation?.conversationId === conversationId && previousPreparation.revision === revision
            ? previousPreparation.commandId : randomUUID();
        this.referencePreparations.set(draft, { conversationId, revision, commandId });
        const params: Record<string, unknown> = current ? { conversationId, runId: this.run!.runId, expectedRunEpoch: this.run!.runEpoch,
            expectedHistoryEpoch: this.conversation.historyEpoch, mode, draftId: draft.draftId, draftRevision: revision,
            ...(mode === 'steer' ? { targetRoundId: this.run!.activeRoundId } : {}) }
            : { conversationId, ...(this.budget ? { budget: structuredClone(this.budget) } : {}), options: this.selectedModel || this.selectedProfile
                ? { profileId: this.selectedProfile, modelId: this.selectedModel, modelSelection: { profileId: this.selectedProfile, modelId: this.selectedModel } } : {} };
        this.busy = true;
        try {
            const prepared = await prepareCliInputReferences(this.client, { conversationId, text: draft.text, existing: draft.references,
                cwd: this.workspacePath(), commandId });
            const content = { ...prepared, text: prepared.text.startsWith('//') || prepared.text.startsWith('@@') ? prepared.text.slice(1) : prepared.text };
            historyEntry.text = draft.text.startsWith('//') || draft.text.startsWith('@@') ? draft.text[0] + content.text : content.text;
            historyEntry.references = structuredClone(content.references);
            params[current ? 'content' : 'input'] = content;
            this.pendingDrafts.set(conversationId, { commandId, conversationId, revision, draft, text: content.text, historyEntry });
            const result = await this.client.request(current ? 'inputs.submit' : this.budget ? 'runs.start' : 'runs.startInteractive', params, { clientCommandId: commandId });
            if (this.pendingDrafts.get(conversationId)?.commandId !== commandId) return;
            if (result.ok && result.receiptId) {
                this.history.push(historyEntry); if (this.history.length > 100) this.history.shift();
                draft.clearIfAcknowledged(revision); this.pendingDrafts.delete(conversationId);
                this.referencePreparations.delete(draft);
                if (!current && this.conversation?.conversationId === conversationId) {
                    this.run = valueObject(result.data); this.outputText = ''; this.lastOutputRun = undefined;
                    if (this.partialAnswer?.runId !== this.run.runId) { this.partialAnswer = undefined; this.partialVisible = false; }
                    if (this.lastFormalAnswer?.runId !== this.run.runId) this.lastFormalAnswer = undefined;
                }
                if (!current && this.conversation?.conversationId === conversationId) {
                    await this.printTranscript('你：' + content.text);
                    if (this.partialAnswer?.runId === this.run?.runId) this.partialVisible = true;
                }
                this.log(current ? mode === 'steer' ? '补充已送到当前轮' : '已排到下一轮' : '消息已发送');
            } else {
                if (!result.error?.mayHaveStarted) { this.pendingDrafts.delete(conversationId); this.referencePreparations.delete(draft); }
                if (this.conversation?.conversationId === conversationId) this.showError(result);
                else this.log('原会话输入回执待核对：' + conversationId);
            }
            this.updateState();
            void this.refreshUsage(true);
        } finally { this.busy = false; }
    }

    private async executeLine(line: string): Promise<void> {
        const parsed = parseArguments(tokenizeCommand(line));
        const words = parsed.words.map((word, index) => index === 0 ? word.replace(/^\//, '') : word);
        const name = words.join(' ');
        const hasOptions = Object.keys(parsed.options).length > 0;
        if (!hasOptions && ['new', 'session new', 'conversation create'].includes(name)) { this.commandDraft = undefined; this.conversationModeMenu(); return; }
        if (!hasOptions && ['back', 'project', 'close', 'connect', 'models'].includes(name)) {
            this.commandDraft = undefined;
            if (name === 'close') this.sessionNavigationMenu(undefined, true);
            else if (name === 'back' || name === 'project') this.sessionNavigationMenu();
            else if (name === 'models') this.modelMenu();
            else { this.selectingModel = false; this.selectionTarget = 'conversation'; this.modelSetting = undefined; await this.listProfiles(); }
            return;
        }
        if (!hasOptions && name === 'resume') { this.commandDraft = undefined; await this.listConversations(); return; }
        if (!hasOptions && ['settings', 'workspace', 'providers', 'usage', 'references'].includes(name)) {
            this.commandDraft = undefined;
            if (name === 'settings') this.settingsMenu();
            else if (name === 'workspace') await this.workspaceMenu();
            else if (name === 'providers') { this.selectionTarget = 'conversation'; this.modelSetting = undefined; this.selectingModel = false; await this.listProfiles(); }
            else if (name === 'references') await this.referenceMenu();
            else { await this.refreshUsage(true); this.details = detailedUsageLines(this.usageOverview, this.usageState); this.detailsOffset = 0; }
            return;
        }
        if (name === 'history' && !hasOptions && this.conversation) { this.commandDraft = undefined; await this.restoreTranscript(String(this.conversation.conversationId), this.viewEpoch, this.historyCursor); return; }
        parseCommand(parsed);
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
        if (name === 'status') {
            this.commandDraft = undefined;
            if (parsed.options.diagnostics === true) {
                this.menu = undefined; this.partialVisible = false;
                this.details = humanJson({ state: this.status, connection: this.connection, lastOperation: this.lastOperationReceipt,
                    lastSettings: this.conversationUpdateReceipts.get(String(this.conversation?.conversationId)), run: this.run,
                    lastFailure: this.lastFailure, controlEvents: this.controlEvents, messages: this.logs, graphics: this.nativeGraphics?.diagnostics?.() }).split('\n');
                this.detailsOffset = 0; this.detailCache = undefined; return;
            }
            const settings = this.conversationUpdateReceipts.get(String(this.conversation?.conversationId));
            if (settings) {
                const showReceipt = () => { this.menu = undefined; this.partialVisible = false; this.details = humanJson(settings).split('\n'); this.detailsOffset = 0; this.detailCache = undefined; };
                if (parsed.options.json === true) {
                    const run = this.run ? await this.perform(['runs', 'get', String(this.run.runId), '--json']) : undefined;
                    showReceipt();
                    if (run) this.details = humanJson({ lastSettings: settings, run }).split('\n');
                } else this.menu = { title: '状态与设置回执', index: 0, context: [this.status], items: [
                    { label: '最近设置的可读摘要', action: () => { this.menu = undefined; this.details = interactiveResultLines(settings); this.detailsOffset = 0; } },
                    { label: '最近设置的原始回执（JSON详情）', action: showReceipt },
                    ...(this.run ? [{ label: '当前执行状态', action: async () => { await this.perform(['runs', 'get', String(this.run!.runId)]); } }] : []),
                    { label: '返回聊天', action: () => { this.menu = undefined; } },
                ] };
                return;
            }
            if (!this.run && !this.partialAnswer) {
                this.menu = { title: '当前状态与详情', index: 0, context: [this.conversation ? this.observing ? '只读观察' : '已就绪' : '待创建对话'], items: [
                    ...(this.lastOperationReceipt ? [{ label: '最近操作的原始回执', action: () => { this.details = humanJson(this.lastOperationReceipt).split('\n'); this.detailsOffset = 0; this.detailCache = undefined; } }] : []),
                    { label: '连接与控制详情', action: () => { this.details = humanJson({ connection: this.connection, events: this.controlEvents, messages: this.logs, lastFailure: this.lastFailure, graphics: this.nativeGraphics?.diagnostics?.() }).split('\n'); this.detailsOffset = 0; this.detailCache = undefined; } },
                    { label: '返回', action: () => { this.menu = undefined; } },
                ] };
                return;
            }
            if (this.run && parsed.options.json === true) await this.perform(['runs', 'get', String(this.run.runId), '--json']);
            else if (this.partialAnswer) { this.partialVisible = true; this.partialFollow = true; this.updateState(); }
            else if (this.run) await this.perform(['runs', 'get', String(this.run.runId)]);
            else this.log('当前没有已选执行，可用/run list查看记录');
            return;
        }
        if (name === 'clear') { this.commandDraft = undefined; this.logs = []; this.details = []; this.transcript = []; this.transcriptFollow = true; this.detailCache = undefined; this.renderer.reset(); return; }
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
                if (pending.method === 'profiles.put' || pending.method === 'profiles.importSecret') execution.result = await refreshSavedProfileCatalog(this.client, execution.result);
            } else {
                if (snapshot && ['conversation update', 'model set'].includes(command.spec.name) && parsed.options.revision === undefined) parsed.options.revision = Number(snapshot.revision);
                execution = await executeCommand(command, { client: this.client, cwd: this.streams.cwd ?? process.cwd(), conversationId: snapshot ? String(snapshot.conversationId) : undefined, interactive: true,
                    readInput: () => { if (parsed.options.stdin) throw usage('交互前台使用草稿或输入文件'); return readCommandInput(parsed, this.streams.stdin); } });
            }
            if (execution.result.error?.mayHaveStarted && execution.clientCommandId) this.pendingCommands.set(key, {
                commandId: execution.clientCommandId, method: execution.method,
                ...(execution.method && METHOD_SPECS[execution.method]?.scope === 'conversation' && snapshot ? { conversationId: String(snapshot.conversationId) } : {}),
            });
            const updatedConversation = parsed.options.conversation ?? parsed.options['conversation-id'] ?? snapshot?.conversationId;
            if (execution.result.ok && execution.method === 'conversations.update' && typeof updatedConversation === 'string') {
                this.conversationUpdateReceipts.delete(updatedConversation); this.conversationUpdateReceipts.set(updatedConversation, structuredClone(execution));
                if (this.conversationUpdateReceipts.size > 50) this.conversationUpdateReceipts.delete(this.conversationUpdateReceipts.keys().next().value!);
            }
            if (viewEpoch !== this.viewEpoch) { this.log('原视图操作已返回：' + (execution.method ?? command.spec.name)); return execution; }
            const rawDetails = parsed.options.json === true || parsed.options.diagnostics === true || command.spec.name === 'rpc';
            this.rememberProfileCatalog(execution.result);
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
        if (this.run && event.runId && (event.runId !== this.run.runId && !terminalRun(this.run)
            || event.runId === this.run.runId && typeof event.runEpoch === 'number' && event.runEpoch < Number(this.run.runEpoch))) return;
        const hasPartial = event.type === 'run.progress' && event.payload.partial !== undefined;
        if (hasPartial && event.runId) {
            const fresh = !this.partialAnswer || this.partialAnswer.runId !== event.runId;
            const buffer = fresh ? new PartialAnswerBuffer(String(event.conversationId), event.runId) : this.partialAnswer!;
            const previousAttempt = buffer.current?.attemptId;
            if (buffer.append(event.payload)) {
                this.partialAnswer = buffer;
                if (fresh || previousAttempt !== buffer.current?.attemptId) { this.partialVisible = true; this.partialFollow = true; }
                this.detailCache = undefined;
                this.scheduleRender(fresh);
            }
        }
        const text = hasPartial ? undefined : eventText(event);
        if (text) { this.outputText = (this.outputText + text).slice(-1024 * 1024); this.log(cleanText(text)); }
        if (event.type === 'run.progress') {
            const { partial: _partial, ...progress } = event.payload;
            if (this.run && event.runId === this.run.runId) this.run = { ...this.run, ...progress };
        }
        if (event.type === 'executor.stepRecorded' && event.payload.kind === 'model' && typeof event.payload.contentId === 'string' && event.runId) await this.showFormalModel(event.payload.contentId, event.runId, viewEpoch);
        if (event.runId && /^(?:run\.(?:succeeded|failed|cancelled|paused|outcome_unknown|stopping|cleanup)|round.completed)$/.test(event.type)) {
            const result = await this.client.request<Record<string, unknown>>('runs.get', { conversationId: event.conversationId, runId: event.runId });
            if (result.ok && result.data && viewEpoch === this.viewEpoch) this.run = result.data;
        }
        if (viewEpoch !== this.viewEpoch || this.disposed) return;
        if (/interaction|approval/.test(event.type)) this.log('有新的待批或提问，使用/approvals查看对象与范围');
        if (/^(?:run\.(?:succeeded|failed|cancelled|outcome_unknown)|round.completed)$/.test(event.type)) void this.refreshUsage(true);
        this.updateState();
        await this.loadRunOutput();
        this.scheduleRender();
    }

    private async showFormalModel(contentId: string, runId: string, viewEpoch: number): Promise<void> {
        if (!this.conversation || this.modelContentReads.has(contentId)) return;
        const conversationId = String(this.conversation.conversationId);
        this.modelContentReads.add(contentId);
        while (this.modelContentReads.size > 64) this.modelContentReads.delete(this.modelContentReads.values().next().value!);
        try {
            const artifact = await this.client.readArtifact(conversationId, contentId, { maxTotalBytes: 2 * 1024 * 1024 });
            if (viewEpoch !== this.viewEpoch || this.disposed) return;
            if (!artifact.ok || !artifact.data) { this.modelContentReads.delete(contentId); this.log('正式回答尚未读取，临时片段继续保留'); return; }
            const value = valueObject(decodeArtifactJson(artifact.data));
            const response = valueObject(value.response);
            if (response.complete === false) return;
            const buffer = this.partialAnswer;
            const attemptId = typeof response.attemptId === 'string' ? response.attemptId : undefined;
            const newerPartial = buffer && buffer.runId === runId && attemptId && buffer.current?.attemptId !== attemptId;
            const visible = this.partialVisible;
            if (buffer?.runId === runId && !newerPartial) { this.partialAnswer = undefined; this.partialVisible = false; this.partialFollow = true; }
            const text = modelHistoryText(value);
            if (text) { await this.printTranscript('助手：' + text); this.lastFormalAnswer = { runId, text }; }
            if (newerPartial && this.partialAnswer === buffer) this.partialVisible = visible;
        } catch {
            this.modelContentReads.delete(contentId);
            if (viewEpoch === this.viewEpoch && !this.disposed) this.log('正式回答查回未完成，已接片段继续保留');
        }
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
            const body = valueObject(result.data.result);
            const failure = runFailureLines(run);
            const formal = this.lastFormalAnswer;
            const sameAnswer = Boolean(formal && formal.runId === run.runId && typeof body.text === 'string' && terminalSafeText(body.text) === formal.text);
            const display = sameAnswer ? { ...body, text: '' } : result.data.result;
            const emptyFailure = failure.length > 0 && typeof body.text !== 'string' && !(Array.isArray(body.artifacts) && body.artifacts.length);
            const text = emptyFailure ? undefined : formatExecutionText(display, conversationId, this.client.dataDir) ?? (sameAnswer ? undefined : humanJson(display));
            const keepPartial = this.partialAnswer?.runId === run.runId && run.state !== 'succeeded' && !sameAnswer;
            if (this.partialAnswer?.runId === run.runId && !keepPartial) {
                this.partialAnswer = undefined; this.partialVisible = false; this.partialFollow = true;
            }
            if (text) await this.printTranscript(text);
            if (failure.length) { this.details = failure; this.detailsOffset = 0; this.detailCache = undefined; }
            if (keepPartial) this.partialVisible = true;
            if (terminalRun(run) && ['released', 'not_needed'].includes(String(run.cleanupState))) {
                this.lastOutputRun = String(run.runId);
                this.log(failure[1] ?? (run.state === 'succeeded' ? '执行已完成，资源已释放' : '执行已结束，资源已释放'));
            }
        } finally { this.loadingOutput = false; }
    }

    private updateState(): void {
        const run = this.run;
        if (run && terminalRun(run) && run.runId !== this.lastFinishedActivityRun) {
            this.lastFinishedActivityRun = String(run.runId); this.lastReplyFinishedAt = Date.now(); this.scheduleAppearanceDeadline();
        }
        const failure = run ? runFailureLines(run) : [];
        const failureKey = failure.length ? JSON.stringify([run?.runId, ...failure]) : undefined;
        if (failureKey !== this.failureKey) {
            this.failureKey = failureKey; this.failureDetails = failure;
            if (failure.length) {
                this.details = failure; this.detailsOffset = 0; this.detailCache = undefined;
                this.log(failure[1]);
            }
        }
        const partial = this.partialAnswer;
        if (run && partial && partial.runId === run.runId) {
            const partialStates: Record<string, PartialAnswerState> = { cancelled: 'cancelled', failed: 'failed', outcome_unknown: 'unknown', paused: 'paused', stopping: 'stopping', succeeded: 'awaiting_final' };
            if (partialStates[String(run.state)]) partial.mark(partialStates[String(run.state)]);
        }
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
        const states: Record<string, string> = { running: '工作中', succeeded: '已完成', failed: '执行失败', cancelled: '已取消', waiting: '等待答复', stopping: '正在停止', paused: '已暂停', outcome_unknown: '原结果待核实', queued: '排队中' };
        const phases: Record<string, string> = { executing_tools: '正在执行工具', generating: '正在生成', model_request: '正在请求模型', preparing: '准备中' };
        const cleanup: Record<string, string> = { released: '资源已释放', not_needed: '无需清理', running: '资源收尾中', pending: '等待收尾', unconfirmed: '资源收尾待核实' };
        this.status = this.run ? [this.run.state === 'succeeded' ? '回复完成' : states[String(this.run.state)] ?? '工作中',
            phases[String(this.run.phase)] ?? (this.state === 'thinking' ? '正在思考' : this.state === 'searching' ? '正在查阅' : this.state === 'typing' ? '正在写入' : ''),
            ['released', 'not_needed'].includes(String(this.run.cleanupState)) ? '' : cleanup[String(this.run.cleanupState)] ?? '资源状态待更新',
            this.observing ? '只读观察' : ''].filter(Boolean).join(' · ') : '空闲 · ' + (this.observing ? '只读观察' : '输入已可用');
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
            label: String(interaction.summary ?? interaction.toolName ?? '待答问题'), detail: String(valueObject(interaction.scope).reason ?? interaction.expiresAt ?? ''), action: () => {
                const scope = valueObject(interaction.scope);
                const action = valueObject(interaction.action);
                const paths = Array.isArray(scope.paths) ? scope.paths.map(String).join('；') : typeof action.path === 'string' ? action.path : '范围未提供，请先查看详细对象';
                const effects = Array.isArray(scope.effects) ? scope.effects.map(String).join('、') : String(action.operation ?? interaction.kind ?? '待答复');
                this.details = [`工具/动作：${interaction.toolName ?? interaction.summary ?? '待答问题'}`, `范围：${paths}`, `影响：${effects}`,
                    ...(scope.reason ? ['原因：' + scope.reason] : []), ...(interaction.expiresAt ? ['有效期：' + interaction.expiresAt] : [])];
                this.menu = { title: '核对动作与范围后答复', index: 0, context: this.details, items: [
                    { label: '拒绝本动作', action: () => this.respondInteraction(interaction, 'deny') },
                    { label: '仅批准本次', action: () => this.respondInteraction(interaction, 'approve') },
                    { label: '填写提问答复', action: () => this.openForm('答复提问', [{ key: 'answer', label: '答复', required: true }], values => this.respondInteraction(interaction, 'answer', values.answer)) },
                    { label: '查看身份、版本与完整对象', action: () => { this.details = Object.entries(interaction).filter(([key]) => !/secret|credential|token/i.test(key)).map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`); this.detailsOffset = 0; this.detailCache = undefined; } },
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
        if (this.terminal.linear || requested === 'none') { this.hideNativeGraphics(); this.renderer.options.graphics = 'none'; this.renderer.options.cellSize = undefined; return; }
        if (requested === 'auto' && this.renderer.options.color) this.startNativeGraphics();
        else this.hideNativeGraphics();
        const host = terminalGraphicsHost();
        let sixel = false;
        let kitty = false;
        let cell: [number, number] | undefined;
        const manual = /^(\d+)x(\d+)$/.exec(String(this.initial.options['cell-size'] ?? ''));
        if (manual) cell = [Number(manual[1]), Number(manual[2])];
        if (!host.queries || requested === 'blocks') {
            this.terminalGraphicsMode = 'blocks';
            this.renderer.options.graphics = requested === 'auto' && this.nativeGraphicsReady ? 'native' : 'blocks';
            this.renderer.options.cellSize = cell ? { width: cell[0], height: cell[1] } : undefined;
            if (requested === 'kitty' || requested === 'sixel') this.log('当前宿主使用字格动画，不发送未确认的图片协议探测');
            this.renderer.reset(); this.detailCache = undefined;
            return;
        }
        const listener = (reply: string) => {
            if (revision !== this.geometryRevision || width !== this.terminal.width || height !== this.terminal.height) return;
            const size = /^\x1b\[6;(\d+);(\d+)t$/.exec(reply);
            if (size && !manual) cell = [Number(size[2]), Number(size[1])];
            const pixels = /^\x1b\[4;(\d+);(\d+)t$/.exec(reply);
            if (pixels && !manual && !cell) cell = [Number(pixels[2]) / width, Number(pixels[1]) / height];
            if (/^\x1b\[\?[\d;]*c$/.test(reply) && reply.slice(3, -1).split(';').includes('4')) sixel = true;
            if (/^\x1b_Gi=31;OK\x1b\\$/.test(reply)) kitty = true;
        };
        this.terminal.on('reply', listener);
        if (['auto', 'sixel', 'blocks', 'kitty'].includes(requested)) {
            await this.terminal.write('\x1b[c' + (host.kitty && ['auto', 'kitty'].includes(requested) ? '\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\' : '') + '\x1b[16t\x1b[14t');
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
        this.terminalGraphicsMode = this.renderer.options.color && kitty && dimensions && ['auto', 'kitty'].includes(requested) ? 'kitty'
            : this.renderer.options.color && sixel && dimensions && requested !== 'blocks' && requested !== 'kitty' ? 'sixel' : 'blocks';
        this.renderer.options.graphics = requested === 'auto' && this.nativeGraphicsReady ? 'native' : this.terminalGraphicsMode;
        if (requested === 'sixel' && this.renderer.options.graphics !== 'sixel') this.log('终端尚未确认Sixel图片能力和字格尺寸，当前显示字符兼容画面');
        if (requested === 'kitty' && this.renderer.options.graphics !== 'kitty') this.log('终端尚未确认Kitty图片能力和字格尺寸，当前显示同面积字符');
        this.renderer.reset();
        this.detailCache = undefined;
    }

    private async resizeTerminal(): Promise<void> {
        if (this.disposed) return;
        this.hideNativeGraphics();
        this.renderer.options.graphics = this.terminal.linear ? 'none' : this.nativeGraphicsReady && String(this.initial.options.graphics ?? 'auto') === 'auto' ? 'native' : 'blocks';
        if (!this.terminal.linear) await this.terminal.write(this.renderer.clearFrame());
        this.renderer.reset(); this.scheduleRender(true);
        await this.negotiateGraphics();
        this.scheduleRender();
    }

    private startNativeGraphics(): void {
        if (this.nativeGraphicsAttempted || process.platform !== 'win32' || !this.streams.stdin.isTTY || !this.streams.stderr.isTTY) return;
        this.nativeGraphicsAttempted = true;
        this.nativeGraphics = this.createNativeGraphics(event => {
            if (this.disposed) return;
            if (event.type === 'text-metrics' && event.characterWidths && typeof event.characterWidths === 'object') {
                if (this.renderer.setCharacterWidths(event.characterWidths as Record<string, number>) || event.measurementCompleted === true) {
                    this.detailCache = undefined; this.nativePaintRevision = -1; this.scheduleRender(true);
                }
            }
            if (event.viewport) {
                this.terminal.updateViewport?.(event.viewport);
                if (this.renderer.setViewport?.(event.viewport)) {
                    this.detailCache = undefined; this.nativePaintRevision = -1;
                    if (typeof event.scrollRows === 'number' && event.scrollRows !== 0) {
                        this.noteUserActivity();
                        if (this.menu) this.menu.index = Math.max(0, Math.min(this.menu.items.length - 1, this.menu.index + event.scrollRows));
                        else if (!this.form) this.scrollDetails(event.scrollRows);
                    }
                    this.scheduleRender(true);
                }
            }
            if (event.type === 'ready') {
                this.nativeGraphicsReady = true;
                if (String(this.initial.options.graphics ?? 'auto') === 'auto' && this.renderer.options.color && !this.terminal.linear) {
                    this.renderer.options.graphics = 'native'; this.renderer.reset(); this.detailCache = undefined;
                    this.nativePaintRevision = -1; this.scheduleRender(true);
                }
            } else if (event.type === 'unavailable' || event.type === 'exit') {
                this.nativeGraphicsReady = false;
                if (this.renderer.setCharacterWidths({})) this.detailCache = undefined;
                if (this.renderer.options.graphics === 'native') {
                    this.renderer.options.graphics = this.terminalGraphicsMode; this.renderer.reset(); this.detailCache = undefined; this.scheduleRender(true);
                }
            }
        });
        this.nativeGraphics.start();
    }

    private hideNativeGraphics(): void {
        this.nativeGraphics?.hide(); this.nativeFrameKey = ''; this.nativeRectangle = ''; this.nativePaintRevision = -1;
    }

    private sessionNavigationMenu(after?: () => Promise<void>, closing = false): void {
        if (!this.conversation) { if (after) void after(); else this.showStartup(); return; }
        const temporary = valueObject(this.conversation.retention).mode === 'temporary';
        const active = Boolean(this.run && !terminalRun(this.run));
        const action = closing || temporary && !this.observing ? 'close' : 'return';
        const items: MenuItem[] = [{ label: action === 'close' ? temporary ? '关闭临时对话并清除正文，返回项目' : '关闭当前对话，返回项目' : '返回项目，保留对话与草稿',
            detail: active ? '先停止当前回复并确认资源收尾' : '应用继续运行', action: async () => { if (await this.leaveCurrentConversation(action, true) && after) await after(); } }];
        if (active && !temporary && !closing) items.push({ label: '返回项目，让后台按原预算继续', detail: '释放当前前台控制，保留可恢复的对话', action: async () => { if (await this.leaveCurrentConversation('return', false) && after) await after(); } });
        items.push({ label: '继续当前对话', action: () => { this.menu = undefined; } });
        this.menu = { title: closing ? '关闭当前对话' : '返回项目', index: 0, items, back: () => { this.menu = undefined; } };
        this.scheduleRender();
    }

    private async leaveCurrentConversation(action: 'return' | 'close', stopRun: boolean): Promise<boolean> {
        if (!this.conversation) { this.showStartup(); return true; }
        if (this.busy || this.switching || this.pendingDrafts.has(String(this.conversation.conversationId))) { this.log('原命令或发送回执仍待确认，核对后再离开当前对话'); return false; }
        const conversation = this.conversation;
        const conversationId = String(conversation.conversationId);
        const temporary = valueObject(conversation.retention).mode === 'temporary';
        if (temporary && !this.observing && action === 'return') { this.sessionNavigationMenu(); return false; }
        if (this.observing && action === 'close') { this.log('当前为只读观察，可返回项目或先取得控制再关闭'); return false; }
        this.switching = true; this.busy = true;
        try {
            if (!this.observing && this.run && !terminalRun(this.run) && (stopRun || action === 'close')) {
                const stopped = await cancelExecution(this.client, conversationId, String(this.run.runId));
                if (!stopped.ok) { this.showError(stopped); return false; }
                const run = valueObject(stopped.data);
                if (!terminalRun(run) || !['released', 'not_needed'].includes(String(run.cleanupState))) { this.log('当前回复或资源收尾仍待确认，原对话继续保留'); return false; }
                this.run = run;
            }
            if (action === 'close' || this.pendingSessionCloses.has(conversationId)) {
                if (this.run && !['released', 'not_needed'].includes(String(this.run.cleanupState))) { this.log('原执行资源收尾仍待确认，当前对话继续保留'); return false; }
                const pending = this.pendingSessionCloses.get(conversationId);
                let closed = pending?.result;
                if (!closed && pending) {
                    const receipt = await this.client.getReceipt(pending.commandId, conversationId);
                    const original = valueObject(receipt.data).result;
                    if (!original || typeof valueObject(original).ok !== 'boolean') { this.log('原关闭结果仍待确认，本次仅查原回执'); return false; }
                    closed = original as RpcResult;
                } else if (!closed) {
                    const commandId = randomUUID(); this.pendingSessionCloses.set(conversationId, { commandId });
                    closed = await this.client.request('conversations.close', { conversationId, reason: '人工关闭当前对话，返回项目' }, { clientCommandId: commandId });
                }
                if (!closed.ok) { if (!closed.error?.mayHaveStarted) this.pendingSessionCloses.delete(conversationId); this.showError(closed); return false; }
                this.pendingSessionCloses.get(conversationId)!.result = closed;
            }
            if (!this.observing) {
                const released = await this.client.releaseControl('conversation', conversationId);
                if (!released.ok && (released.error?.mayHaveStarted || !['CONTROL_REQUIRED', 'CONTROL_CONFLICT', 'NOT_FOUND', 'TEMPORARY_GONE'].includes(released.error?.code ?? ''))) { this.showError(released); return false; }
            }
            await this.monitor?.stop(); this.monitor = undefined; this.viewEpoch += 1;
            if (temporary) {
                this.drafts.delete(conversationId); this.pendingDrafts.delete(conversationId);
                for (let index = this.history.length - 1; index >= 0; index -= 1) if (this.history[index].conversationId === conversationId) this.history.splice(index, 1);
                for (const [key, pending] of this.pendingCommands) if (pending.conversationId === conversationId) this.pendingCommands.delete(key);
            } else this.drafts.set(conversationId, this.draft);
            this.project = projectFromOptions(conversation.options, this.streams.cwd ?? process.cwd());
            this.conversation = undefined; this.run = undefined; this.draft = new DraftBuffer(); this.outputText = '';
            this.partialAnswer = undefined; this.partialVisible = false; this.lastFormalAnswer = undefined;
            this.transcript = []; this.details = []; this.detailCache = undefined; this.logs = [];
            this.form = undefined; this.commandDraft = undefined; this.creation = undefined; this.setupContinuation = undefined;
            this.modelSetting = undefined; this.selectingModel = false; this.selectionTarget = 'conversation';
            this.usageScope = ''; this.usageOverview = undefined; this.selectedProfile = undefined; this.selectedModel = undefined;
            this.status = '项目已打开 · 可以新建或继续对话'; this.observing = this.initial.options.observe === true;
            this.renderer.reset(); this.showStartup(); this.scheduleRender(true);
            this.pendingSessionCloses.delete(conversationId);
            return true;
        } finally { this.busy = false; this.switching = false; }
    }

    private showQuit(): void {
        const temporary = valueObject(this.conversation?.retention).mode === 'temporary';
        const items: MenuItem[] = [{ label: this.conversation ? '关闭当前对话并退出应用' : '退出应用', action: () => this.quit(false) }];
        if (this.conversation) items.push({ label: '只返回项目，保留应用', action: () => this.sessionNavigationMenu() });
        if (this.conversation && !temporary) items.push({ label: '明确脱离前台，后台按原预算继续', action: () => this.quit(true) });
        items.push({ label: '返回，继续编辑', action: () => { this.menu = undefined; } });
        this.menu = { title: '退出前确认', items, index: 0 };
    }

    private async quit(detach: boolean): Promise<void> {
        if (detach && valueObject(this.conversation?.retention).mode === 'temporary') { this.log('临时会话关闭即清，退出需要取消并关闭'); this.showQuit(); return; }
        if (!detach && this.conversation && !this.observing) {
            if (!await this.leaveCurrentConversation('close', true)) return;
        } else if (this.conversation && !this.observing) await this.client.releaseControl('conversation', String(this.conversation.conversationId));
        await this.finish(0);
    }

    private async closeTemporaryAndOpen(targetId: string, observe: boolean): Promise<void> {
        if (!this.conversation || this.switching) return;
        if (await this.leaveCurrentConversation('close', true)) await this.openConversation(targetId, observe);
    }

    private async printTranscript(text: string, replace = false): Promise<void> {
        if (this.editing) return;
        const transcript = terminalSafeText(text);
        this.transcript = appendTranscriptLines(this.transcript, transcript, replace);
        if (replace) this.transcriptFollow = true;
        this.partialVisible = false;
        this.printingTranscript = true;
        this.hideNativeGraphics();
        try {
            if (this.terminal.linear) await new Promise<void>((resolveWrite, rejectWrite) => this.streams.stdout.write(transcript + '\n', error => error ? rejectWrite(error) : resolveWrite()));
            this.details = []; if (this.transcriptFollow) this.detailsOffset = 0; this.detailCache = undefined;
        } finally { this.printingTranscript = false; this.renderer.reset(); this.scheduleRender(true); }
    }

    private showResult(execution: CommandExecution, options: { raw?: boolean; titleHint?: string } = {}): void {
        this.lastOperationReceipt = structuredClone(execution);
        if (!execution.result.ok) { this.showError(execution.result); return; }
        this.partialVisible = false;
        this.details = interactiveResultLines(execution, options);
        this.detailsOffset = 0;
        this.log('操作完成 · /status可查看详情');
        this.scheduleRender();
    }
    private rememberProfileCatalog(result: RpcResult): void {
        const refresh = valueObject(valueObject(result.data).catalogRefresh);
        if (typeof refresh.profileId !== 'string') return;
        this.profileCatalogRefreshes.delete(refresh.profileId);
        this.profileCatalogRefreshes.set(refresh.profileId, refresh);
        if (this.profileCatalogRefreshes.size > 100) this.profileCatalogRefreshes.delete(this.profileCatalogRefreshes.keys().next().value!);
    }
    private showError(result: RpcResult, operation = true): void {
        if (operation) this.errorSerial += 1;
        this.lastFailure = structuredClone(result);
        const message = `${result.error?.code ?? 'ERROR'}：${result.error?.message ?? '操作未完成'}`;
        this.log(message);
        this.status = result.error?.message ?? '操作未完成';
        this.details = [result.error?.message ?? '操作未完成，可在/status查看原始信息'];
        this.detailsOffset = 0;
        this.scheduleRender();
    }
    private log(message: string): void { if (this.logs.at(-1) !== message) this.logs.push(message); this.logs = this.logs.slice(-50); }

    private view(): TerminalView {
        const { lines, maxOffset } = this.detailPage();
        const followTranscript = !this.terminal.linear && !this.showingPartial && !this.details.length && this.transcript.length > 0 && this.transcriptFollow;
        this.detailsOffset = this.showingPartial && this.partialFollow || followTranscript ? maxOffset : Math.max(0, Math.min(maxOffset, this.detailsOffset));
        let details = lines.slice(this.detailsOffset);
        if (this.showingPartial && this.terminal.linear && this.partialAnswer?.current?.state === 'receiving') details = [this.partialAnswer.caption, '完成后显示正式全文；已接片段在本轮临时区保留'];
        if (this.showingPartial && this.partialAnswer?.runId === this.run?.runId && this.failureDetails.length) {
            const pageRows = this.detailPage().pageRows;
            details = [...this.failureDetails.slice(0, 2), ...details.slice(0, Math.max(1, pageRows - 2))];
        }
        if (this.menu) {
            const available = this.detailPage().pageRows;
            const context = this.menuContextLines();
            const shownContext = context.slice(this.menu.contextOffset ?? 0, (this.menu.contextOffset ?? 0) + Math.min(3, Math.max(0, available - 4)));
            const pageSize = Math.max(1, available - shownContext.length - 3);
            const start = Math.floor(this.menu.index / pageSize) * pageSize;
            this.menuPage = start;
            const selected = this.menu.items[this.menu.index];
            details = [this.menu.title + (!this.menu.commandMenu && this.menu.query ? ' · 筛选：' + this.menu.query : ''), ...shownContext, ...this.menu.items.slice(start, start + pageSize).map((item, index) => `${start + index === this.menu!.index ? '>' : ' '} ${item.label}${item.disabled ? ' [不可用]' : ''}`), selected?.disabled ?? selected?.detail ?? '', `${this.menu.index + 1}/${this.menu.items.length} · ↑↓选择 · Enter确认${context.length > shownContext.length ? ' · PgUp/PgDn详情' : ''}`];
        } else if (this.form) {
            const field = this.form.fields[this.form.index];
            const geometry = this.renderer.geometry(this.terminal.width, this.terminal.height, true);
            const width = Math.max(8, this.terminal.width - (geometry.canDraw ? geometry.graphicColumns + 9 : 4));
            details = [this.form.title, ...(this.form.error ? [this.form.error] : []), `${this.form.index + 1}/${this.form.fields.length} · ${field.label}`, ...(field.choices ? ['可选：' + field.choices.join(' / '), '↑↓切换选项'] : []), 'Enter下一项 · Shift+Tab上一项 · Esc保留原稿并返回'].flatMap(line => wrapText(line, width, this.renderer.textMetrics));
        } else if (!details.length) {
            const retention = valueObject(this.conversation?.retention);
            details = ['准备工作', `对话：${valueObject(this.conversation?.options).title || '未命名对话'}`, `保存：${({ archive: '归档保存', temporary: '临时保存', ttl: '限时保存' } as Record<string, string>)[String(retention.mode ?? 'archive')]}`, `模型：${this.selectedModel ?? '待选择'}`, `工作目录：${this.workspacePath()}`, 'Enter发送/排队 · Alt+Enter补充当前轮', '/approvals批准 · Ctrl+C打断', '/settings设置 · @材料 · /quit退出'];
        }
        const normalHint = `Esc返回项目 · AltM模型 · AltW工作区 · AltS设置 · Enter${this.enterBehavior === 'newline' ? '换行' : this.run && !terminalRun(this.run) ? '排队' : '发送'} · AltEnter补充 · @材料 · /命令`;
        const expandedHint = normalHint + ' · AltN新对话 · AltR恢复';
        const chatHint = visibleWidth(expandedHint, this.renderer.textMetrics) <= this.terminal.width - 4 ? expandedHint : normalHint;
        const pageRows = this.detailPage().pageRows;
        const readingHint = !this.menu && !this.form && maxOffset > 0 ? `PgUp/PgDn回看 ${this.detailsOffset + 1}-${Math.min(lines.length, this.detailsOffset + pageRows)}/${lines.length} · ${this.draft.text ? 'Esc返回项目' : 'End回最新'}` : chatHint;
        const model = this.creation ? this.newSelection.modelId : this.selectedModel;
        const options = valueObject(this.conversation?.options);
        const compression = this.creation?.compression === null ? model : this.creation?.compression?.modelId ?? valueObject(options.compressionModelSelection).modelId ?? valueObject(options.compressionModel).modelId ?? (typeof options.compressionModel === 'string' ? options.compressionModel : undefined);
        return { inline: true, state: this.state, ...idleAppearance(this.lastUserActivityAt, this.lastReplyFinishedAt, Date.now(), Boolean(this.run && !terminalRun(this.run))), status: (this.showingPartial ? this.partialAnswer!.caption + ' · ' : '') + this.status, heading: model ? `主模型 ${model} · 压缩 ${compression ?? '沿API设置'} · ${basename(this.workspacePath()) || this.workspacePath()}` : `待选择模型 · ${this.project.name}`,
            connection: `${this.client.connected === false ? '正在连接' : this.conversation ? this.observing ? '只读观察' : '已就绪' : this.creation ? '准备新对话' : '待配置对话'} | ${graphicsSummary(this.renderer.options.graphics, this.renderer.options.color)}`, details, logs: [],
            metrics: this.conversation ? chatUsageLines(this.usageOverview).slice(0, 3) : [],
            draft: this.form?.draft ?? this.commandDraft ?? this.draft, hidden: this.form?.fields[this.form.index].hidden,
            inputLabel: this.form?.fields[this.form.index].label ?? (this.draft.references.length ? `草稿已选 ${this.draft.references.length} 份材料` : undefined),
            hint: this.form ? '表单输入 · Enter下一项 · Esc返回' : this.pendingDraft ? '原发送状态待确认，再次发送只查原回执' : this.run?.kind === 'maintenance' && !terminalRun(this.run) ? '维护中，草稿保留；结束后再次发送' : readingHint, stateStartedAt: this.stateStartedAt };
    }

    private menuContextLines(): string[] {
        const geometry = this.renderer.geometry(this.terminal.width, this.terminal.height, true);
        const sprite = geometry.canDraw && this.renderer.options.graphics !== 'none' && this.renderer.assets.sprites ? geometry.graphicColumns : 0;
        const width = Math.max(8, this.terminal.width - (sprite ? sprite + 9 : 4));
        return (this.menu?.context ?? []).flatMap(line => wrapText(line, width, this.renderer.textMetrics));
    }

    private detailLines(): string[] {
        const geometry = this.renderer.geometry(this.terminal.width, this.terminal.height, true);
        const sprite = geometry.canDraw && this.renderer.options.graphics !== 'none' && this.renderer.assets.sprites ? geometry.graphicColumns : 0;
        const columns = Math.max(20, Math.min(300, Math.floor(this.terminal.width)));
        const width = Math.max(8, columns - (sprite ? sprite + 9 : 4));
        const ambiguousWidth = this.renderer.options.ambiguousWidth;
        const source = this.showingPartial ? this.partialAnswer!.lines() : this.details.length || this.terminal.linear ? this.details : this.transcript;
        const emojiFallback = process.platform === 'win32' && !terminalGraphicsHost().queries;
        if (this.detailCache?.source === source && this.detailCache.width === width && this.detailCache.ambiguousWidth === ambiguousWidth && this.detailCache.emojiFallback === emojiFallback) return this.detailCache.lines;
        const lines = markdownDisplayLines(source, { emojiFallback }).flatMap(line => wrapText(line, width, this.renderer.textMetrics));
        this.detailCache = { source, width, ambiguousWidth, emojiFallback, lines };
        return lines;
    }

    private scrollDetails(delta: number): void {
        const { maxOffset } = this.detailPage();
        this.detailsOffset = Math.max(0, Math.min(maxOffset, Math.min(maxOffset, this.detailsOffset) + delta));
        if (this.partialVisible) this.partialFollow = delta > 0 && this.detailsOffset === maxOffset;
        else if (!this.details.length && this.transcript.length) this.transcriptFollow = delta > 0 && this.detailsOffset === maxOffset;
    }

    private detailPage(): { lines: string[]; pageRows: number; maxOffset: number } {
        const lines = this.detailLines();
        const geometry = this.renderer.geometry(this.terminal.width, this.terminal.height, true);
        const rows = this.renderer.frameHeight(this.terminal.height, true);
        const pageRows = geometry.canDraw ? geometry.bodyRows : Math.max(1, rows - (this.renderer.options.graphics === 'none' ? 12 : 13));
        let end = lines.length;
        while (end > 0 && !lines[end - 1].trim()) end -= 1;
        return { lines, pageRows, maxOffset: Math.max(0, end - pageRows) };
    }

    private get pendingDraft(): PendingDraft | undefined { return this.conversation ? this.pendingDrafts.get(String(this.conversation.conversationId)) : undefined; }
    private get showingPartial(): boolean { return Boolean(this.partialVisible && this.partialAnswer && !this.menu && !this.form && !this.commandDraft); }

    private scheduleRender(immediate = false, animationOnly = false): void {
        if (!animationOnly) this.nativeLayoutRevision += 1;
        if (this.disposed || this.editing || this.printingTranscript || this.renderTimer) return;
        if (this.renderInFlight) { this.renderAgain = true; return; }
        this.renderTimer = setTimeout(async () => {
            this.renderTimer = undefined;
            if (this.disposed) return;
            this.renderInFlight = true;
            try {
                if (this.terminal.linear) {
                    const view = this.view();
                    const frame = [view.connection, ...view.details, view.status, ...(view.metrics ?? []), ...view.logs.slice(-1), view.inputLabel ?? '输入', view.hidden ? '（隐藏）' : view.draft.text].join('\n') + '\n';
                    if (frame !== this.lastLinearFrame) { await this.terminal.write(terminalSafeText(frame)); this.lastLinearFrame = frame; }
                } else {
                    const geometry = this.terminal.frameGeometry?.() ?? { width: this.terminal.width, height: this.terminal.height, revision: 0 };
                    const view = this.view();
                    if (this.nativeGraphicsReady && this.renderer.options.graphics === 'native') {
                        const nativeGeometry = this.renderer.geometry(geometry.width, geometry.height, view.inline);
                        const visibleRows = nativeGeometry.canDraw ? nativeGeometry.bodyRows : Math.max(1, this.renderer.frameHeight(geometry.height, view.inline) - 13);
                        const draftLines = layoutDraftInput(view.hidden ? '' : view.draft.text, view.draft.cursorGrapheme, geometry.width - 8, '▏', this.renderer.textMetrics).lines;
                        if (this.nativeGraphics?.measureText?.(terminalSafeText(['─╭╮╰╯▏•·', 'sandbox_agent · ' + (view.heading ?? ''), view.connection, ...view.logs.slice(-2), view.status, ...(view.metrics ?? []), view.hint, view.inputLabel ?? '', ...view.details.slice(0, visibleRows), ...draftLines].join('\n'))) === false) return;
                    }
                    const layoutRevision = this.nativeLayoutRevision;
                    const nativeImage = this.nativeGraphicsReady ? this.renderer.nativeImage(view, geometry.width, geometry.height) : undefined;
                    const output = this.renderer.render(view, geometry.width, geometry.height);
                    const contentChanged = this.renderer.lastRenderChanged === true;
                    if (contentChanged) this.nativeGraphics?.beginFrame?.();
                    try {
                    if (output) await this.terminal.write(output, geometry);
                    const currentGeometry = this.terminal.isCurrentGeometry?.(geometry) ?? (geometry.width === this.terminal.width && geometry.height === this.terminal.height);
                    if (!this.disposed && !this.editing && !this.printingTranscript && currentGeometry) {
                        if (nativeImage) {
                            const rectangle = JSON.stringify(nativeImage.rectangle);
                            const reanchor = layoutRevision !== this.nativePaintRevision && contentChanged || rectangle !== this.nativeRectangle;
                            if (reanchor || nativeImage.key !== this.nativeFrameKey) {
                                if (this.nativeGraphics?.frame(nativeImage.frame, nativeImage.rectangle, reanchor)) {
                                    this.nativeFrameKey = nativeImage.key; this.nativeRectangle = rectangle; this.nativePaintRevision = layoutRevision;
                                }
                            }
                        } else if (this.nativeFrameKey) this.hideNativeGraphics();
                    } else if (!currentGeometry) { this.renderer.reset(); this.renderAgain = true; }
                    } finally { if (contentChanged) this.nativeGraphics?.endFrame?.(); }
                }
            } catch { await this.finish(4); }
            finally {
                this.renderInFlight = false;
                if (this.renderAgain) { this.renderAgain = false; this.scheduleRender(false, true); }
            }
        }, immediate ? 0 : 40);
    }

    private animate(): void {
        if (this.animationTimer) clearTimeout(this.animationTimer);
        this.animationTimer = undefined;
        if (this.disposed || this.motionMode === 'off') return;
        const compact = this.renderer.options.graphics === 'native' ? false : this.renderer.geometry(this.terminal.width, this.terminal.height).compact;
        const delay = this.renderer.assets.nextFrameDelay(this.state, compact, Math.max(0, Date.now() - this.stateStartedAt), this.renderer.options.reducedMotion);
        this.animationTimer = setTimeout(() => {
            this.animationTimer = undefined;
            if (this.state === 'complete' && Date.now() - this.stateStartedAt >= 750) { this.state = 'idle'; this.stateStartedAt = Date.now(); }
            this.scheduleRender(false, true); this.animate();
        }, delay);
    }

    private noteUserActivity(): void {
        this.lastUserActivityAt = Date.now();
        this.scheduleAppearanceDeadline();
    }

    private scheduleAppearanceDeadline(): void {
        if (this.appearanceTimer) clearTimeout(this.appearanceTimer);
        this.appearanceTimer = undefined;
        if (this.disposed || this.run && !terminalRun(this.run)) return;
        const remaining = Math.max(this.lastUserActivityAt, this.lastReplyFinishedAt) + 30_000 - Date.now();
        if (remaining <= 0) return;
        this.appearanceTimer = setTimeout(() => { this.appearanceTimer = undefined; this.scheduleRender(); }, remaining);
        this.appearanceTimer.unref();
    }

    private async finish(code: number): Promise<void> {
        if (this.disposed) return;
        if (this.appearanceTimer) clearTimeout(this.appearanceTimer);
        this.appearanceTimer = undefined;
        this.disposed = true;
        this.preferencesGeneration += 1;
        this.viewEpoch += 1;
        this.geometryRevision += 1;
        this.graphicsNegotiation?.finish();
        this.editorAbort?.abort();
        this.pickerAbort?.abort();
        this.hideNativeGraphics(); this.nativeGraphics?.close();
        if (this.renderTimer) clearTimeout(this.renderTimer);
        if (this.animationTimer) clearTimeout(this.animationTimer);
        if (this.usageTimer) clearInterval(this.usageTimer);
        this.renderTimer = undefined;
        this.animationTimer = undefined;
        process.removeListener('SIGTERM', this.signalHandler);
        this.client.removeListener('controlLost', this.lostControl);
        if (this.form) this.clearFormSecrets(this.form);
        let exitCode = code;
        try { await this.monitor?.stop(); } catch { exitCode ||= 4; }
        if (!this.terminal.linear) {
            try { await this.terminal.write(this.renderer.releaseFrame(this.terminal.height)); } catch { exitCode ||= 4; }
        }
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
            this.hideNativeGraphics();
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
