import { chromium, type BrowserContext, type Page } from "playwright";
import fs from "fs";
import path from "path";
import iconv from "iconv-lite";
import {
    BROWSER_USER_DATA_DIR,
    COOKIES_BACKUP_FILE,
    DEFAULT_USER_AGENT,
    DEFAULT_TIMEOUT,
    ANTI_BOT_DELAY_MIN,
    ANTI_BOT_DELAY_MAX,
    DOMAIN_REQUEST_COOLDOWN,
    HIGH_RISK_DOMAINS,
    HIGH_RISK_DELAY_MIN,
    HIGH_RISK_DELAY_MAX,
    BROWSER_ACCEPT_HEADERS,
} from "./constants.js";

/**
 * 浏览器管理器 — 单例模式
 * 使用独立的 persistent context 保存登录态
 */
class BrowserManager {
    private context: BrowserContext | null = null;
    private launching: Promise<BrowserContext> | null = null;
    private activePages = 0;
    private static readonly MAX_CONCURRENT_PAGES = 3;
    private idleTimer: ReturnType<typeof setTimeout> | null = null;
    private static readonly BROWSER_IDLE_TIMEOUT = 20 * 60 * 1000; // 20 分钟无活动关闭浏览器
    // 域名级请求时间记录 — 防止同域高频请求触发封禁
    private domainLastRequest: Map<string, number> = new Map();
    public lastRetryCount = 0;

    /**
     * 获取或启动浏览器上下文
     */
    async getContext(): Promise<BrowserContext> {
        // 健康检查：如果已有 context，验证是否仍可用
        if (this.context) {
            try {
                await this.context.pages();
                this.resetIdleTimer();
                return this.context;
            } catch {
                console.error("[web-fetcher] 检测到 context 已损坏，重建中...");
                this.context = null;
            }
        }

        // 防止并发启动
        if (this.launching) {
            return this.launching;
        }

        this.launching = this.launch();
        try {
            this.context = await this.launching;
            this.resetIdleTimer();
            return this.context;
        } finally {
            this.launching = null;
        }
    }

