/**
 * stealth.ts — 反检测脚本集合 v6.3
 * 
 * 包含 18 层 stealth 防护，覆盖 25+ 检测向量。
 * 通过 context.addInitScript() 注入到每个页面加载前。
 * 
 * v6.3: 版本号/GPU 参数化，从 constants.ts 统一管理
 * 
 * 层级说明：
 *   Layer 1-9:   Navigator 属性覆盖（webdriver/plugins/languages/etc）
 *   Layer 10-11: 音频/Canvas 指纹降噪
 *   Layer 12:    Google Credential Management API + Permissions 扩展
 *   Layer 13:    navigator.userAgentData (Client Hints)
 *   Layer 14:    WebGL 扩展列表伪装
 *   Layer 15:    字体指纹保护
 *   Layer 16:    Function.prototype.toString 全局拦截
 *   Layer 17:    Playwright DOM 属性实时清除
 *   Layer 18:    高级 CDP 痕迹处理
 */

/**
 * Stealth 降级等级：
 *   Level 3 (默认): 完整 18 层防护
 *   Level 2 (安全): 跳过 speechSynthesis.getVoices 和 measureText 劫持（兼容高级 WAF）
 *   Level 1 (裸奔): 不注入任何 stealth 脚本（靠 --headless=new 原生穿透）
 */
export type StealthLevel = 1 | 2 | 3;

export interface StealthConfig {
    chromeVersion: string;
    chromeFullVersion: string;
    brands: Array<{ brand: string; version: string }>;
    fullVersionList: Array<{ brand: string; version: string }>;
    webglVendor: string;
    webglRenderer: string;
    /** Stealth 降级等级，默认 3（完整防护） */
    level?: StealthLevel;
}

/**
 * 生成 stealth 注入脚本
 * @param config Chrome 版本号/GPU 等配置，从 constants.ts 统一传入
 * @param config.level 降级等级：3=完整, 2=安全模式(跳过高危Hook), 1=裸奔(空脚本)
 */
