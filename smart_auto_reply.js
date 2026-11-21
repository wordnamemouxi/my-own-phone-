/**
 * Smart Auto-Reply Plugin (smart-auto-reply.js)
 * 放置于 index.html 同级目录（或 plugins/ 目录），并在 index.html 的 </body> 前引入：
 * <script src="./smart-auto-reply.js"></script>
 *
 * 功能：
 * 1. 智慧动态主动发消息：AI 根据聊天内容与客观时间，自主决定多久后再主动找你及理由（零额外 API 费用）。
 * 2. 双重防误发：只要你在预约时间前发了任何新消息（文字/图片/语音/拍一拍），旧预约立即作废，绝不重复按旧时间发。
 * 3. 与原版固定间隔融合：保留原版固定间隔作为基础兜底；开启智慧动态时优先按动态排程走（如深夜晚安排明早，不被固定间隔半夜打断）。
 * 4. 原生卡片适配 + 延迟加载防漏注入：无论 IndexedDB 加载多慢，打开聊天设置页都能稳定显示并与当前角色同步。
 */
(() => {
    if (window.__uwuSmartAutoReplyLoaded) return;
    window.__uwuSmartAutoReplyLoaded = true;

    const MIN_MINUTES = 5;
    const MAX_MINUTES = 2880; // 最多 48 小时
    const pendingReasonMap = new Map();

    function getLastUserTimestamp(char) {
        const hist = Array.isArray(char?.history) ? char.history : [];
        for (let i = hist.length - 1; i >= 0; i--) {
            const m = hist[i];
            if (m && m.role === 'user' && !m.isWithdrawn && Number.isFinite(m.timestamp)) {
                return m.timestamp;
            }
        }
        return 0;
    }

    function clearSmartSchedule(char) {
        if (!char?.autoReply) return;
        char.autoReply.nextPingAt = 0;
        char.autoReply.nextPingReason = '';
        char.autoReply.nextPingSetAt = 0;
    }

    // 1. 挂载到 buildLivelyPostscript：注入动态排程指令 / 触发由头
    function hookLivelyPostscript() {
        if (typeof window.buildLivelyPostscript !== 'function' || window.buildLivelyPostscript.__smartWrapped) return;
        const origBuild = window.buildLivelyPostscript;
        const wrapped = function (chat, historySlice) {
            let note = origBuild.apply(this, arguments) || '';
            const extra = [];
            if (chat?.autoReply?.smartEnabled) {
                const pendingReason = pendingReasonMap.get(chat.id);
                if (pendingReason) {
                    pendingReasonMap.delete(chat.id);
                    extra.push(`[本次主动发消息由头] 你之前心里惦记着“${pendingReason}”，现在时间到了自然顺口来找对方聊两句（像真人想起这事一样自然，别生硬照念）。`);
                }
                extra.push('[智慧主动消息排程] 请结合刚才的聊天内容与当前客观时间，自然判断如果对方接下来没主动回你，你大概多少分钟后会再主动找她（以及简短理由）。请在正文最末尾附隐藏标签 [NEXT_PING:分钟数|简短理由]（例如刚说去洗澡可约25分钟、深夜互道晚安可约480分钟到明早、普通日常约120到240分钟；只写整数分钟）。');
            }
            if (extra.length) {
                note = note ? `${note}\n${extra.join('\n')}` : extra.join('\n');
            }
            return note;
        };
        wrapped.__smartWrapped = true;
        window.buildLivelyPostscript = wrapped;
    }

    // 2. 挂载到 handleAiReplyContent：在剥离 <thinking> 后的正文中解析 [NEXT_PING:分钟|理由] 并隐藏标签
    function hookHandleAiReplyContent() {
        if (typeof window.handleAiReplyContent !== 'function' || window.handleAiReplyContent.__smartWrapped) return;
        const origHandle = window.handleAiReplyContent;
        const wrapped = async function (fullResponse, chat, targetChatId, targetChatType, isBackground = false) {
            let cleaned = fullResponse;
            if (typeof cleaned === 'string' && targetChatType === 'private' && chat?.autoReply?.smartEnabled) {
                // 仅检查 </thinking> 之后的正式正文，绝不误触思考过程！
                const thinkEnd = cleaned.lastIndexOf('</thinking>');
                const head = thinkEnd !== -1 ? cleaned.slice(0, thinkEnd + 11) : '';
                let body = thinkEnd !== -1 ? cleaned.slice(thinkEnd + 11) : cleaned;

                const pingMatch = body.match(/\[NEXT_PING:(\d{1,4})(?:\|([^\]]*))?\]/i);
                if (pingMatch) {
                    const rawMins = Number.parseInt(pingMatch[1], 10);
                    const mins = Math.max(MIN_MINUTES, Math.min(MAX_MINUTES, Number.isFinite(rawMins) ? rawMins : 90));
                    const reason = (pingMatch[2] || '').trim().slice(0, 60);
                    const now = Date.now();
                    chat.autoReply ||= {};
                    chat.autoReply.nextPingAt = now + mins * 60 * 1000;
                    chat.autoReply.nextPingReason = reason;
                    chat.autoReply.nextPingSetAt = now;
                    body = body.replace(/\[NEXT_PING:[^\]]+\]/gi, '').trim();
                    cleaned = head + body;
                    if (typeof window.saveData === 'function') {
                        window.saveData().catch(() => {});
                    }
                }
            }
            return origHandle.call(this, cleaned, chat, targetChatId, targetChatType, isBackground);
        };
        wrapped.__smartWrapped = true;
        window.handleAiReplyContent = wrapped;
    }

    // 3. 挂载到 sendMessage：用户一发新消息，立刻作废该角色之前的动态预约
    function hookSendMessage() {
        if (typeof window.sendMessage !== 'function' || window.sendMessage.__smartWrapped) return;
        const origSend = window.sendMessage;
        const wrapped = async function () {
            if (typeof currentChatType !== 'undefined' && currentChatType === 'private' && typeof currentChatId !== 'undefined' && window.db?.characters) {
                const chat = window.db.characters.find(c => c.id === currentChatId);
                if (chat?.autoReply?.nextPingAt) {
                    clearSmartSchedule(chat);
                }
            }
            return origSend.apply(this, arguments);
        };
        wrapped.__smartWrapped = true;
        window.sendMessage = wrapped;
    }

    // 4. 融合原版 checkAutoReply：动态排程优先 + 用户发过消息自动作废 + 固定间隔兜底
    function hookCheckAutoReply() {
        if (typeof window.checkAutoReply !== 'function' || window.checkAutoReply.__smartWrapped) return;
        const wrapped = async function () {
            if (!window.db?.characters) return;
            const now = Date.now();
            for (const char of window.db.characters) {
                const ar = char.autoReply;
                if (!ar || (!ar.enabled && !ar.smartEnabled)) continue;
                if (!Array.isArray(char.history) || char.history.length === 0) continue;

                const lastMsgTime = char.history[char.history.length - 1]?.timestamp || 0;
                const lastUserTime = getLastUserTimestamp(char);

                // 二次防线：如果在 AI 定下动态预约后，用户又发过任何新消息，则旧预约立刻作废！
                if (ar.nextPingAt && ar.nextPingSetAt && lastUserTime > ar.nextPingSetAt) {
                    clearSmartSchedule(char);
                    if (typeof window.saveData === 'function') await window.saveData().catch(() => {});
                }

                // 路径 A：智慧动态排程生效中
                if (ar.smartEnabled && ar.nextPingAt > 0) {
                    if (now < ar.nextPingAt) {
                        // 还没到 AI 约定的动态时间（例如深夜晚安约了明早），跳过固定间隔避免半夜抢发！
                        continue;
                    }
                    // 到达动态预约时间：触发主动发消息
                    const reason = ar.nextPingReason || '';
                    clearSmartSchedule(char);
                    ar.lastTriggerTime = now;
                    if (reason) pendingReasonMap.set(char.id, reason);
                    console.log(`[SmartAutoReply] Dynamic ping triggered for ${char.remarkName || char.realName}: ${reason || 'natural check-in'}`);
                    if (typeof window.saveData === 'function') await window.saveData();
                    if (typeof window.getAiReply === 'function') await window.getAiReply(char.id, 'private', true);
                    continue;
                }

                // 路径 B：固定间隔基础兜底（仅当开启了原版自动发消息开关，且当前无待执行的动态预约时）
                if (ar.enabled) {
                    const intervalMs = (ar.interval || 60) * 60 * 1000;
                    const lastTriggerTime = ar.lastTriggerTime || 0;
                    if (now - lastTriggerTime < intervalMs) continue;
                    if (now - lastMsgTime > intervalMs) {
                        console.log(`[SmartAutoReply] Fallback fixed-interval auto-reply triggered for ${char.remarkName || char.realName}`);
                        ar.lastTriggerTime = now;
                        if (typeof window.saveData === 'function') await window.saveData();
                        if (typeof window.getAiReply === 'function') await window.getAiReply(char.id, 'private', true);
                    }
                }
            }
        };
        wrapped.__smartWrapped = true;
        window.checkAutoReply = wrapped;
    }

    // 5. 挂载到 injectChatSettingsHtml：每次聊天设置页模板注入后立刻挂载原生功能卡片
    function hookInjectChatSettingsHtml() {
        if (typeof window.injectChatSettingsHtml !== 'function' || window.injectChatSettingsHtml.__smartWrapped) return;
        const origInject = window.injectChatSettingsHtml;
        const wrapped = function () {
            const ret = origInject.apply(this, arguments);
            injectSmartSettingsUI();
            return ret;
        };
        wrapped.__smartWrapped = true;
        window.injectChatSettingsHtml = wrapped;
    }

    function syncUiFromChar() {
        const swInput = document.getElementById('setting-smart-auto-reply-enabled');
        const statusLine = document.getElementById('smart-auto-reply-status');
        if (!swInput || !statusLine) return;
        if (typeof currentChatId === 'undefined' || !window.db?.characters) return;
        const ch = window.db.characters.find(c => c.id === currentChatId);
        if (!ch) return;
        swInput.checked = ch.autoReply?.smartEnabled === true;
        if (ch.autoReply?.smartEnabled && ch.autoReply?.nextPingAt > Date.now()) {
            const d = new Date(ch.autoReply.nextPingAt);
            const tStr = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
            const reason = ch.autoReply.nextPingReason ? `（${ch.autoReply.nextPingReason}）` : '';
            statusLine.innerHTML = '';
            const span = document.createElement('span');
            span.textContent = `下次预计：${tStr}${reason}`;
            const cancelBtn = document.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.textContent = '取消';
            cancelBtn.className = 'uwu-smart-cancel-btn';
            cancelBtn.style.cssText = 'font-size:11px;padding:1px 6px;border-radius:6px;border:1px solid #ccc;background:#fff;cursor:pointer;margin-left:6px;flex-shrink:0;';
            cancelBtn.onclick = async (e) => {
                e.stopPropagation();
                clearSmartSchedule(ch);
                if (typeof window.saveData === 'function') await window.saveData();
                syncUiFromChar();
            };
            statusLine.append(span, cancelBtn);
        } else {
            const nextTxt = swInput.checked ? '已开启 · 按聊天与时间自动约下次联系' : '关闭 · 仅用原版固定间隔'; if (statusLine.textContent !== nextTxt) statusLine.textContent = nextTxt;
        }
    }

    // 6. 自动在角色聊天设置页注入原生样式的「智慧主动消息」功能卡片
    function injectSmartSettingsUI() {
        const baseSwitch = document.getElementById('setting-auto-reply-enabled');
        if (!baseSwitch) return false;
        if (document.getElementById('setting-smart-auto-reply-enabled')) {
            syncUiFromChar();
            return true;
        }

        const featureCard = baseSwitch.closest('.feature-card');
        const fallbackItem = baseSwitch.closest('.kkt-item') || baseSwitch.closest('.form-group');
        const anchor = featureCard || fallbackItem;
        if (!anchor || !anchor.parentElement) return false;

        let card;
        if (featureCard) {
            // 原生 feature-card 网格卡片风格，与「自动消息」并排显示，完美适配手机端与全局 CSS
            card = document.createElement('div');
            card.className = 'feature-card uwu-smart-autoreply-row';
            card.id = 'smart-auto-reply-setting-row';
            card.dataset.feature = 'smart-auto-reply';
            card.innerHTML = `
                <div class="feature-card-header">
                    <div class="feature-card-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
                    </div>
                    <label class="kkt-switch">
                        <input type="checkbox" id="setting-smart-auto-reply-enabled">
                        <span class="kkt-slider"></span>
                    </label>
                </div>
                <div class="feature-card-body">
                    <div class="feature-card-title">智慧主动消息</div>
                    <div class="feature-card-desc" id="smart-auto-reply-status">关闭 · 仅用原版固定间隔</div>
                </div>
            `;
        } else {
            // 兼容非卡片布局的兜底样式
            card = document.createElement('div');
            card.className = 'kkt-item uwu-smart-autoreply-row';
            card.id = 'smart-auto-reply-setting-row';
            card.innerHTML = `
                <div class="kkt-item-content">
                    <div class="kkt-item-title">智慧主动消息</div>
                    <div class="kkt-item-subtitle" id="smart-auto-reply-status">关闭 · 仅用原版固定间隔</div>
                </div>
                <label class="kkt-switch">
                    <input type="checkbox" id="setting-smart-auto-reply-enabled">
                    <span class="kkt-slider"></span>
                </label>
            `;
        }

        anchor.parentElement.insertBefore(card, anchor.nextSibling);

        const swInput = document.getElementById('setting-smart-auto-reply-enabled');
        swInput.addEventListener('change', async () => {
            if (typeof currentChatId === 'undefined' || !window.db?.characters) return;
            const ch = window.db.characters.find(c => c.id === currentChatId);
            if (!ch) return;
            ch.autoReply ||= { enabled: false, interval: 60, lastTriggerTime: 0 };
            ch.autoReply.smartEnabled = swInput.checked;
            if (!swInput.checked) clearSmartSchedule(ch);
            if (typeof window.saveData === 'function') await window.saveData();
            syncUiFromChar();
        });

        syncUiFromChar();
        return true;
    }

    function observeSettingsScreen() {
        const settingsScreen = document.getElementById('chat-settings-screen');
        if (!settingsScreen || settingsScreen.__smartObserved) return;
        settingsScreen.__smartObserved = true;
        const obs = new MutationObserver(() => {
            if (!document.getElementById('setting-smart-auto-reply-enabled')) {
                injectSmartSettingsUI();
            } else if (settingsScreen.classList.contains('active')) {
                syncUiFromChar();
            }
        });
        obs.observe(settingsScreen, { childList: true, attributes: true, attributeFilter: ['class'] });
    }

    function hookCoreFunctions() {
        hookLivelyPostscript();
        hookHandleAiReplyContent();
        hookSendMessage();
        hookCheckAutoReply();
        hookInjectChatSettingsHtml();
    }

    function bootstrap() {
        hookCoreFunctions();
        observeSettingsScreen();
        injectSmartSettingsUI();
    }

    // 立即同步挂载核心函数钩子（确保早于 DOMContentLoaded 里的 init() 与事件绑定！）
    hookCoreFunctions();

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            bootstrap();
            // 兜底轮询：即使真机 IndexedDB 加载耗时较长，也能在模板渲染后第一时间补挂载
            let tries = 0;
            const timer = setInterval(() => {
                tries++;
                bootstrap();
                if (document.getElementById('setting-smart-auto-reply-enabled') || tries >= 40) {
                    clearInterval(timer);
                }
            }, 500);
        });
    } else {
        bootstrap();
    }

    // 导出供外部测试与调试
    window.SmartAutoReplyPlugin = { clearSmartSchedule, getLastUserTimestamp, bootstrap, syncUiFromChar };
})();