    /**
     * 启动浏览器 persistent context
     */
    private async launch(): Promise<BrowserContext> {
        // 确保用户数据目录存在
        if (!fs.existsSync(BROWSER_USER_DATA_DIR)) {
            fs.mkdirSync(BROWSER_USER_DATA_DIR, { recursive: true });
        }

        // 启动前清理缓存（此时浏览器未运行，无文件锁）
        this.cleanProfileCache();

        console.error(`[web-fetcher] 启动浏览器，profile: ${BROWSER_USER_DATA_DIR}`);

        const context = await chromium.launchPersistentContext(
            BROWSER_USER_DATA_DIR,
            {
                headless: true,
                userAgent: DEFAULT_USER_AGENT,
                viewport: { width: 1920, height: 1080 },
                locale: "zh-CN",
                timezoneId: "Asia/Shanghai",
                // 反检测启动参数
                args: [
                    // 核心反自动化
                    "--disable-blink-features=AutomationControlled",
                    "--no-first-run",
                    "--no-default-browser-check",
                    "--disable-infobars",
                    // 性能 & 兼容
                    "--disable-dev-shm-usage",
                    "--no-sandbox",
                    // WebGL 硬件加速（防止 SwiftShader 暴露）
                    "--enable-webgl",
                    "--use-gl=angle",
                    "--enable-features=VaapiVideoDecoder",
                    // WebRTC 禁止泄露真实 IP
                    "--enforce-webrtc-ip-permission-check",
                    "--webrtc-ip-handling-policy=disable_non_proxied_udp",
                    // 隱藏自动化特征（不禁用extensions，真实浏览器有扩展）
                    "--disable-component-extensions-with-background-pages",
                    "--disable-default-apps",
                    "--disable-component-update",
                    "--disable-hang-monitor",
                    "--disable-ipc-flooding-protection",
                    "--disable-popup-blocking",
                    "--disable-prompt-on-repost",
                    "--disable-renderer-backgrounding",
                    "--disable-sync",
                    "--metrics-recording-only",
                    "--password-store=basic",
                    "--use-mock-keychain",
                    // 窗口大小一致性
                    "--window-size=1920,1080",
                    "--window-position=0,0",
                    // 本地文件访问支持
                    "--allow-file-access-from-files",
                    "--allow-file-access",
                ],
                // Sec-CH-UA Client Hints HTTP headers
                extraHTTPHeaders: {
                    "Sec-CH-UA": '"Chromium";v="133", "Not(A:Brand";v="99", "Google Chrome";v="133"',
                    "Sec-CH-UA-Mobile": "?0",
                    "Sec-CH-UA-Platform": '"Windows"',
                    "Sec-CH-UA-Platform-Version": '"15.0.0"',
                    "Sec-CH-UA-Full-Version-List": '"Chromium";v="133.0.6943.127", "Not(A:Brand";v="99.0.0.0", "Google Chrome";v="133.0.6943.127"',
                },
            }
        );

        // ===================================
        //  Stealth 终极版 — 反检测脚本注入
        //  覆盖 20+ 检测向量
        // ===================================
        await context.addInitScript(`
            // ==========================================
            //  Layer 1: Navigator 属性覆盖
            // ==========================================

            // 1. navigator.webdriver → undefined
            Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined,
            });

            // 2. navigator.languages
            Object.defineProperty(navigator, 'languages', {
                get: () => ['zh-CN', 'zh', 'en-US', 'en'],
            });

            // 3. navigator.plugins — 真实 PluginArray 结构
            Object.defineProperty(navigator, 'plugins', {
                get: () => {
                    const makePlugin = (name, desc, filename, mimes) => {
                        const plugin = { name, description: desc, filename, length: mimes.length };
                        mimes.forEach((m, i) => { plugin[i] = m; });
                        plugin[Symbol.iterator] = function*() { for (let i = 0; i < this.length; i++) yield this[i]; };
                        return plugin;
                    };
                    const arr = [
                        makePlugin('Chrome PDF Plugin', 'Portable Document Format', 'internal-pdf-viewer',
                            [{ type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format' }]),
                        makePlugin('Chrome PDF Viewer', '', 'mhjfbmdgcfjbbpaeojofohoefgiehjai',
                            [{ type: 'application/pdf', suffixes: 'pdf', description: '' }]),
                        makePlugin('Native Client', '', 'internal-nacl-plugin', [
                            { type: 'application/x-nacl', suffixes: '', description: 'Native Client Executable' },
                            { type: 'application/x-pnacl', suffixes: '', description: 'Portable Native Client Executable' },
                        ]),
                    ];
                    Object.setPrototypeOf(arr, PluginArray.prototype);
                    return arr;
                },
            });

            // 4. navigator.mimeTypes
            Object.defineProperty(navigator, 'mimeTypes', {
                get: () => {
                    const arr = [
                        { type: 'application/pdf', suffixes: 'pdf', description: '', enabledPlugin: navigator.plugins[1] },
                        { type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format', enabledPlugin: navigator.plugins[0] },
                    ];
                    Object.setPrototypeOf(arr, MimeTypeArray.prototype);
                    return arr;
                },
            });

            // 5. navigator.hardwareConcurrency / deviceMemory
            Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
            Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

            // 6. navigator.maxTouchPoints (桌面 = 0)
            Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0 });

            // 7. navigator.connection
            if (!navigator.connection) {
                Object.defineProperty(navigator, 'connection', {
                    get: () => ({
                        effectiveType: '4g', rtt: 50, downlink: 10, saveData: false,
                        addEventListener: function(){}, removeEventListener: function(){},
                    }),
                });
            }

            // 8. navigator.getBattery — 模拟真实电池
            navigator.getBattery = () => Promise.resolve({
                charging: true, chargingTime: 0, dischargingTime: Infinity, level: 1,
                addEventListener: function(){}, removeEventListener: function(){},
            });

            // ==========================================
            //  Layer 2: Chrome 对象完善
            // ==========================================
            window.chrome = {
                runtime: {
                    onMessage: { addListener: function(){}, removeListener: function(){} },
                    sendMessage: function(){},
                    connect: function(){ return { onMessage: { addListener: function(){} }, postMessage: function(){}, disconnect: function(){} }; },
                    id: undefined,
                    getManifest: function(){ return {}; },
                    getURL: function(path){ return ''; },
                    PlatformOs: { MAC: 'mac', WIN: 'win', ANDROID: 'android', CROS: 'cros', LINUX: 'linux', OPENBSD: 'openbsd' },
                    PlatformArch: { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64', MIPS: 'mips', MIPS64: 'mips64' },
                    RequestUpdateCheckStatus: { THROTTLED: 'throttled', NO_UPDATE: 'no_update', UPDATE_AVAILABLE: 'update_available' },
                },
                loadTimes: function(){ return { requestTime: Date.now() / 1000, startLoadTime: Date.now() / 1000, commitLoadTime: Date.now() / 1000, finishDocumentLoadTime: Date.now() / 1000, finishLoadTime: Date.now() / 1000, firstPaintTime: Date.now() / 1000, firstPaintAfterLoadTime: 0, navigationType: 'Other', wasFetchedViaSpdy: true, wasNpnNegotiated: true, npnNegotiatedProtocol: 'h2', wasAlternateProtocolAvailable: false, connectionInfo: 'h2' }; },
                csi: function(){ return { startE: Date.now(), onloadT: Date.now(), pageT: 1234, tran: 15 }; },
                app: { isInstalled: false, InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }, getDetails: function(){}, getIsInstalled: function(){}, runningState: function(){ return 'cannot_run'; } },
            };

            // ==========================================
            //  Layer 3: Permissions API
            // ==========================================
            const origQuery = window.navigator.permissions && window.navigator.permissions.query;
            if (origQuery) {
                window.navigator.permissions.query = function(params) {
                    if (params.name === 'notifications') return Promise.resolve({ state: Notification.permission });
                    return origQuery.call(window.navigator.permissions, params);
                };
            }
            // Notification.permission 默认 'default'（真实浏览器行为）
            try {
                Object.defineProperty(Notification, 'permission', { get: () => 'default' });
            } catch {}

            // ==========================================
            //  Layer 4: Window / Screen 属性
            // ==========================================

            // 9. window.outerWidth/outerHeight (headless 下可能为 0)
            Object.defineProperty(window, 'outerWidth', { get: () => 1920 });
            Object.defineProperty(window, 'outerHeight', { get: () => 1080 });
            Object.defineProperty(window, 'innerWidth', { get: () => 1920 });
            Object.defineProperty(window, 'innerHeight', { get: () => 969 });  // 减去工具栏高度

            // 10. window.screenX/screenY
            Object.defineProperty(window, 'screenX', { get: () => 0 });
            Object.defineProperty(window, 'screenY', { get: () => 0 });
            Object.defineProperty(window, 'screenLeft', { get: () => 0 });
            Object.defineProperty(window, 'screenTop', { get: () => 0 });

            // 11. screen 完整属性
            Object.defineProperty(screen, 'width', { get: () => 1920 });
            Object.defineProperty(screen, 'height', { get: () => 1080 });
            Object.defineProperty(screen, 'availWidth', { get: () => 1920 });
            Object.defineProperty(screen, 'availHeight', { get: () => 1040 }); // 减去任务栏
            Object.defineProperty(screen, 'availLeft', { get: () => 0 });
            Object.defineProperty(screen, 'availTop', { get: () => 0 });
            Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
            Object.defineProperty(screen, 'pixelDepth', { get: () => 24 });

            // 12. document.hasFocus() — headless 下默认返回 false
            Document.prototype.hasFocus = function() { return true; };

            // 13. 隐藏 document.hidden / visibilityState
            Object.defineProperty(document, 'hidden', { get: () => false });
            Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });

            // ==========================================
            //  Layer 5: WebGL 指纹伪造
            // ==========================================
            const getParameter = WebGLRenderingContext.prototype.getParameter;
            WebGLRenderingContext.prototype.getParameter = function(param) {
                // UNMASKED_VENDOR_WEBGL
                if (param === 0x9245) return 'Google Inc. (NVIDIA)';
                // UNMASKED_RENDERER_WEBGL
                if (param === 0x9246) return 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1080 Direct3D11 vs_5_0 ps_5_0, D3D11)';
                return getParameter.call(this, param);
            };
            // WebGL2 也需要覆盖
            if (typeof WebGL2RenderingContext !== 'undefined') {
                const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
                WebGL2RenderingContext.prototype.getParameter = function(param) {
                    if (param === 0x9245) return 'Google Inc. (NVIDIA)';
                    if (param === 0x9246) return 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1080 Direct3D11 vs_5_0 ps_5_0, D3D11)';
                    return getParameter2.call(this, param);
                };
            }

            // ==========================================
            //  Layer 6: Playwright 痕迹清除
            // ==========================================
            // 立即清除
            const __del = (obj, keys) => { for (const k of keys) { try { delete obj[k]; } catch {} } };
            __del(window, ['__playwright', '__pw_manual', '__PW_inspect', '__pwInitScripts']);

            // 延迟清除（Playwright 在 initScript 之后注入）
            setTimeout(() => {
                const keys = Object.getOwnPropertyNames(window).filter(
                    k => k.startsWith('__playwright') || k.startsWith('__pw') || k.startsWith('__PW')
                );
                for (const k of keys) { try { delete window[k]; } catch {} }
            }, 0);

            // 二次延迟（某些注入发生在 DOMContentLoaded 后）
            document.addEventListener('DOMContentLoaded', () => {
                setTimeout(() => {
                    const keys = Object.getOwnPropertyNames(window).filter(
                        k => k.startsWith('__playwright') || k.startsWith('__pw') || k.startsWith('__PW')
                    );
                    for (const k of keys) { try { delete window[k]; } catch {} }
                }, 100);
            }, { once: true });

            // ==========================================
            //  Layer 7: CDP (Chrome DevTools Protocol) 痕迹
            // ==========================================
            // 某些检测通过 Error.stack 检测 CDP 调用特征
            const originalError = Error;
            const nativeErrorPrepareStackTrace = Error.prepareStackTrace;
            // 过滤包含 'pptr:' 或 'puppeteer' 或 'playwright' 的 stack frames
            if (Error.captureStackTrace) {
                const origCapture = Error.captureStackTrace;
                Error.captureStackTrace = function(targetObject, constructorOpt) {
                    origCapture.call(Error, targetObject, constructorOpt);
                    if (targetObject.stack) {
                        targetObject.stack = targetObject.stack
                            .split('\\n')
                            .filter(line => !line.includes('pptr:') && !line.includes('playwright') && !line.includes('__puppeteer'))
                            .join('\\n');
                    }
                };
            }

            // ==========================================
            //  Layer 8: iframe 防护
            // ==========================================
            // 确保通过 contentWindow 访问 iframe 时 webdriver 也是 undefined
            const origHTMLIFrameContentWindow = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
            if (origHTMLIFrameContentWindow && origHTMLIFrameContentWindow.get) {
                Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
                    get: function() {
                        const win = origHTMLIFrameContentWindow.get.call(this);
                        if (win) {
                            try {
                                Object.defineProperty(win.navigator, 'webdriver', { get: () => undefined });
                            } catch {}
                        }
                        return win;
                    },
                });
            }

            // ==========================================
            //  Layer 9: 杂项一致性
            // ==========================================
            // Performance.now() 精度不做修改（会影响页面功能）

            // navigator.platform (必须和 UA 一致: Windows)
            Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });

            // ==========================================
            //  Layer 10: AudioContext 指纹伪造 (Google 关注)
            // ==========================================
            const origGetFloatFreqData = AnalyserNode.prototype.getFloatFrequencyData;
            AnalyserNode.prototype.getFloatFrequencyData = function(array) {
                origGetFloatFreqData.call(this, array);
                // 加入微小噪声，改变指纹哈希但不影响音频功能
                for (let i = 0; i < array.length; i++) {
                    array[i] += (Math.random() - 0.5) * 0.0001;
                }
            };
            const origCreateOscillator = AudioContext.prototype.createOscillator;
            AudioContext.prototype.createOscillator = function() {
                const osc = origCreateOscillator.call(this);
                // 微调 detune 让指纹不一致
                const origStart = osc.start.bind(osc);
                osc.start = function(when) {
                    osc.detune.value += (Math.random() - 0.5) * 0.04;
                    return origStart(when);
                };
                return osc;
            };

            // ==========================================
            //  Layer 11: Canvas 指纹降噪 (Google 关注)
            // ==========================================
            // toDataURL 加随机像素
            const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
            HTMLCanvasElement.prototype.toDataURL = function(type, quality) {
                const ctx = this.getContext('2d');
                if (ctx && this.width > 0 && this.height > 0) {
                    try {
                        const imageData = ctx.getImageData(0, 0, Math.min(this.width, 16), Math.min(this.height, 16));
                        const pixels = imageData.data;
                        // 修改少量像素的 alpha 通道（视觉不可见）
                        for (let i = 3; i < pixels.length; i += 4) {
                            if (Math.random() < 0.1) {
                                pixels[i] = Math.max(0, Math.min(255, pixels[i] + (Math.random() > 0.5 ? 1 : -1)));
                            }
                        }
                        ctx.putImageData(imageData, 0, 0);
                    } catch {}
                }
                return origToDataURL.call(this, type, quality);
            };

            // getImageData 也加噪
            const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
            CanvasRenderingContext2D.prototype.getImageData = function(sx, sy, sw, sh) {
                const imageData = origGetImageData.call(this, sx, sy, sw, sh);
                const pixels = imageData.data;
                for (let i = 0; i < pixels.length; i += 4) {
                    if (Math.random() < 0.01) {
                        pixels[i] = Math.max(0, Math.min(255, pixels[i] + (Math.random() > 0.5 ? 1 : -1)));
                    }
                }
                return imageData;
            };

            // ==========================================
            //  Layer 12: Google 专项防护
            // ==========================================

            // Credential Management API (Google 用此检测)
            if (!navigator.credentials) {
                Object.defineProperty(navigator, 'credentials', {
                    get: () => ({
                        create: () => Promise.resolve(null),
                        get: () => Promise.resolve(null),
                        preventSilentAccess: () => Promise.resolve(),
                        store: () => Promise.resolve(),
                    }),
                });
            }

            // Permissions 扩展 — camera/microphone/geolocation 返回 'prompt'
            const origPermQuery2 = window.navigator.permissions && window.navigator.permissions.query;
            if (origPermQuery2) {
                const permMap = {
                    'camera': 'prompt', 'microphone': 'prompt', 'geolocation': 'prompt',
                    'notifications': 'default', 'push': 'prompt', 'midi': 'granted',
                    'persistent-storage': 'granted', 'accelerometer': 'granted',
                    'gyroscope': 'granted', 'magnetometer': 'granted',
                    'clipboard-read': 'prompt', 'clipboard-write': 'granted',
                };
                window.navigator.permissions.query = function(params) {
                    const name = params.name;
                    if (name in permMap) {
                        return Promise.resolve({
                            state: permMap[name], name,
                            addEventListener: function(){}, removeEventListener: function(){},
                            onchange: null,
                        });
                    }
                    return origPermQuery2.call(window.navigator.permissions, params);
                };
            }

            // speechSynthesis.getVoices — 返回非空列表
            try {
                const origGetVoices = speechSynthesis.getVoices;
                speechSynthesis.getVoices = function() {
                    const voices = origGetVoices.call(this);
                    if (voices.length === 0) {
                        return [{
                            default: true, lang: 'zh-CN', localService: true,
                            name: 'Microsoft Huihui - Chinese (Simplified)',
                            voiceURI: 'Microsoft Huihui - Chinese (Simplified)',
                        }, {
                            default: false, lang: 'en-US', localService: true,
                            name: 'Microsoft David - English (United States)',
                            voiceURI: 'Microsoft David - English (United States)',
                        }];
                    }
                    return voices;
                };
            } catch {}

            // MediaDevices.enumerateDevices — 模拟有摄像头和麦克风
            if (navigator.mediaDevices) {
                const origEnumerate = navigator.mediaDevices.enumerateDevices;
                navigator.mediaDevices.enumerateDevices = function() {
                    return origEnumerate.call(this).then(devices => {
                        if (devices.length === 0) {
                            return [
                                { deviceId: 'default', groupId: 'default', kind: 'audioinput', label: '' },
                                { deviceId: 'default', groupId: 'default', kind: 'videoinput', label: '' },
                                { deviceId: 'default', groupId: 'default', kind: 'audiooutput', label: '' },
                            ];
                        }
                        return devices;
                    });
                };
            }

            // ==========================================
            //  Layer 13: navigator.userAgentData (User-Agent Client Hints API)
            //  Chrome 90+ 必有此 API，缺失即暴露无头浏览器
            // ==========================================
            if (!navigator.userAgentData) {
                Object.defineProperty(navigator, 'userAgentData', {
                    get: () => ({
                        brands: [
                            { brand: 'Chromium', version: '133' },
                            { brand: 'Not(A:Brand', version: '99' },
                            { brand: 'Google Chrome', version: '133' },
                        ],
                        mobile: false,
                        platform: 'Windows',
                        getHighEntropyValues: (hints) => Promise.resolve({
                            brands: [
                                { brand: 'Chromium', version: '133' },
                                { brand: 'Not(A:Brand', version: '99' },
                                { brand: 'Google Chrome', version: '133' },
                            ],
                            mobile: false,
                            platform: 'Windows',
                            platformVersion: '15.0.0',
                            architecture: 'x86',
                            bitness: '64',
                            model: '',
                            uaFullVersion: '133.0.6943.127',
                            fullVersionList: [
                                { brand: 'Chromium', version: '133.0.6943.127' },
                                { brand: 'Not(A:Brand', version: '99.0.0.0' },
                                { brand: 'Google Chrome', version: '133.0.6943.127' },
                            ],
                            wow64: false,
                        }),
                        toJSON: function() {
                            return {
                                brands: this.brands,
                                mobile: this.mobile,
                                platform: this.platform,
                            };
                        },
                    }),
                });
            }

            // ==========================================
            //  Layer 14: WebGL 扩展列表伪装
            //  headless 浏览器的扩展列表可能与真实 Chrome 不同
            // ==========================================
            const REAL_WEBGL_EXTENSIONS = [
                'ANGLE_instanced_arrays', 'EXT_blend_minmax', 'EXT_clip_control',
                'EXT_color_buffer_half_float', 'EXT_depth_clamp', 'EXT_disjoint_timer_query',
                'EXT_float_blend', 'EXT_frag_depth', 'EXT_polygon_offset_clamp',
                'EXT_shader_texture_lod', 'EXT_texture_compression_bptc',
                'EXT_texture_compression_rgtc', 'EXT_texture_filter_anisotropic',
                'EXT_texture_mirror_clamp_to_edge', 'EXT_sRGB',
                'KHR_parallel_shader_compile', 'OES_element_index_uint',
                'OES_fbo_render_mipmap', 'OES_standard_derivatives',
                'OES_texture_float', 'OES_texture_float_linear',
                'OES_texture_half_float', 'OES_texture_half_float_linear',
                'OES_vertex_array_object', 'WEBGL_color_buffer_float',
                'WEBGL_compressed_texture_s3tc', 'WEBGL_compressed_texture_s3tc_srgb',
                'WEBGL_debug_renderer_info', 'WEBGL_debug_shaders',
                'WEBGL_depth_texture', 'WEBGL_draw_buffers',
                'WEBGL_lose_context', 'WEBGL_multi_draw',
                'WEBGL_polygon_mode',
            ];
            const origGetSupportedExtensions = WebGLRenderingContext.prototype.getSupportedExtensions;
            WebGLRenderingContext.prototype.getSupportedExtensions = function() {
                return [...REAL_WEBGL_EXTENSIONS];
            };
            if (typeof WebGL2RenderingContext !== 'undefined') {
                const origGetSupportedExtensions2 = WebGL2RenderingContext.prototype.getSupportedExtensions;
                WebGL2RenderingContext.prototype.getSupportedExtensions = function() {
                    return [...REAL_WEBGL_EXTENSIONS,
                        'EXT_color_buffer_float', 'EXT_conservative_depth',
                        'EXT_render_snorm', 'EXT_texture_norm16',
                        'OES_draw_buffers_indexed', 'OES_sample_variables',
                        'OES_shader_multisample_interpolation',
                        'WEBGL_blend_func_extended', 'WEBGL_clip_cull_distance',
                        'WEBGL_draw_instanced_base_vertex_base_instance',
                        'WEBGL_multi_draw_instanced_base_vertex_base_instance',
                        'WEBGL_provoking_vertex', 'WEBGL_render_shared_exponent',
                        'WEBGL_stencil_texturing',
                    ];
                };
            }

            // ==========================================
            //  Layer 15: 字体指纹保护
            //  通过微调 measureText 结果降低指纹精度
            // ==========================================
            const origMeasureText = CanvasRenderingContext2D.prototype.measureText;
            CanvasRenderingContext2D.prototype.measureText = function(text) {
                const metrics = origMeasureText.call(this, text);
                // 加入微小噪声，让字体指纹每次不一致但不影响布局
                const noise = () => (Math.random() - 0.5) * 0.00001;
                const origWidth = metrics.width;
                Object.defineProperty(metrics, 'width', {
                    get: () => origWidth + noise(),
                });
                return metrics;
            };

        `);

        console.error("[web-fetcher] 浏览器启动成功（已注入终极 stealth 脚本 v4 — 15层防护）");

        // 恢复备份的 Cookie
        await this.restoreCookies(context);

        return context;
    }