export function getStealthScript(config: StealthConfig): string {
    const level = config.level ?? 3;
    const { chromeVersion, chromeFullVersion, brands, fullVersionList, webglVendor, webglRenderer } = config;

    // Level 1: 裸奔模式 — 不注入任何脚本
    if (level === 1) return '/* stealth level 1: bare mode */';

    // 基础脚本（Level 2 + Level 3 共用）
    let script = `
        // ==========================================
        //  Layer 1: Navigator 属性覆盖
        // ==========================================

        // 1. 原 raw webdriver 配置已移除
        // 使用 Playwright ignoreDefaultArgs: ['--enable-automation'] 已原生覆盖，手动修改反遭 Sannysoft 检测

        // 2. navigator.languages
        Object.defineProperty(navigator, 'languages', {
            get: () => ['zh-CN', 'zh', 'en-US', 'en'],
        });

        // 3. navigator.plugins — 通过 instanceof PluginArray 检测
        Object.defineProperty(navigator, 'plugins', {
            get: () => {
                const makePlugin = (name, desc, filename, mimes) => {
                    const plugin = { name, description: desc, filename, length: mimes.length };
                    mimes.forEach((m, i) => { plugin[i] = m; });
                    plugin[Symbol.iterator] = function*() { for (let i = 0; i < this.length; i++) yield this[i]; };
                    Object.setPrototypeOf(plugin, Plugin.prototype);
                    return plugin;
                };
                const pluginList = [
                    makePlugin('Chrome PDF Plugin', 'Portable Document Format', 'internal-pdf-viewer',
                        [{ type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format' }]),
                    makePlugin('Chrome PDF Viewer', '', 'mhjfbmdgcfjbbpaeojofohoefgiehjai',
                        [{ type: 'application/pdf', suffixes: 'pdf', description: '' }]),
                    makePlugin('Native Client', '', 'internal-nacl-plugin', [
                        { type: 'application/x-nacl', suffixes: '', description: 'Native Client Executable' },
                        { type: 'application/x-pnacl', suffixes: '', description: 'Portable Native Client Executable' },
                    ]),
                ];
                // 用 Proxy 包装，既能通过 instanceof PluginArray 又支持数字索引/length/item/namedItem
                const handler = {
                    get(target, prop) {
                        if (prop === 'length') return target.length;
                        if (prop === Symbol.iterator) return function*() { for (const p of target) yield p; };
                        if (prop === 'item') return (i) => target[i] || null;
                        if (prop === 'namedItem') return (name) => target.find(p => p.name === name) || null;
                        if (prop === 'refresh') return () => {};
                        if (typeof prop === 'string' && /^\\d+$/.test(prop)) return target[parseInt(prop)];
                        return Reflect.get(target, prop);
                    },
                };
                const proxy = new Proxy(pluginList, handler);
                Object.setPrototypeOf(proxy, PluginArray.prototype);
                return proxy;
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
            if (param === 0x9245) return ${JSON.stringify(config.webglVendor)};
            // UNMASKED_RENDERER_WEBGL
            if (param === 0x9246) return ${JSON.stringify(config.webglRenderer)};
            return getParameter.call(this, param);
        };
        // WebGL2 也需要覆盖
        if (typeof WebGL2RenderingContext !== 'undefined') {
            const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
            WebGL2RenderingContext.prototype.getParameter = function(param) {
                if (param === 0x9245) return ${JSON.stringify(config.webglVendor)};
                if (param === 0x9246) return ${JSON.stringify(config.webglRenderer)};
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
        // ⚠️ Level 2 安全模式跳过：此劫持会触发高级 WAF 的 JS 一致性校验
`;

    // === Level 3 专属块 1: speechSynthesis.getVoices 劫持 ===
    if (level === 3) {
        script += `
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
`;
    }

    // 继续共用代码
    script += `

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
                    brands: ${JSON.stringify(config.brands)},
                    mobile: false,
                    platform: 'Windows',
                    getHighEntropyValues: (hints) => Promise.resolve({
                        brands: ${JSON.stringify(config.brands)},
                        mobile: false,
                        platform: 'Windows',
                        platformVersion: '15.0.0',
                        architecture: 'x86',
                        bitness: '64',
                        model: '',
                        uaFullVersion: ${JSON.stringify(config.chromeFullVersion)},
                        fullVersionList: ${JSON.stringify(config.fullVersionList)},
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
        // ⚠️ Level 2 安全模式跳过 measureText 劫持：此劫持会触发高级 WAF 的稳定性校验
`;

    // === Level 3 专属块 2: measureText 字体指纹劫持 ===
    if (level === 3) {
        script += `
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
`;
    }

    // 继续共用代码：Layer 16+
    script += `

        // ==========================================
        //  Layer 16: Function.prototype.toString 全局拦截
        //  被覆盖的函数 toString() 应返回 "[native code]" 格式
        // ==========================================
        (function() {
            const nativeFns = new WeakSet();
            const origToString = Function.prototype.toString;

            // 拦截 toString
            Function.prototype.toString = function() {
                if (nativeFns.has(this)) {
                    return 'function ' + (this.name || '') + '() { [native code] }';
                }
                return origToString.call(this);
            };
            // toString 自身也要通过检测
            nativeFns.add(Function.prototype.toString);

            // v6.3: 使用 Symbol 键避免被 Object.keys/getOwnPropertyNames 枚举检测
            const stealthKey = Symbol.for('__stealth__');
            window[stealthKey] = (fn) => { nativeFns.add(fn); return fn; };
            document.addEventListener('DOMContentLoaded', () => {
                setTimeout(() => { try { delete window[stealthKey]; } catch {} }, 50);
            }, { once: true });
        })();

        // ==========================================
        //  Layer 17: Playwright DOM 属性实时清除
        //  用 MutationObserver 监控并清除 data-pw-* 等自动化痕迹
        // ==========================================
        (function() {
            const cleanElement = (el) => {
                if (el && el.attributes) {
                    for (const attr of [...el.attributes]) {
                        if (attr.name.startsWith('data-pw') || attr.name === '__playwright_target__') {
                            el.removeAttribute(attr.name);
                        }
                    }
                }
            };

            // 初始清除
            try { document.querySelectorAll('*').forEach(cleanElement); } catch {}

            // 持续监控
            const observer = new MutationObserver((mutations) => {
                for (const mutation of mutations) {
                    if (mutation.type === 'attributes') {
                        cleanElement(mutation.target);
                    }
                    if (mutation.type === 'childList') {
                        mutation.addedNodes.forEach(node => {
                            if (node.nodeType === 1) {
                                cleanElement(node);
                                try { node.querySelectorAll('*').forEach(cleanElement); } catch {}
                            }
                        });
                    }
                }
            });

            const startObserving = () => {
                if (document.body) {
                    observer.observe(document.body, { attributes: true, childList: true, subtree: true });
                }
            };

            if (document.body) {
                startObserving();
            } else {
                document.addEventListener('DOMContentLoaded', startObserving, { once: true });
            }
        })();

        // ==========================================
        //  Layer 18: 高级 CDP 痕迹处理
        //  清除 Runtime.evaluate 的特征副作用
        // ==========================================
        (function() {
            // 清除空的调试工具全局变量（CDP 注入但内容为空的那些）
            const cdpArtifacts = [
                '__coverage__', '__REACT_DEVTOOLS_GLOBAL_HOOK__',
                '__REDUX_DEVTOOLS_EXTENSION__', '__VUE_DEVTOOLS_GLOBAL_HOOK__',
            ];
            for (const key of cdpArtifacts) {
                if (window[key] && typeof window[key] === 'object' && Object.keys(window[key]).length === 0) {
                    try { delete window[key]; } catch {}
                }
            }

            // 防止 console.debug 泄露自动化痕迹
            const origDebug = console.debug;
            console.debug = function(...args) {
                const str = args.join(' ').toLowerCase();
                if (str.includes('playwright') || str.includes('puppeteer') || str.includes('cdp')) {
                    return;
                }
                return origDebug.apply(console, args);
            };
        })();

    `;

    return script;
}