    /**
     * 判断错误是否为瞬时故障（值得重试）
     */
    private isTransientError(error: unknown): boolean {
        const msg = error instanceof Error ? error.message : String(error);
        const TRANSIENT_PATTERNS = [
            'ERR_CONNECTION_RESET', 'ERR_CONNECTION_CLOSED', 'ERR_CONNECTION_REFUSED',
            'ERR_NAME_NOT_RESOLVED', 'ERR_NETWORK_CHANGED', 'ERR_INTERNET_DISCONNECTED',
            'ERR_TIMED_OUT', 'ERR_ABORTED',
            'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND',
            'Timeout', 'timeout',
            'CDN 加载失败', '初始化超时',
            'net::ERR_',
        ];
        return TRANSIENT_PATTERNS.some(p => msg.includes(p));
    }

    /**
     * 创建新页面并导航到指定 URL（内置瞬时故障自动重试）
     */
    async navigateTo(
        url: string,
        options?: {
            waitFor?: string;
            timeout?: number;
            scrollCount?: number;
            fullPage?: boolean;
            pageNumber?: number;
            pageNumbers?: number[];
        }
    ): Promise<Page> {
        // 每次导航重置重试计数
        this.lastRetryCount = 0;

        // 并发控制
        if (this.activePages >= BrowserManager.MAX_CONCURRENT_PAGES) {
            throw new Error(
                `已达到最大并发页面数 (${BrowserManager.MAX_CONCURRENT_PAGES})，请等待其他页面关闭后重试`
            );
        }
        this.activePages++;

        let page;
        try {
            const context = await this.getContext();
            page = await context.newPage();
        } catch (err) {
            // getContext 或 newPage 失败时回退计数器，防止服务锁死
            this.activePages = Math.max(0, this.activePages - 1);
            throw err;
        }
        const timeout = options?.timeout ?? DEFAULT_TIMEOUT;

        // 页面关闭时减少计数
        page.on("close", () => {
            this.activePages = Math.max(0, this.activePages - 1);
        });

        // ========== 本地文件快捷通道 ==========
        const isFileProtocol = url.startsWith("file://") || url.startsWith("file:///");
        if (isFileProtocol) {
            try {
                const fileCategory = (await import('./converter.js')).categorizeFile(decodeURIComponent(url.replace(/^file:\/\/\/?/, '')));

                if (fileCategory === 'pdf' || fileCategory === 'office' || fileCategory === 'tex') {
                    // PDF / Office / TeX → pdf.js 渲染
                    // Office/TeX 先转为 PDF
                    let pdfFilePath: string;
                    let filePath = decodeURIComponent(url.replace(/^file:\/\/\/?/, ''));

                    if (fileCategory === 'office' || fileCategory === 'tex') {
                        const { convertToPDF } = await import('./converter.js');
                        pdfFilePath = await convertToPDF(filePath);
                        console.error(`[web-fetcher] 文件 ${filePath} → PDF: ${pdfFilePath}`);
                    } else {
                        pdfFilePath = filePath;
                    }

                    const pdfFs = await import('fs');
                    if (!pdfFs.existsSync(pdfFilePath)) {
                        throw new Error(`PDF 文件不存在: ${pdfFilePath}`);
                    }
                    const pdfBuffer = pdfFs.readFileSync(pdfFilePath);
                    const pdfSizeMB = pdfBuffer.length / 1024 / 1024;
                    if (pdfSizeMB > 50) {
                        throw new Error(`PDF 文件过大 (${pdfSizeMB.toFixed(1)}MB)，最大支持 50MB`);
                    }

                    console.error(`[web-fetcher] PDF 渲染: ${pdfFilePath} (${pdfSizeMB.toFixed(1)}MB)`);

                    // 确定要渲染的页码列表
                    // pageNumbers 优先（多页批量），其次 pageNumber（单页），默认第1页
                    const requestedPages = options?.pageNumbers ?? (options?.pageNumber ? [options.pageNumber] : [1]);

                    await page.goto('about:blank', { waitUntil: 'load', timeout: 5000 });

                    await page.setContent(`
                        <!DOCTYPE html>
                        <html>
                        <head>
                            <style>
                                html, body { margin: 0; padding: 0; background: #525659; overflow: hidden; }
                                #pdf-container { display: flex; flex-direction: column; align-items: center; }
                                canvas { display: block; background: white; }
                                #status { color: white; font-family: sans-serif; font-size: 18px; text-align: center; padding: 40px; }
                            </style>
                        </head>
                        <body>
                            <div id="pdf-container">
                                <div id="status">正在加载 PDF...</div>
                            </div>
                        </body>
                        </html>
                    `, { waitUntil: 'load', timeout: 5000 });

                    // pdf.js CDN 加载（带瞬时故障重试）
                    for (let cdnAttempt = 0; cdnAttempt < 2; cdnAttempt++) {
                        try {
                            await page.addScriptTag({
                                url: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.9.359/pdf.min.js',
                            });
                            await page.waitForFunction(
                                () => typeof (window as any).pdfjsLib !== 'undefined',
                                { timeout: 10000 }
                            );
                            break;
                        } catch (cdnErr) {
                            if (cdnAttempt === 0) {
                                this.lastRetryCount++;
                                console.error(`[web-fetcher] ⚡ pdf.js CDN 加载失败，2秒后重试...`);
                                await page.waitForTimeout(2000);
                            } else {
                                throw new Error('pdf.js CDN 加载失败（已重试），请检查网络连接');
                            }
                        }
                    }

                    console.error(`[web-fetcher] pdf.js 加载成功，渲染 ${requestedPages.length} 页: [${requestedPages.join(',')}]`);

                    const pdfBase64 = pdfBuffer.toString('base64');
                    const renderResult = await page.evaluate(async (args: { b64: string; pages: number[]; viewportWidth: number }) => {
                        try {
                            const pdfjsLib = (window as any).pdfjsLib;
                            pdfjsLib.GlobalWorkerOptions.workerSrc =
                                'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.9.359/pdf.worker.min.js';

                            const binaryStr = atob(args.b64);
                            const bytes = new Uint8Array(binaryStr.length);
                            for (let i = 0; i < binaryStr.length; i++) {
                                bytes[i] = binaryStr.charCodeAt(i);
                            }

                            const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
                            const totalPages = pdf.numPages;

                            // 页码越界检查
                            const invalidPages = args.pages.filter(p => p < 1 || p > totalPages);
                            if (invalidPages.length > 0) {
                                return {
                                    success: false,
                                    error: `页码 [${invalidPages.join(',')}] 超出范围（该文档共 ${totalPages} 页）`,
                                    totalPages,
                                    renderedPages: [] as number[],
                                    heights: {} as Record<number, number>,
                                    firstPageHeight: 0,
                                };
                            }

                            const container = document.getElementById('pdf-container')!;
                            container.innerHTML = '';

                            const heights: Record<number, number> = {};
                            const texts: Record<number, string> = {};

                            // 按需渲染指定页，每页独立 canvas 带唯一 id
                            for (const pageNum of args.pages) {
                                const pdfPage = await pdf.getPage(pageNum);
                                const defaultViewport = pdfPage.getViewport({ scale: 1.0 });
                                const scale = args.viewportWidth / defaultViewport.width;
                                const viewport = pdfPage.getViewport({ scale });

                                const canvas = document.createElement('canvas');
                                canvas.id = `pdf-page-${pageNum}`;
                                canvas.width = viewport.width;
                                canvas.height = viewport.height;
                                container.appendChild(canvas);
                                heights[pageNum] = viewport.height;

                                const ctx = canvas.getContext('2d');
                                await pdfPage.render({ canvasContext: ctx, viewport }).promise;

                                // 提取文本层
                                try {
                                    const textContent = await pdfPage.getTextContent();
                                    const pageText = textContent.items
                                        .map((item: any) => item.str || '')
                                        .join('')
                                        .replace(/\s+/g, ' ')
                                        .trim();
                                    if (pageText.length > 0) {
                                        texts[pageNum] = pageText;
                                    }
                                } catch { /* 文本提取失败不影响截图 */ }
                            }

                            // 暴露页码信息供调用方读取
                            (window as any).__mcpPdfInfo = {
                                totalPages,
                                currentPage: args.pages[0],
                                renderedPages: args.pages,
                                heights,
                                texts,
                                // goToPage: 重新渲染指定页（供 batch-screenshot 多页切换用）
                                goToPage: async (targetPage: number) => {
                                    if (targetPage < 1 || targetPage > totalPages) return;
                                    const container = document.getElementById('pdf-container')!;
                                    container.innerHTML = '';
                                    const pdfPage = await pdf.getPage(targetPage);
                                    const defaultViewport = pdfPage.getViewport({ scale: 1.0 });
                                    const scale = args.viewportWidth / defaultViewport.width;
                                    const viewport = pdfPage.getViewport({ scale });
                                    const canvas = document.createElement('canvas');
                                    canvas.id = `pdf-page-${targetPage}`;
                                    canvas.width = viewport.width;
                                    canvas.height = viewport.height;
                                    container.appendChild(canvas);
                                    const ctx = canvas.getContext('2d');
                                    await pdfPage.render({ canvasContext: ctx, viewport }).promise;
                                    (window as any).__mcpPdfInfo.currentPage = targetPage;
                                    (window as any).__mcpPdfInfo.heights[targetPage] = viewport.height;
                                },
                            };

                            return {
                                success: true,
                                totalPages,
                                renderedPages: args.pages,
                                heights,
                                firstPageHeight: heights[args.pages[0]] || 0,
                                texts,
                            };
                        } catch (err: any) {
                            return {
                                success: false, error: err.message || String(err),
                                totalPages: 0, renderedPages: [] as number[],
                                heights: {} as Record<number, number>, firstPageHeight: 0,
                            };
                        }
                    }, { b64: pdfBase64, pages: requestedPages, viewportWidth: 1920 });

                    if (!renderResult.success) {
                        throw new Error(`PDF 渲染失败: ${renderResult.error}`);
                    }

                    // 调整页面视口高度匹配第一页高度（单页截图用）
                    await page.setViewportSize({
                        width: 1920,
                        height: Math.round(renderResult.firstPageHeight || 1080),
                    });

                    await page.waitForTimeout(300);
                    console.error(`[web-fetcher] PDF 渲染完成: ${renderResult.renderedPages.length}页 [${renderResult.renderedPages.join(',')}] / 共${renderResult.totalPages}页`);
                } else if (fileCategory === 'image') {
                    // 图片文件：用 <img> 标签显示
                    const imgPath = decodeURIComponent(url.replace(/^file:\/\/\/?/, ''));
                    const imgBuffer = fs.readFileSync(imgPath);
                    const ext = path.extname(imgPath).toLowerCase();
                    const mimeMap: Record<string, string> = {
                        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
                        '.png': 'image/png', '.gif': 'image/gif',
                        '.webp': 'image/webp', '.svg': 'image/svg+xml',
                        '.bmp': 'image/bmp', '.ico': 'image/x-icon',
                    };
                    const mime = mimeMap[ext] || 'image/png';
                    const b64 = imgBuffer.toString('base64');
                    await page.setContent(`
                        <!DOCTYPE html>
                        <html><head><style>
                            html, body { margin: 0; padding: 0; width: 100vw; height: 100vh; overflow: hidden; background: #fff; display: flex; justify-content: center; align-items: center; }
                            img { max-width: 100vw; max-height: 100vh; object-fit: contain; }
                        </style></head>
                        <body><img src="data:${mime};base64,${b64}" /></body></html>
                    `, { waitUntil: 'load' });
                    await page.waitForTimeout(300);
                } else {
                    // HTML / Markdown / 纯文本 / 其它
                    const localFilePath = decodeURIComponent(url.replace(/^file:\/\/\/?/, ''));
                    const localExt = path.extname(localFilePath).toLowerCase();

                    // 多文件项目检测：HTML 文件 + 同目录有 .js/.css → 用临时 HTTP 服务器
                    if ((localExt === '.html' || localExt === '.htm') && localFilePath) {
                        const { isMultiFileProject, serveDirectory } = await import('./local-server.js');
                        if (isMultiFileProject(localFilePath)) {
                            const dir = path.dirname(localFilePath);
                            const fileName = path.basename(localFilePath);
                            const { url: serverUrl } = await serveDirectory(dir);
                            const httpUrl = `${serverUrl}/${fileName}`;
                            console.error(`[web-fetcher] 多文件项目检测 → HTTP 服务: ${httpUrl}`);
                            await page.goto(httpUrl, {
                                waitUntil: "domcontentloaded",
                                timeout,
                            });
                            await page.waitForTimeout(500);
                        } else {
                            await page.goto(url, { waitUntil: "domcontentloaded", timeout });
                            await page.waitForTimeout(500);
                        }
                    } else if (localExt === '.md' || localExt === '.markdown') {
                        // Markdown 文件：渲染为 HTML
                        const mdContent = fs.readFileSync(localFilePath, 'utf-8');
                        const escapedMd = JSON.stringify(mdContent);
                        await page.setContent(`
                            <!DOCTYPE html>
                            <html><head>
                            <style>
                                body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; 
                                       max-width: 900px; margin: 0 auto; padding: 40px 20px; color: #1f2328; line-height: 1.6; background: #fff; }
                                h1 { font-size: 2em; border-bottom: 1px solid #d1d9e0; padding-bottom: .3em; }
                                h2 { font-size: 1.5em; border-bottom: 1px solid #d1d9e0; padding-bottom: .3em; }
                                h3 { font-size: 1.25em; }
                                code { background: #eff1f3; padding: 0.2em 0.4em; border-radius: 6px; font-size: 85%; font-family: 'SFMono-Regular', Consolas, monospace; }
                                pre { background: #f6f8fa; padding: 16px; border-radius: 6px; overflow-x: auto; }
                                pre code { background: none; padding: 0; }
                                blockquote { border-left: 4px solid #d1d9e0; padding: 0 16px; color: #656d76; margin: 0 0 16px 0; }
                                table { border-collapse: collapse; width: 100%; }
                                th, td { border: 1px solid #d1d9e0; padding: 6px 13px; }
                                th { background: #f6f8fa; font-weight: 600; }
                                img { max-width: 100%; }
                                a { color: #0969da; text-decoration: none; }
                                hr { border: none; border-top: 1px solid #d1d9e0; margin: 24px 0; }
                                ul, ol { padding-left: 2em; }
                                li { margin: 0.25em 0; }
                            </style>
                            <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
                            </head>
                            <body><div id="content">正在渲染 Markdown...</div>
                            <script>
                                document.getElementById('content').innerHTML = marked.parse(${escapedMd});
                            </script>
                            </body></html>
                        `, { waitUntil: 'load' });
                        await page.waitForTimeout(500);
                        console.error(`[web-fetcher] Markdown 渲染完成: ${path.basename(localFilePath)}`);
                    } else {
                        await page.goto(url, { waitUntil: "domcontentloaded", timeout });
                        await page.waitForTimeout(500);
                    }
                }

                if (options?.scrollCount && options.scrollCount > 0) {
                    await this.scrollPage(page, options.scrollCount);
                }

                return page;
            } catch (error) {
                await page.close().catch(() => { });
                throw error;
            }
        }

        // ========== 域名级请求限速 ==========
        const domain = this.extractDomain(url);
        const isHighRisk = this.isHighRiskDomain(domain);
        const lastReq = this.domainLastRequest.get(domain);
        if (lastReq) {
            const elapsed = Date.now() - lastReq;
            const cooldown = isHighRisk ? DOMAIN_REQUEST_COOLDOWN * 2 : DOMAIN_REQUEST_COOLDOWN;
            if (elapsed < cooldown) {
                const wait = cooldown - elapsed + Math.random() * 500;
                console.error(`[web-fetcher] 域名限速：${domain} 等待 ${Math.round(wait)}ms`);
                await new Promise(r => setTimeout(r, wait));
            }
        }
        this.domainLastRequest.set(domain, Date.now());

        // ========== 设置真实浏览器 Headers ==========
        await page.setExtraHTTPHeaders({
            ...BROWSER_ACCEPT_HEADERS,
            // 高风控站点加 Referer，模拟从站内导航
            ...(isHighRisk ? { 'Referer': `https://${domain}/` } : {}),
        });

        // ========== 资源层兼容性拦截 ==========
        // 解决无头浏览器 CDN 资源加载问题：
        //   1. 移除 SRI integrity → 防止 CDN 指纹差异导致 hash 不匹配（如 DeepSeek）
        //   2. 移除 CSP → 防止 Content-Security-Policy 干扰 stealth 注入脚本
        //   3. 移除 X-Frame-Options → 改善 iframe 兼容性
        await page.route('**/*', async (route) => {
            try {
                const response = await route.fetch();
                const contentType = response.headers()['content-type'] || '';

                if (contentType.includes('text/html')) {
                    // v5.2: GBK/GB2312 编码检测与转码
                    // 检查 Content-Type 是否声明了 GBK/GB2312 字符集
                    const charsetMatch = contentType.match(/charset\s*=\s*([\w-]+)/i);
                    const declaredCharset = charsetMatch ? charsetMatch[1].toLowerCase() : '';
                    const isGBK = declaredCharset.startsWith('gb') || declaredCharset === 'gbk' || declaredCharset === 'gb2312';

                    let body: string;
                    if (isGBK) {
                        // GBK 站点：用 iconv-lite 从原始字节解码
                        const rawBody = await response.body();
                        body = iconv.decode(rawBody, declaredCharset || 'gbk');
                    } else {
                        body = await response.text();
                        // 如果 HTTP 头没声明但 HTML meta 声明了 GBK，也做转码
                        if (!declaredCharset) {
                            const metaMatch = body.substring(0, 2048).match(/charset\s*=\s*["']?(gb[\w-]*)/i);
                            if (metaMatch) {
                                // meta 声明 GBK 但 response.text() 已按 UTF-8 解码（大概率乱码）
                                // 重新用原始字节解码
                                const rawBody = await response.body();
                                body = iconv.decode(rawBody, metaMatch[1]);
                            }
                        }
                    }

                    // 移除 SRI integrity 属性（防止 CDN 返回内容与 hash 不匹配）
                    body = body.replace(/\s+integrity="[^"]*"/g, '');
                    // 移除 nonce 属性（某些 CSP 策略依赖 nonce 限制脚本执行）
                    body = body.replace(/\s+nonce="[^"]*"/g, '');

                    // 清理限制性 HTTP headers
                    const headers = { ...response.headers() };
                    delete headers['content-security-policy'];
                    delete headers['content-security-policy-report-only'];
                    delete headers['x-frame-options'];
                    delete headers['content-length'];
                    // 更新 charset 为 UTF-8（已转码）
                    if (isGBK && headers['content-type']) {
                        headers['content-type'] = headers['content-type']
                            .replace(/charset\s*=\s*[\w-]+/gi, 'charset=utf-8');
                    }

                    await route.fulfill({ response, body, headers });
                } else {
                    // 非 HTML 资源直接透传
                    await route.fulfill({ response });
                }
            } catch {
                // 拦截失败则放行原始请求
                await route.continue();
            }
        });

        // 网络导航（带瞬时故障自动重试）
        let navigationAttempt = 0;
        const maxNavigationAttempts = 2;
        let lastNavigationError: unknown = null;

        while (navigationAttempt < maxNavigationAttempts) {
            try {
                const currentTimeout = navigationAttempt === 0 ? timeout : Math.min(timeout * 2, 120000);

                await page.goto(url, {
                    waitUntil: "domcontentloaded",
                    timeout: currentTimeout,
                });

                // networkidle 用短超时（5s），SPA 有 WebSocket 等持续连接永远不会 idle
                await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {
                    console.error("[web-fetcher] networkidle 5s 未达到，继续处理");
                });

                // 智能内容就绪检测：等待 DOM 稳定 + iframe 加载
                await this.waitForContentReady(page, currentTimeout);
                lastNavigationError = null;
                break; // 成功，跳出重试循环
            } catch (navErr) {
                lastNavigationError = navErr;
                navigationAttempt++;

                if (navigationAttempt < maxNavigationAttempts && this.isTransientError(navErr)) {
                    this.lastRetryCount++;
                    const retryDelay = 3000;
                    console.error(`[web-fetcher] ⚡ 导航瞬时故障 (${navErr instanceof Error ? navErr.message.slice(0, 60) : navErr})，${retryDelay / 1000}秒后重试...`);
                    await page.waitForTimeout(retryDelay);
                } else {
                    throw navErr; // 确定性错误或已用完重试次数
                }
            }
        }
        if (lastNavigationError) throw lastNavigationError;

        try {

            // 如果指定了等待选择器
            if (options?.waitFor) {
                await page.waitForSelector(options.waitFor, { timeout });
            }

            // 反爬随机延迟（高风控站点用更大延迟范围）
            const delayMin = isHighRisk ? HIGH_RISK_DELAY_MIN : ANTI_BOT_DELAY_MIN;
            const delayMax = isHighRisk ? HIGH_RISK_DELAY_MAX : ANTI_BOT_DELAY_MAX;
            const delay = delayMin + Math.random() * (delayMax - delayMin);
            await page.waitForTimeout(delay);

            // 更新请求时间
            this.domainLastRequest.set(domain, Date.now());

            // 滚动加载
            if (options?.scrollCount && options.scrollCount > 0) {
                await this.scrollPage(page, options.scrollCount);
            }

            return page;
        } catch (error) {
            await page.close().catch(() => { });
            throw error;
        }
    }

    /**
     * 从 URL 提取主域名（用于限速）
     */
    private extractDomain(url: string): string {
        try {
            const hostname = new URL(url).hostname;
            // 提取主域名（如 www.reddit.com → reddit.com）
            const parts = hostname.split('.');
            if (parts.length > 2) {
                return parts.slice(-2).join('.');
            }
            return hostname;
        } catch {
            return 'unknown';
        }
    }

    /**
     * 判断是否为高风控域名
     */
    private isHighRiskDomain(domain: string): boolean {
        return HIGH_RISK_DOMAINS.some(d => domain === d || domain.endsWith('.' + d));
    }

    /**
     * 智能内容就绪检测：等待 DOM 稳定（元素数量不再增长）+ iframe 加载
     * 解决 SPA / iframe 页面（如网易云音乐）在 networkidle 后内容仍未渲染的问题
     */
    private async waitForContentReady(
        page: Page,
        timeout: number
    ): Promise<void> {
        const maxWait = Math.min(timeout, 8000); // 最多额外等 8 秒
        const checkInterval = 500; // 每 500ms 检查一次
        const stableThreshold = 2; // 连续 2 次不变则认为稳定

        let stableCount = 0;
        let lastElementCount = 0;
        const startTime = Date.now();

        try {
            while (Date.now() - startTime < maxWait) {
                const currentCount = await page.evaluate(() => {
                    const selector = "img, video, p, h1, h2, h3, h4, span, a, li, td, article, section";
                    let visibleCount = 0;

                    // 统计主文档可见元素
                    const mainEls = document.querySelectorAll(selector);
                    mainEls.forEach((el) => {
                        const rect = (el as HTMLElement).getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0) visibleCount++;
                    });

                    // 同时统计同域 iframe 内的可见元素
                    try {
                        const iframes = document.querySelectorAll("iframe");
                        for (const iframe of iframes) {
                            try {
                                const iframeDoc = (iframe as HTMLIFrameElement).contentWindow?.document;
                                if (iframeDoc) {
                                    const iframeEls = iframeDoc.querySelectorAll(selector);
                                    iframeEls.forEach((el) => {
                                        const rect = (el as HTMLElement).getBoundingClientRect();
                                        if (rect.width > 0 && rect.height > 0) visibleCount++;
                                    });
                                }
                            } catch { /* 跨域 iframe 跳过 */ }
                        }
                    } catch { /* 忽略 */ }

                    return visibleCount;
                });

                if (currentCount === lastElementCount && currentCount > 0) {
                    stableCount++;
                    if (stableCount >= stableThreshold) {
                        console.error(
                            `[web-fetcher] DOM 稳定: ${currentCount} 个可见元素，${Date.now() - startTime}ms`
                        );
                        break;
                    }
                } else {
                    stableCount = 0;
                }
                lastElementCount = currentCount;

                await page.waitForTimeout(checkInterval);
            }

            // 额外检查 iframe 是否加载
            const iframeCount = await page.evaluate(
                () => document.querySelectorAll("iframe").length
            );
            if (iframeCount > 0) {
                // 等待所有 iframe load 事件（最多 3 秒）
                await page.evaluate(() => {
                    return new Promise<void>((resolve) => {
                        const iframes = document.querySelectorAll("iframe");
                        let loaded = 0;
                        const total = iframes.length;
                        const timer = setTimeout(resolve, 3000);

                        iframes.forEach((iframe) => {
                            if ((iframe as HTMLIFrameElement).contentDocument?.readyState === "complete") {
                                loaded++;
                            } else {
                                iframe.addEventListener("load", () => {
                                    loaded++;
                                    if (loaded >= total) {
                                        clearTimeout(timer);
                                        resolve();
                                    }
                                });
                            }
                        });

                        if (loaded >= total) {
                            clearTimeout(timer);
                            resolve();
                        }
                    });
                }).catch(() => {
                    // 跨域 iframe 无法访问 contentDocument，忽略
                });
                console.error(
                    `[web-fetcher] ${iframeCount} 个 iframe 加载检查完成`
                );
            }
        } catch {
            // 检测过程出错不影响主流程
            console.error("[web-fetcher] 内容就绪检测出错，继续处理");
        }
    }

    /**
     * 滚动页面以触发懒加载内容
     */
    async scrollPage(page: Page, count: number): Promise<void> {
        for (let i = 0; i < count; i++) {
            const prevHeight = await page.evaluate(() => document.body.scrollHeight);

            await page.evaluate(() =>
                window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" })
            );

            // 等待新内容加载
            await page.waitForTimeout(1500);

            // 如果有 networkidle 就等一下
            await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => { });

            const newHeight = await page.evaluate(() => document.body.scrollHeight);

            console.error(
                `[web-fetcher] 滚动 ${i + 1}/${count}，页面高度: ${prevHeight} → ${newHeight}`
            );

            // 如果页面高度没变，说明已经到底了
            if (newHeight === prevHeight) {
                console.error("[web-fetcher] 页面已滚动到底部，停止滚动");
                break;
            }
        }
    }

    /**
     * 获取浏览器上下文中的 cookies
     */
    async getCookies(domain?: string): Promise<
        Array<{
            name: string;
            domain: string;
            path: string;
            expires: number;
            httpOnly: boolean;
            secure: boolean;
            sameSite: string;
        }>
    > {
        const context = await this.getContext();
        const cookies = await context.cookies();

        let filtered = cookies;
        if (domain) {
            filtered = cookies.filter(
                (c) => c.domain === domain || c.domain === `.${domain}` || c.domain.endsWith(`.${domain}`)
            );
        }

        // 返回去除实际值的 cookie 信息
        return filtered.map((c) => ({
            name: c.name,
            domain: c.domain,
            path: c.path,
            expires: c.expires,
            httpOnly: c.httpOnly,
            secure: c.secure,
            sameSite: c.sameSite,
        }));
    }

    /**
     * 以有头模式启动浏览器，让用户登录
     */
    async launchLoginMode(): Promise<void> {
        // 关闭现有无头浏览器
        await this.close();

        console.error("[web-fetcher] 启动有头浏览器进行登录...");

        const context = await chromium.launchPersistentContext(
            BROWSER_USER_DATA_DIR,
            {
                headless: false,
                userAgent: DEFAULT_USER_AGENT,
                viewport: { width: 1920, height: 1080 },
                locale: "zh-CN",
                timezoneId: "Asia/Shanghai",
                args: [
                    "--disable-blink-features=AutomationControlled",
                    "--no-first-run",
                    "--no-default-browser-check",
                ],
            }
        );

        // 打开一个空白页
        const page = await context.newPage();
        await page.goto("about:blank");

        console.error("[web-fetcher] 有头浏览器已启动，等待用户关闭浏览器...");

        // 等待浏览器关闭
        await new Promise<void>((resolve) => {
            // 浏览器关闭前尝试保存 Cookie
            context.on("close", () => resolve());
        });

        // 保存 Cookie 备份（使用关闭前的 context 可能已不可用，
        // 所以我们在页面导航后定时保存）
        console.error("[web-fetcher] 用户已关闭浏览器，登录完成");
        this.context = null;
    }

    /**
     * 保存当前所有 Cookie 到备份文件
     */
    async saveCookies(): Promise<void> {
        if (!this.context) return;

        try {
            const cookies = await this.context.cookies();
            fs.writeFileSync(
                COOKIES_BACKUP_FILE,
                JSON.stringify(cookies, null, 2),
                "utf-8"
            );
            console.error(`[web-fetcher] Cookie 已备份: ${cookies.length} 个 → ${COOKIES_BACKUP_FILE}`);
        } catch (error) {
            console.error("[web-fetcher] Cookie 备份失败:", error);
        }
    }

    /**
     * 从备份文件恢复 Cookie
     */
    private async restoreCookies(context: BrowserContext): Promise<void> {
        if (!fs.existsSync(COOKIES_BACKUP_FILE)) {
            console.error("[web-fetcher] 没有 Cookie 备份文件，跳过恢复");
            return;
        }

        try {
            const data = fs.readFileSync(COOKIES_BACKUP_FILE, "utf-8");
            const cookies = JSON.parse(data);

            if (Array.isArray(cookies) && cookies.length > 0) {
                await context.addCookies(cookies);
                console.error(`[web-fetcher] Cookie 已恢复: ${cookies.length} 个`);
            }
        } catch (error) {
            console.error("[web-fetcher] Cookie 恢复失败:", error);
        }
    }

    /**
     * 关闭浏览器
     */
    async close(): Promise<void> {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
        if (this.context) {
            try {
                await this.context.close();
            } catch {
                // 忽略关闭错误
            }
            this.context = null;
        }
        console.error("[web-fetcher] 浏览器已关闭");
    }

    /**
     * 仅关闭浏览器释放内存，MCP 进程继续运行
     * 下次 getContext() 调用时会自动重新启动浏览器
     */
    async closeBrowser(): Promise<void> {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
        if (this.context) {
            try {
                // 备份 Cookie 再关闭
                await this.saveCookies();
                await this.context.close();
            } catch {
                // 忽略关闭错误
            }
            this.context = null;
            this.activePages = 0;
            console.error("[web-fetcher] 浏览器空闲超时，已关闭释放内存");
        }
    }

    /**
     * 重置浏览器空闲超时计时器
     */
    private resetIdleTimer(): void {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
        }
        this.idleTimer = setTimeout(() => {
            this.closeBrowser();
        }, BrowserManager.BROWSER_IDLE_TIMEOUT);
    }

    /**
     * 清理 Profile 中的非关键缓存目录
     * 保留 Cookies、Local Storage、IndexedDB 等登录态相关数据
     * 注意：必须在浏览器启动前调用（运行时目录被锁定无法删除）
     */
    private cleanProfileCache(): void {
        const SAFE_CLEAN_DIRS = [
            "Service Worker",
            "Cache",
            "Code Cache",
            "GPUCache",
            "GrShaderCache",
            "ShaderCache",
            "DawnGraphiteCache",
            "DawnWebGPUCache",
            "blob_storage",
            "Session Storage",
            "Crashpad",
            "BrowserMetrics",
            "WebStorage",
            "shared_proto_db",
            "optimization_guide_model_store",
            "component_crx_cache",
        ];

        let cleanedCount = 0;

        const cleanDir = (basePath: string) => {
            for (const dirName of SAFE_CLEAN_DIRS) {
                const dirPath = path.join(basePath, dirName);
                try {
                    if (fs.existsSync(dirPath)) {
                        fs.rmSync(dirPath, { recursive: true, force: true });
                        cleanedCount++;
                    }
                } catch {
                    // 权限问题，跳过
                }
            }
        };

        cleanDir(BROWSER_USER_DATA_DIR);
        const defaultDir = path.join(BROWSER_USER_DATA_DIR, "Default");
        if (fs.existsSync(defaultDir)) {
            cleanDir(defaultDir);
        }

        if (cleanedCount > 0) {
            console.error(
                `[web-fetcher] Profile 缓存已清理: ${cleanedCount} 个目录`
            );
        }
    }
}

// 导出单例
export const browserManager = new BrowserManager();

// 注意: 进程退出清理已在 index.ts 中统一处理，此处不再注册重复的事件处理器
