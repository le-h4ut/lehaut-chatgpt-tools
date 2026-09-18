// ==UserScript==
// @name         ChatGPT RP Exporter GUI (Le_Haut)
// @namespace    le_haut.chatgpt.rp_exporter_gui
// @version      0.2.0
// @description  Полный экспорт текущего ChatGPT-чата в адаптивный GUI. v0.2: корректно сбрасывает кэш при переходе между чатами.
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-idle
// @noframes
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @updateURL    https://raw.githubusercontent.com/le-h4ut/lehaut-chatgpt-tools/main/userscripts/ChatGPT_RP_Exporter_GUI.user.js
// @downloadURL  https://raw.githubusercontent.com/le-h4ut/lehaut-chatgpt-tools/main/userscripts/ChatGPT_RP_Exporter_GUI.user.js
// ==/UserScript==

(() => {
    'use strict';

    const PAGE = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    const APP = 'lehaut-rp-exporter';
    const BUTTON_ID = `${APP}-button`;
    const OVERLAY_ID = `${APP}-overlay`;
    const STYLE_ID = `${APP}-style`;

    const PAGE_SIZE = 100;
    const MAX_PAGES = 2000;
    const MAX_RETRIES = 6;

    const DEFAULT_SEPARATOR = '============================================================';
    const VISIBLE_CONTENT_TYPES = new Set(['text', 'multimodal_text']);

    if (window.__LEHAUT_RP_EXPORTER_GUI__) return;
    window.__LEHAUT_RP_EXPORTER_GUI__ = true;

    const state = {
        busy: false,
        conversationId: '',
        title: '',
        payload: null,
        readableMessages: [],
        visibleMessages: [],
        generatedText: '',
        generatedCount: 0,
        lastError: null,
    };

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    const $ = id => document.getElementById(`${APP}-${id}`);

    function getConversationId() {
        try {
            return new URL(location.href).pathname.match(/(?:^|\/)c\/([^/?#]+)/)?.[1] || '';
        } catch {
            return '';
        }
    }

    function clearLoadedConversationState() {
        state.conversationId = '';
        state.title = '';
        state.payload = null;
        state.readableMessages = [];
        state.visibleMessages = [];
        state.generatedText = '';
        state.generatedCount = 0;
        state.lastError = null;

        const output = $('output');
        if (output) output.value = '';

        const title = $('chat-title');
        if (title) title.textContent = 'ChatGPT conversation';

        const subtitle = $('chat-subtitle');
        if (subtitle) subtitle.textContent = 'Ещё не загружено';

        for (const id of ['stat-raw', 'stat-visible', 'stat-user', 'stat-assistant', 'stat-filtered']) {
            const node = $(id);
            if (node) node.textContent = '0';
        }

        const count = $('generated-count');
        if (count) count.textContent = '0 сообщений';

        const raw = $('download-raw');
        if (raw) raw.disabled = true;
    }

    function loadedConversationIsCurrent() {
        const currentId = getConversationId();
        return Boolean(
            currentId &&
            state.payload &&
            state.conversationId === currentId
        );
    }

    function safeFileName(value) {
        return String(value || 'chatgpt-conversation')
            .replace(/[\\/:*?"<>|\x00-\x1F]/g, '_')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 140) || 'chatgpt-conversation';
    }

    function normalizeRole(role) {
        return String(role || 'unknown').trim().toLowerCase();
    }

    async function getSetting(key, fallback) {
        try {
            return await GM_getValue(`${APP}:${key}`, fallback);
        } catch {
            return fallback;
        }
    }

    async function setSetting(key, value) {
        try {
            await GM_setValue(`${APP}:${key}`, value);
        } catch {
            // Настройки — удобство, не причина ломать экспорт.
        }
    }

    function retryDelay(response, attempt) {
        const retryAfter = Number(response?.headers?.get?.('retry-after'));

        if (Number.isFinite(retryAfter) && retryAfter > 0) {
            return Math.min(retryAfter * 1000, 60_000);
        }

        return Math.min(1000 * (2 ** attempt), 15_000);
    }

    async function getAuthHeaders() {
        const response = await PAGE.fetch('/api/auth/session', {
            method: 'GET',
            credentials: 'include',
            cache: 'no-store',
            headers: { Accept: 'application/json' },
        });

        if (!response.ok) {
            throw new Error(`Не удалось получить сессию ChatGPT: HTTP ${response.status}`);
        }

        const session = await response.json();
        const token = session?.accessToken;

        if (!token) {
            throw new Error('В /api/auth/session нет accessToken. Возможно, сессия истекла.');
        }

        const headers = {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
        };

        const accountId =
            session?.account?.id ||
            session?.user?.account_id ||
            session?.user?.accountId ||
            null;

        if (accountId) {
            headers['ChatGPT-Account-Id'] = accountId;
        }

        return headers;
    }

    async function fetchJson(url, headers, label) {
        let lastError = null;

        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            let response;

            try {
                response = await PAGE.fetch(url, {
                    method: 'GET',
                    credentials: 'include',
                    cache: 'no-store',
                    headers,
                });
            } catch (error) {
                lastError = error;
                await sleep(Math.min(1000 * (2 ** attempt), 10_000));
                continue;
            }

            if (response.ok) {
                return response.json();
            }

            const error = new Error(`${label}: HTTP ${response.status}`);
            error.status = response.status;
            lastError = error;

            if (response.status === 429 || response.status >= 500) {
                await sleep(retryDelay(response, attempt));
                continue;
            }

            throw error;
        }

        throw lastError || new Error(`${label}: запрос не удался`);
    }

    function previousCursor(payload) {
        if (!payload?.page_info?.has_previous_page) return '';
        return String(payload.page_info.start_cursor || '').trim();
    }

    function dedupeMessages(pagesOldestToNewest) {
        const out = [];
        const seenIds = new Set();

        for (const page of pagesOldestToNewest) {
            for (const message of page || []) {
                if (!message || typeof message !== 'object') continue;

                const id = typeof message.id === 'string' ? message.id : '';

                if (id) {
                    if (seenIds.has(id)) continue;
                    seenIds.add(id);
                }

                out.push(message);
            }
        }

        return out;
    }

    async function fetchPaginatedConversation(id, headers) {
        const firstUrl = new URL(
            `/backend-api/conversations/${encodeURIComponent(id)}`,
            location.origin
        );

        firstUrl.searchParams.set('include_has_versions', 'true');
        firstUrl.searchParams.set('num_turns', String(PAGE_SIZE));

        updateProgress('Загружаю историю…', 'Страница 1', 0);

        const initial = await fetchJson(
            firstUrl.href,
            headers,
            'Начальная страница разговора'
        );

        if (!Array.isArray(initial?.messages)) {
            throw new Error('Новый endpoint не вернул messages[].');
        }

        const pagesNewestToOldest = [initial.messages];
        const pageInfoNewestToOldest = [initial.page_info ?? null];
        const seenCursors = new Set();

        let cursor = previousCursor(initial);
        let pageCount = 1;
        let loadedRecords = initial.messages.length;

        updateProgress(
            'Загружаю историю…',
            `Страница ${pageCount} · ${loadedRecords} backend-записей`,
            null
        );

        while (cursor) {
            if (seenCursors.has(cursor)) {
                throw new Error(
                    'Курсор пагинации повторился. Экспорт остановлен, чтобы не сохранить неполную историю.'
                );
            }

            seenCursors.add(cursor);

            if (pageCount >= MAX_PAGES) {
                throw new Error(`Достигнут защитный лимит ${MAX_PAGES} страниц.`);
            }

            const pageUrl = new URL(
                `/backend-api/conversations/${encodeURIComponent(id)}/messages`,
                location.origin
            );

            pageUrl.searchParams.set('before', cursor);
            pageUrl.searchParams.set('include_has_versions', 'true');
            pageUrl.searchParams.set('num_turns', String(PAGE_SIZE));

            updateProgress(
                'Загружаю историю…',
                `Страница ${pageCount + 1} · уже ${loadedRecords} записей`,
                null
            );

            const page = await fetchJson(
                pageUrl.href,
                headers,
                `Страница истории ${pageCount + 1}`
            );

            if (!Array.isArray(page?.messages)) {
                throw new Error(`Страница ${pageCount + 1} не вернула messages[].`);
            }

            if (page.messages.length === 0 && page?.page_info?.has_previous_page) {
                throw new Error(
                    'Backend заявил, что есть более старая история, но вернул пустую страницу. Экспорт остановлен.'
                );
            }

            pagesNewestToOldest.push(page.messages);
            pageInfoNewestToOldest.push(page.page_info ?? null);

            loadedRecords += page.messages.length;
            pageCount++;
            cursor = previousCursor(page);
        }

        const oldestInfo = pageInfoNewestToOldest[pageInfoNewestToOldest.length - 1];

        if (oldestInfo?.has_previous_page === true) {
            throw new Error('Не удалось подтвердить достижение самого начала разговора.');
        }

        const messages = dedupeMessages([...pagesNewestToOldest].reverse());

        if (!messages.length) {
            throw new Error('Backend вернул 0 сообщений.');
        }

        const conversationMeta = { ...initial };
        delete conversationMeta.messages;
        delete conversationMeta.mapping;

        return {
            kind: 'paginated',
            title: initial?.title || document.title || 'ChatGPT conversation',
            conversationMeta,
            pageCount,
            pageInfoNewestToOldest,
            archiveMessages: messages,
            conversationMessages: messages,
            mapping: null,
            currentNode: initial?.current_node || null,
        };
    }

    function activeBranchFromMapping(data) {
        const mapping = data?.mapping;
        const current = data?.current_node;

        if (!mapping || typeof mapping !== 'object' || !current) {
            throw new Error('Legacy endpoint не содержит mapping/current_node.');
        }

        const chain = [];
        const seen = new Set();
        let nodeId = current;

        while (nodeId) {
            if (seen.has(nodeId)) {
                throw new Error('В mapping обнаружен цикл.');
            }

            seen.add(nodeId);
            const node = mapping[nodeId];

            if (!node) {
                throw new Error(`Активная ветка оборвалась на отсутствующем node ${nodeId}.`);
            }

            if (node.message) chain.push(node.message);
            nodeId = node.parent || '';
        }

        return chain.reverse();
    }

    async function fetchLegacyConversation(id, headers) {
        updateProgress('Пробую запасной способ…', 'Legacy conversation API', null);

        const url = new URL(
            `/backend-api/conversation/${encodeURIComponent(id)}`,
            location.origin
        );

        url.searchParams.set('include_full_conversation', 'true');

        const data = await fetchJson(url.href, headers, 'Legacy conversation endpoint');
        const activeMessages = activeBranchFromMapping(data);
        const allMappingMessages = Object.values(data.mapping || {})
            .map(node => node?.message)
            .filter(Boolean);

        if (!activeMessages.length) {
            throw new Error('Legacy endpoint вернул пустую активную ветку.');
        }

        const conversationMeta = { ...data };
        delete conversationMeta.mapping;

        return {
            kind: 'legacy-mapping',
            title: data?.title || document.title || 'ChatGPT conversation',
            conversationMeta,
            pageCount: 1,
            pageInfoNewestToOldest: [],
            archiveMessages: allMappingMessages,
            conversationMessages: activeMessages,
            mapping: data.mapping,
            currentNode: data.current_node || null,
        };
    }

    function partToText(part) {
        if (typeof part === 'string') return part;
        if (part == null) return '';
        if (typeof part !== 'object') return String(part);
        if (typeof part.text === 'string') return part.text;

        const type = part.content_type || part.type || 'object';

        if (type === 'image_asset_pointer') return '[IMAGE]';
        if (type === 'audio_asset_pointer') return '[AUDIO]';
        if (type === 'real_time_user_audio_video_asset_pointer') return '[AUDIO/VIDEO]';
        if (type === 'audio_transcription') return part.text || '[AUDIO TRANSCRIPTION]';

        return '';
    }

    function contentToText(content) {
        if (!content) return '';
        if (typeof content === 'string') return content;

        if (Array.isArray(content.parts)) {
            return content.parts.map(partToText).filter(Boolean).join('\n');
        }

        if (typeof content.text === 'string') {
            if (content.content_type === 'code') {
                const lang = content.language || '';
                return `\`\`\`${lang}\n${content.text}\n\`\`\``;
            }

            return content.text;
        }

        if (content.content_type === 'tether_quote') {
            const body = content.text || '';
            const source = content.url ? `\nSource: ${content.url}` : '';
            return (body + source).trim();
        }

        if (typeof content.result === 'string') return content.result;
        if (typeof content.summary === 'string') return content.summary;

        try {
            return JSON.stringify(content, null, 2);
        } catch {
            return `[unserializable content: ${content.content_type || 'unknown'}]`;
        }
    }

    function normalizeMessage(message, index) {
        const createTime = Number.isFinite(message?.create_time)
            ? new Date(message.create_time * 1000).toISOString()
            : null;

        return {
            index,
            id: message?.id || null,
            role: message?.author?.role || 'unknown',
            author_name: message?.author?.name || null,
            create_time: createTime,
            content_type: message?.content?.content_type || null,
            recipient: message?.recipient || null,
            hidden_from_conversation:
                message?.metadata?.is_visually_hidden_from_conversation === true,
            text: contentToText(message?.content),
        };
    }

    function isVisibleConversationMessage(message) {
        const role = normalizeRole(message?.role);

        if (role !== 'user' && role !== 'assistant') return false;
        if (message?.hidden_from_conversation === true) return false;
        if (message?.recipient && message.recipient !== 'all') return false;
        if (!VISIBLE_CONTENT_TYPES.has(message?.content_type)) return false;

        return Boolean(String(message?.text ?? '').trim());
    }

    function countRawRoles(messages) {
        const counts = {};

        for (const message of messages) {
            const role = normalizeRole(message?.author?.role || 'unknown');
            counts[role] = (counts[role] || 0) + 1;
        }

        return counts;
    }

    function countReadableRoles(messages) {
        const counts = {};

        for (const message of messages) {
            const role = normalizeRole(message?.role || 'unknown');
            counts[role] = (counts[role] || 0) + 1;
        }

        return counts;
    }

    async function fetchFullConversation(id = getConversationId()) {

        if (!id) {
            throw new Error('Открой обычный чат с URL вида /c/<id>. На главной странице экспортировать нечего.');
        }

        const headers = await getAuthHeaders();
        let result = null;
        let paginatedError = null;

        try {
            result = await fetchPaginatedConversation(id, headers);
        } catch (error) {
            paginatedError = error;
            console.warn('[LeHaut RP Exporter] Paginated API failed, trying legacy:', error);
        }

        if (!result) {
            try {
                result = await fetchLegacyConversation(id, headers);
            } catch (legacyError) {
                throw new Error(
                    'Не удалось получить ПОЛНУЮ историю ни через пагинацию, ни через legacy endpoint.\n\n' +
                    `Paginated: ${paginatedError?.message || paginatedError}\n` +
                    `Legacy: ${legacyError?.message || legacyError}`
                );
            }
        }

        const archiveMessages = result.archiveMessages;
        const conversationMessages = result.conversationMessages;
        const readableMessages = conversationMessages.map(normalizeMessage);
        const visibleMessages = readableMessages.filter(isVisibleConversationMessage);
        const rawRoleCounts = countRawRoles(archiveMessages);
        const visibleRoleCounts = countReadableRoles(visibleMessages);

        const payload = {
            export_format: 'lehaut-chatgpt-full-conversation-v2',
            exported_at: new Date().toISOString(),
            source_url: `${location.origin}/c/${id}`,
            conversation_id: id,
            title: result.title,
            integrity: {
                completed: true,
                retrieval_kind: result.kind,
                reached_oldest_page: true,
                page_count: result.pageCount,
                raw_message_count: archiveMessages.length,
                conversation_branch_message_count: conversationMessages.length,
                visible_message_count: visibleMessages.length,
                role_counts_raw: rawRoleCounts,
                role_counts_visible: visibleRoleCounts,
                note:
                    'messages_raw keeps the backend archive. messages_readable is the active/current conversation projection used by the GUI.',
            },
            conversation_meta: result.conversationMeta,
            pagination_page_info_newest_to_oldest: result.pageInfoNewestToOldest,
            current_node: result.currentNode,
            messages_raw: archiveMessages,
            messages_readable: readableMessages,
            mapping: result.mapping,
        };

        return {
            id,
            result,
            payload,
            readableMessages,
            visibleMessages,
            rawRoleCounts,
            visibleRoleCounts,
        };
    }

    function formatTime(value) {
        if (!value) return '';
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
    }

    function uiValue(id, fallback = '') {
        const node = $(id);
        return node ? node.value : fallback;
    }

    function uiChecked(id, fallback = false) {
        const node = $(id);
        return node ? node.checked : fallback;
    }

    function displayRole(role) {
        role = normalizeRole(role);

        if (role === 'user') {
            return (uiValue('user-name', 'USER').trim() || 'USER');
        }

        if (role === 'assistant') {
            return (uiValue('assistant-name', 'ASSISTANT').trim() || 'ASSISTANT');
        }

        return role.toUpperCase();
    }

    function selectedVisibleMessages() {
        return state.visibleMessages.filter(message => {
            const role = normalizeRole(message.role);

            if (role === 'user' && !uiChecked('include-user', true)) return false;
            if (role === 'assistant' && !uiChecked('include-assistant', true)) return false;
            return true;
        });
    }

    function makeMessageBlock(message) {
        const parts = [];
        const showRole = uiChecked('show-role', true);
        const showTime = uiChecked('show-time', false);

        if (showRole) {
            let header = displayRole(message.role);

            if (showTime && message.create_time) {
                header += ` — ${formatTime(message.create_time)}`;
            }

            parts.push(`==================== ${header} ====================`);
        } else if (showTime && message.create_time) {
            parts.push(`[${formatTime(message.create_time)}]`);
        }

        parts.push(String(message.text ?? '').replace(/\r\n?/g, '\n').trim());
        return parts.join('\n\n');
    }

    async function persistCurrentSettings() {
        const values = {
            userName: uiValue('user-name', 'USER'),
            assistantName: uiValue('assistant-name', 'ASSISTANT'),
            separator: uiValue('separator', DEFAULT_SEPARATOR),
            includeUser: uiChecked('include-user', true),
            includeAssistant: uiChecked('include-assistant', true),
            showRole: uiChecked('show-role', true),
            showTime: uiChecked('show-time', false),
        };

        await Promise.all(Object.entries(values).map(([key, value]) => setSetting(key, value)));
    }

    async function generateText({ quiet = false } = {}) {
        if (!state.visibleMessages.length) {
            state.generatedText = '';
            state.generatedCount = 0;
            renderGenerated();
            return;
        }

        const selected = selectedVisibleMessages();
        const separator = uiValue('separator', DEFAULT_SEPARATOR) || DEFAULT_SEPARATOR;

        state.generatedText = selected
            .map(makeMessageBlock)
            .join(`\n\n${separator}\n\n`);
        state.generatedCount = selected.length;

        renderGenerated();
        persistCurrentSettings();

        if (!quiet) {
            setGuiStatus(`Сформировано ${selected.length} сообщений`, 'good');
        }
    }

    function renderGenerated() {
        const output = $('output');
        if (output) output.value = state.generatedText;

        const count = $('generated-count');
        if (count) count.textContent = String(state.generatedCount || 0);

        const hasText = Boolean(state.generatedText);

        for (const id of ['download-txt', 'copy', 'form']) {
            const node = $(id);
            if (node) node.disabled = id !== 'form' && !hasText;
        }
    }

    function downloadBlob(content, filename, type) {
        const blob = new Blob([content], { type });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');

        a.href = url;
        a.download = filename;
        a.style.display = 'none';

        document.body.appendChild(a);
        a.click();
        a.remove();

        setTimeout(() => URL.revokeObjectURL(url), 30_000);
    }

    function downloadTxt() {
        if (!state.generatedText) return;

        const filename =
            safeFileName(state.title) +
            '__' +
            (state.conversationId || 'chat').slice(0, 12) +
            '__LOG.txt';

        downloadBlob(
            '\uFEFF' + state.generatedText,
            filename,
            'text/plain;charset=utf-8'
        );
    }

    function downloadRawJson() {
        if (!state.payload) return;

        const filename =
            safeFileName(state.title) +
            '__' +
            (state.conversationId || 'chat').slice(0, 12) +
            '__FULL.json';

        downloadBlob(
            JSON.stringify(state.payload, null, 2),
            filename,
            'application/json;charset=utf-8'
        );
    }

    async function copyGeneratedText() {
        if (!state.generatedText) return;

        const button = $('copy');
        const old = button?.textContent || 'Копировать';

        try {
            await navigator.clipboard.writeText(state.generatedText);
        } catch {
            const output = $('output');
            output?.focus();
            output?.select();
            document.execCommand('copy');
        }

        if (button) {
            button.textContent = 'Скопировано';
            setTimeout(() => {
                button.textContent = old;
            }, 1200);
        }
    }

    function setGuiStatus(text, kind = 'normal') {
        const status = $('status');
        if (!status) return;

        status.textContent = text;
        status.dataset.kind = kind;
    }

    function updateProgress(title, detail = '', percent = null) {
        const progressPanel = $('progress-panel');
        const workspace = $('workspace');
        const progressTitle = $('progress-title');
        const progressDetail = $('progress-detail');
        const fill = $('progress-fill');

        progressPanel?.classList.remove(`${APP}-hidden`);
        workspace?.classList.add(`${APP}-hidden`);

        if (progressTitle) progressTitle.textContent = title;
        if (progressDetail) progressDetail.textContent = detail;

        if (fill) {
            if (Number.isFinite(percent)) {
                fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
                fill.classList.remove(`${APP}-indeterminate`);
            } else {
                fill.style.width = '36%';
                fill.classList.add(`${APP}-indeterminate`);
            }
        }
    }

    function showWorkspace() {
        $('progress-panel')?.classList.add(`${APP}-hidden`);
        $('workspace')?.classList.remove(`${APP}-hidden`);
    }

    function showError(error) {
        state.lastError = error;

        const progressPanel = $('progress-panel');
        const workspace = $('workspace');
        const title = $('progress-title');
        const detail = $('progress-detail');
        const fill = $('progress-fill');
        const retry = $('retry');

        progressPanel?.classList.remove(`${APP}-hidden`);
        workspace?.classList.add(`${APP}-hidden`);

        if (title) title.textContent = 'Не удалось выгрузить чат';
        if (detail) detail.textContent = error?.message || String(error);
        if (fill) {
            fill.classList.remove(`${APP}-indeterminate`);
            fill.style.width = '100%';
            fill.dataset.error = '1';
        }
        retry?.classList.remove(`${APP}-hidden`);

        setGuiStatus('Экспорт не сформирован: полнота истории не подтверждена', 'bad');
    }

    function resetProgressErrorState() {
        const fill = $('progress-fill');
        const retry = $('retry');

        if (fill) {
            fill.dataset.error = '0';
        }

        retry?.classList.add(`${APP}-hidden`);
    }

    function renderLoadedConversation() {
        const rawCount = state.payload?.integrity?.raw_message_count ?? 0;
        const visibleCount = state.visibleMessages.length;
        const roleCounts = countReadableRoles(state.visibleMessages);
        const filteredCount = Math.max(
            0,
            (state.payload?.integrity?.conversation_branch_message_count ?? state.readableMessages.length) - visibleCount
        );

        $('chat-title').textContent = state.title || 'ChatGPT conversation';
        $('chat-subtitle').textContent =
            `✓ Загружено полностью · ${state.payload?.integrity?.retrieval_kind || '?'} · ` +
            `${state.payload?.integrity?.page_count || 1} стр.`;

        $('stat-raw').textContent = String(rawCount);
        $('stat-visible').textContent = String(visibleCount);
        $('stat-user').textContent = String(roleCounts.user || 0);
        $('stat-assistant').textContent = String(roleCounts.assistant || 0);
        $('stat-filtered').textContent = String(filteredCount);

        const details = $('settings-details');
        if (details) details.open = window.matchMedia('(min-width: 760px)').matches;

        $('download-raw').disabled = !state.payload;

        generateText({ quiet: true });
        showWorkspace();
        setGuiStatus(
            `Готово · ${visibleCount} видимых сообщений · ${roleCounts.user || 0} user / ${roleCounts.assistant || 0} assistant`,
            'good'
        );
    }

    async function loadCurrentChat() {
        if (state.busy) return;

        const targetId = getConversationId();

        if (!targetId) {
            clearLoadedConversationState();
            showError(new Error('Открой обычный чат с URL вида /c/<id>. На главной странице экспортировать нечего.'));
            return;
        }

        // ВАЖНО: данные другого чата никогда не должны переживать SPA-переход.
        if (state.conversationId && state.conversationId !== targetId) {
            clearLoadedConversationState();
        }

        state.busy = true;
        state.lastError = null;
        resetProgressErrorState();
        updateProgress('Подключаюсь к текущему чату…', 'Получаю сессию ChatGPT', null);

        try {
            const exported = await fetchFullConversation(targetId);

            // Пользователь мог успеть перейти в другой чат, пока шла пагинация.
            // Не показываем результат уже неактуального запроса.
            if (getConversationId() !== targetId) {
                console.info('[LeHaut RP Exporter] Route changed during export; stale result discarded.');
                clearLoadedConversationState();
                return;
            }

            state.conversationId = exported.id;
            state.title = exported.result.title;
            state.payload = exported.payload;
            state.readableMessages = exported.readableMessages;
            state.visibleMessages = exported.visibleMessages;

            renderLoadedConversation();
        } catch (error) {
            console.error('[LeHaut RP Exporter] FAILED:', error);
            showError(error);
        } finally {
            state.busy = false;

            // Если переход произошёл во время загрузки и GUI всё ещё открыт —
            // сразу начинаем загрузку уже нового чата.
            const overlay = $('overlay');
            if (
                overlay?.classList.contains(`${APP}-open`) &&
                getConversationId() &&
                !loadedConversationIsCurrent()
            ) {
                setTimeout(() => {
                    if (!state.busy) loadCurrentChat();
                }, 0);
            }
        }
    }

    function openGui() {
        const overlay = $('overlay');
        if (!overlay) return;

        overlay.classList.add(`${APP}-open`);
        document.documentElement.classList.add(`${APP}-lock`);

        const currentId = getConversationId();

        // ChatGPT — SPA. Userscript не перезапускается при переходе /c/A -> /c/B,
        // поэтому старый state.payload надо явно считать недействительным.
        if (!currentId) {
            clearLoadedConversationState();
            showError(new Error('Открой обычный чат с URL вида /c/<id>. На главной странице экспортировать нечего.'));
            return;
        }

        if (!loadedConversationIsCurrent()) {
            clearLoadedConversationState();

            if (!state.busy) {
                loadCurrentChat();
            }
            return;
        }

        renderLoadedConversation();
    }

    function closeGui() {
        const overlay = $('overlay');
        overlay?.classList.remove(`${APP}-open`);
        document.documentElement.classList.remove(`${APP}-lock`);
    }

    function buildStyles() {
        if (document.getElementById(STYLE_ID)) return;

        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
html.${APP}-lock { overflow: hidden !important; }

#${BUTTON_ID} {
    position: fixed;
    right: 18px;
    bottom: 148px;
    z-index: 2147483645;
    min-height: 40px;
    padding: 0 13px;
    border: 1px solid rgba(255,255,255,.18);
    border-radius: 12px;
    background: #202123;
    color: #fff;
    box-shadow: 0 6px 20px rgba(0,0,0,.26);
    font: 700 11px/1 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    letter-spacing: .2px;
    cursor: pointer;
    user-select: none;
    -webkit-tap-highlight-color: transparent;
}
#${BUTTON_ID}:active { transform: translateY(1px); }

#${OVERLAY_ID} {
    position: fixed;
    inset: 0;
    z-index: 2147483646;
    display: none;
    align-items: center;
    justify-content: center;
    padding: 18px;
    background: rgba(0,0,0,.72);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    font-family: system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    color: #ececec;
}
#${OVERLAY_ID}.${APP}-open { display: flex; }

#${APP}-dialog {
    width: min(1180px, 96vw);
    height: min(850px, 94dvh);
    min-height: 520px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid rgba(255,255,255,.12);
    border-radius: 18px;
    background: #171717;
    box-shadow: 0 28px 100px rgba(0,0,0,.58);
}

.${APP}-header {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 58px;
    padding: 10px 14px 10px 18px;
    border-bottom: 1px solid rgba(255,255,255,.09);
    background: #1b1b1b;
}
.${APP}-brand { min-width: 0; }
.${APP}-brand-title { font-size: 17px; font-weight: 800; line-height: 1.15; }
.${APP}-brand-sub { margin-top: 4px; color: #8f8f8f; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.${APP}-icon-button {
    width: 42px;
    height: 42px;
    flex: 0 0 42px;
    border: 0;
    border-radius: 11px;
    background: #292929;
    color: #fff;
    font-size: 24px;
    line-height: 1;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
}

.${APP}-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    overscroll-behavior: contain;
    padding: 16px;
}

.${APP}-hidden { display: none !important; }

.${APP}-progress-wrap {
    min-height: 100%;
    display: grid;
    place-items: center;
    padding: 24px;
}
.${APP}-progress-card {
    width: min(520px, 100%);
    padding: 24px;
    border: 1px solid rgba(255,255,255,.10);
    border-radius: 16px;
    background: #202020;
}
.${APP}-progress-title { font-size: 20px; font-weight: 800; }
.${APP}-progress-detail {
    margin-top: 8px;
    min-height: 40px;
    color: #a7a7a7;
    font: 12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
}
.${APP}-progress-track {
    position: relative;
    height: 8px;
    margin-top: 16px;
    overflow: hidden;
    border-radius: 999px;
    background: #101010;
}
.${APP}-progress-fill {
    height: 100%;
    width: 0;
    border-radius: inherit;
    background: #10a37f;
    transition: width .2s ease;
}
.${APP}-progress-fill[data-error="1"] { background: #d92d20; }
.${APP}-progress-fill.${APP}-indeterminate { animation: ${APP}-slide 1.15s ease-in-out infinite alternate; }
@keyframes ${APP}-slide { from { transform: translateX(-80%); } to { transform: translateX(180%); } }

.${APP}-workspace { min-height: 100%; }
.${APP}-top-card,
.${APP}-panel {
    border: 1px solid rgba(255,255,255,.09);
    border-radius: 14px;
    background: #202020;
}
.${APP}-top-card { padding: 14px; margin-bottom: 12px; }
.${APP}-chat-title { font-size: 18px; font-weight: 800; overflow-wrap: anywhere; }
.${APP}-chat-subtitle { margin-top: 4px; color: #79d6b8; font-size: 11px; }

.${APP}-stats {
    display: grid;
    grid-template-columns: repeat(5, minmax(92px, 1fr));
    gap: 8px;
    margin-top: 12px;
}
.${APP}-stat {
    min-width: 0;
    padding: 10px;
    border-radius: 10px;
    background: #141414;
    border: 1px solid rgba(255,255,255,.065);
}
.${APP}-stat-value { font-size: 20px; font-weight: 800; line-height: 1; }
.${APP}-stat-label { margin-top: 5px; color: #888; font-size: 9px; font-weight: 700; letter-spacing: .35px; }

.${APP}-main-grid {
    display: grid;
    grid-template-columns: minmax(290px, 340px) minmax(0, 1fr);
    gap: 12px;
    align-items: stretch;
}
.${APP}-panel { min-width: 0; overflow: hidden; }
.${APP}-panel-inner { padding: 14px; }

.${APP}-settings summary {
    list-style: none;
    cursor: pointer;
    user-select: none;
    font-size: 14px;
    font-weight: 800;
    padding: 14px;
    -webkit-tap-highlight-color: transparent;
}
.${APP}-settings summary::-webkit-details-marker { display: none; }
.${APP}-settings summary::after { content: '⌄'; float: right; color: #888; }
.${APP}-settings[open] summary::after { content: '⌃'; }
.${APP}-settings[open] summary { border-bottom: 1px solid rgba(255,255,255,.08); }

.${APP}-field { margin-bottom: 12px; }
.${APP}-field:last-child { margin-bottom: 0; }
.${APP}-field-label { display: block; margin-bottom: 6px; color: #a6a6a6; font-size: 11px; font-weight: 650; }
.${APP}-input {
    box-sizing: border-box;
    width: 100%;
    min-height: 42px;
    padding: 9px 10px;
    border: 1px solid rgba(255,255,255,.12);
    border-radius: 9px;
    outline: none;
    background: #111;
    color: #fff;
    font: 14px/1.2 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
}
.${APP}-input:focus { border-color: #10a37f; box-shadow: 0 0 0 2px rgba(16,163,127,.12); }

.${APP}-switch-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 42px;
    padding: 4px 0;
    color: #ddd;
    font-size: 13px;
}
.${APP}-switch {
    appearance: none;
    -webkit-appearance: none;
    width: 44px;
    height: 25px;
    flex: 0 0 44px;
    border-radius: 999px;
    background: #3b3b3b;
    position: relative;
    cursor: pointer;
    transition: background .15s ease;
}
.${APP}-switch::after {
    content: '';
    position: absolute;
    top: 3px;
    left: 3px;
    width: 19px;
    height: 19px;
    border-radius: 50%;
    background: #fff;
    transition: transform .15s ease;
}
.${APP}-switch:checked { background: #10a37f; }
.${APP}-switch:checked::after { transform: translateX(19px); }

.${APP}-preview-panel {
    display: flex;
    flex-direction: column;
    min-height: 510px;
}
.${APP}-preview-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 12px 14px;
    border-bottom: 1px solid rgba(255,255,255,.08);
}
.${APP}-preview-title { font-size: 14px; font-weight: 800; }
.${APP}-preview-count { color: #8f8f8f; font-size: 11px; }
#${APP}-output {
    box-sizing: border-box;
    width: 100%;
    min-height: 0;
    flex: 1 1 auto;
    resize: none;
    padding: 14px;
    border: 0;
    outline: none;
    background: #111;
    color: #e6e6e6;
    font: 12px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
}

.${APP}-footer {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px calc(10px + env(safe-area-inset-bottom));
    border-top: 1px solid rgba(255,255,255,.09);
    background: #1b1b1b;
}
.${APP}-footer-left { flex: 1 1 auto; min-width: 0; }
#${APP}-status {
    max-width: 100%;
    color: #8f8f8f;
    font-size: 10px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
#${APP}-status[data-kind="good"] { color: #6ce9a6; }
#${APP}-status[data-kind="bad"] { color: #ff8a80; }
.${APP}-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.${APP}-button {
    min-height: 42px;
    padding: 0 13px;
    border: 0;
    border-radius: 10px;
    background: #303030;
    color: #fff;
    font: 750 12px/1 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
}
.${APP}-button:hover { background: #3a3a3a; }
.${APP}-button:active { transform: translateY(1px); }
.${APP}-button:disabled { opacity: .42; cursor: default; transform: none; }
.${APP}-button.${APP}-primary { background: #10a37f; }
.${APP}-button.${APP}-primary:hover { background: #13b98f; }
.${APP}-button.${APP}-danger { background: #b42318; }
.${APP}-button.${APP}-secondary { background: #6941c6; }

@media (max-width: 759px) {
    #${BUTTON_ID} {
        right: 12px;
        bottom: calc(92px + env(safe-area-inset-bottom));
        min-height: 44px;
        padding: 0 12px;
        border-radius: 13px;
    }

    #${OVERLAY_ID} {
        padding: 0;
        align-items: stretch;
        justify-content: stretch;
        background: #171717;
        backdrop-filter: none;
        -webkit-backdrop-filter: none;
    }

    #${APP}-dialog {
        width: 100%;
        height: 100dvh;
        min-height: 100dvh;
        max-height: 100dvh;
        border: 0;
        border-radius: 0;
        box-shadow: none;
    }

    .${APP}-header {
        min-height: 56px;
        padding: max(8px, env(safe-area-inset-top)) 10px 8px 14px;
    }

    .${APP}-brand-title { font-size: 16px; }
    .${APP}-brand-sub { max-width: 72vw; }
    .${APP}-icon-button { width: 44px; height: 44px; flex-basis: 44px; }

    .${APP}-body {
        padding: 10px;
        padding-bottom: 18px;
    }

    .${APP}-top-card { padding: 12px; margin-bottom: 10px; }
    .${APP}-chat-title { font-size: 16px; }
    .${APP}-chat-subtitle { line-height: 1.35; }

    .${APP}-stats {
        grid-template-columns: repeat(5, minmax(0, 1fr));
        gap: 5px;
    }
    .${APP}-stat { padding: 8px 5px; text-align: center; }
    .${APP}-stat-value { font-size: 17px; }
    .${APP}-stat-label { font-size: 7px; letter-spacing: 0; overflow: hidden; text-overflow: ellipsis; }

    .${APP}-main-grid {
        display: block;
    }

    .${APP}-settings { margin-bottom: 10px; }
    .${APP}-settings summary { min-height: 44px; box-sizing: border-box; padding: 13px 14px; }

    .${APP}-input {
        min-height: 46px;
        font-size: 16px; /* чтобы Firefox/Android не зумил поле */
    }

    .${APP}-switch-row { min-height: 46px; }

    .${APP}-preview-panel {
        min-height: 56dvh;
        height: 56dvh;
    }

    #${APP}-output {
        font-size: 12px;
        resize: none;
    }

    .${APP}-footer {
        display: block;
        padding: 8px 10px calc(8px + env(safe-area-inset-bottom));
    }

    .${APP}-footer-left { display: none; }
    .${APP}-actions {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
    }
    .${APP}-button {
        min-height: 48px;
        padding: 0 8px;
        font-size: 12px;
    }

    #${APP}-download-raw {
        grid-column: span 2;
    }

    .${APP}-progress-wrap { padding: 16px; }
    .${APP}-progress-card { padding: 18px; }
}

@media (max-width: 420px) {
    .${APP}-stat-label { font-size: 6.5px; }
    .${APP}-stat-value { font-size: 16px; }
}
        `;

        document.head.appendChild(style);
    }

    async function buildUi() {
        if (!document.body || document.getElementById(BUTTON_ID)) return;

        buildStyles();

        const userName = await getSetting('userName', 'USER');
        const assistantName = await getSetting('assistantName', 'ASSISTANT');
        const separator = await getSetting('separator', DEFAULT_SEPARATOR);
        const includeUser = await getSetting('includeUser', true);
        const includeAssistant = await getSetting('includeAssistant', true);
        const showRole = await getSetting('showRole', true);
        const showTime = await getSetting('showTime', false);

        const button = document.createElement('button');
        button.id = BUTTON_ID;
        button.type = 'button';
        button.textContent = 'EXPORT CHAT';
        button.title = 'Открыть экспортёр текущего чата';

        const overlay = document.createElement('div');
        overlay.id = OVERLAY_ID;
        overlay.innerHTML = `
<div id="${APP}-dialog" role="dialog" aria-modal="true" aria-label="ChatGPT RP Exporter">
    <header class="${APP}-header">
        <div class="${APP}-brand">
            <div class="${APP}-brand-title">ChatGPT RP Exporter</div>
            <div class="${APP}-brand-sub">полный чат → чистый лог без промежуточного JSON</div>
        </div>
        <button id="${APP}-close" class="${APP}-icon-button" type="button" aria-label="Закрыть">×</button>
    </header>

    <main class="${APP}-body">
        <section id="${APP}-progress-panel" class="${APP}-progress-wrap">
            <div class="${APP}-progress-card">
                <div id="${APP}-progress-title" class="${APP}-progress-title">Готовлю экспорт…</div>
                <div id="${APP}-progress-detail" class="${APP}-progress-detail">Проверяю текущий чат</div>
                <div class="${APP}-progress-track">
                    <div id="${APP}-progress-fill" class="${APP}-progress-fill ${APP}-indeterminate"></div>
                </div>
                <button id="${APP}-retry" class="${APP}-button ${APP}-danger ${APP}-hidden" type="button" style="margin-top:16px;width:100%">Повторить</button>
            </div>
        </section>

        <section id="${APP}-workspace" class="${APP}-workspace ${APP}-hidden">
            <div class="${APP}-top-card">
                <div id="${APP}-chat-title" class="${APP}-chat-title">ChatGPT conversation</div>
                <div id="${APP}-chat-subtitle" class="${APP}-chat-subtitle"></div>

                <div class="${APP}-stats">
                    <div class="${APP}-stat">
                        <div id="${APP}-stat-raw" class="${APP}-stat-value">0</div>
                        <div class="${APP}-stat-label">BACKEND</div>
                    </div>
                    <div class="${APP}-stat">
                        <div id="${APP}-stat-visible" class="${APP}-stat-value">0</div>
                        <div class="${APP}-stat-label">В ЛОГЕ</div>
                    </div>
                    <div class="${APP}-stat">
                        <div id="${APP}-stat-user" class="${APP}-stat-value">0</div>
                        <div class="${APP}-stat-label">USER</div>
                    </div>
                    <div class="${APP}-stat">
                        <div id="${APP}-stat-assistant" class="${APP}-stat-value">0</div>
                        <div class="${APP}-stat-label">ASSISTANT</div>
                    </div>
                    <div class="${APP}-stat">
                        <div id="${APP}-stat-filtered" class="${APP}-stat-value">0</div>
                        <div class="${APP}-stat-label">УБРАНО</div>
                    </div>
                </div>
            </div>

            <div class="${APP}-main-grid">
                <details id="${APP}-settings-details" class="${APP}-panel ${APP}-settings">
                    <summary>Настройки лога</summary>
                    <div class="${APP}-panel-inner">
                        <div class="${APP}-field">
                            <label class="${APP}-field-label" for="${APP}-user-name">Имя USER / игрока</label>
                            <input id="${APP}-user-name" class="${APP}-input" type="text" value="${escapeHtmlAttribute(userName)}">
                        </div>

                        <div class="${APP}-field">
                            <label class="${APP}-field-label" for="${APP}-assistant-name">Имя ASSISTANT / GM</label>
                            <input id="${APP}-assistant-name" class="${APP}-input" type="text" value="${escapeHtmlAttribute(assistantName)}">
                        </div>

                        <div class="${APP}-field">
                            <label class="${APP}-field-label" for="${APP}-separator">Разделитель между сообщениями</label>
                            <input id="${APP}-separator" class="${APP}-input" type="text" value="${escapeHtmlAttribute(separator)}">
                        </div>

                        <label class="${APP}-switch-row">
                            <span>Включать USER</span>
                            <input id="${APP}-include-user" class="${APP}-switch" type="checkbox" ${includeUser ? 'checked' : ''}>
                        </label>

                        <label class="${APP}-switch-row">
                            <span>Включать ASSISTANT</span>
                            <input id="${APP}-include-assistant" class="${APP}-switch" type="checkbox" ${includeAssistant ? 'checked' : ''}>
                        </label>

                        <label class="${APP}-switch-row">
                            <span>Показывать имя роли</span>
                            <input id="${APP}-show-role" class="${APP}-switch" type="checkbox" ${showRole ? 'checked' : ''}>
                        </label>

                        <label class="${APP}-switch-row">
                            <span>Добавлять время</span>
                            <input id="${APP}-show-time" class="${APP}-switch" type="checkbox" ${showTime ? 'checked' : ''}>
                        </label>
                    </div>
                </details>

                <section class="${APP}-panel ${APP}-preview-panel">
                    <div class="${APP}-preview-head">
                        <div class="${APP}-preview-title">Готовый текст</div>
                        <div class="${APP}-preview-count"><span id="${APP}-generated-count">0</span> сообщений</div>
                    </div>
                    <textarea id="${APP}-output" spellcheck="false"></textarea>
                </section>
            </div>
        </section>
    </main>

    <footer class="${APP}-footer">
        <div class="${APP}-footer-left">
            <div id="${APP}-status">Нажми EXPORT CHAT</div>
        </div>
        <div class="${APP}-actions">
            <button id="${APP}-form" class="${APP}-button" type="button">Сформировать</button>
            <button id="${APP}-copy" class="${APP}-button" type="button" disabled>Копировать</button>
            <button id="${APP}-download-txt" class="${APP}-button ${APP}-primary" type="button" disabled>Скачать TXT</button>
            <button id="${APP}-download-raw" class="${APP}-button ${APP}-secondary" type="button" disabled>RAW JSON</button>
        </div>
    </footer>
</div>`;

        document.body.appendChild(button);
        document.body.appendChild(overlay);

        button.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            openGui();
        });

        $('close').addEventListener('click', closeGui);

        overlay.addEventListener('click', event => {
            if (event.target === overlay && window.innerWidth >= 760) {
                closeGui();
            }
        });

        $('retry').addEventListener('click', loadCurrentChat);
        $('form').addEventListener('click', () => generateText());
        $('copy').addEventListener('click', copyGeneratedText);
        $('download-txt').addEventListener('click', downloadTxt);
        $('download-raw').addEventListener('click', downloadRawJson);

        const settingsIds = [
            'include-user',
            'include-assistant',
            'show-role',
            'show-time',
            'user-name',
            'assistant-name',
            'separator',
        ];

        let autoGenerateTimer = null;

        const scheduleGenerate = () => {
            if (!state.payload) return;
            clearTimeout(autoGenerateTimer);
            autoGenerateTimer = setTimeout(() => generateText({ quiet: true }), 140);
        };

        for (const id of settingsIds) {
            const node = $(id);
            node?.addEventListener('change', scheduleGenerate);
            node?.addEventListener('input', scheduleGenerate);
        }

        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && overlay.classList.contains(`${APP}-open`)) {
                closeGui();
            }
        });
    }

    function escapeHtmlAttribute(value) {
        return String(value ?? '')
            .replaceAll('&', '&amp;')
            .replaceAll('"', '&quot;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;');
    }

    async function ensureUi() {
        if (!document.body) return;
        if (document.getElementById(BUTTON_ID)) return;

        try {
            await buildUi();
        } catch (error) {
            console.error('[LeHaut RP Exporter] UI mount failed:', error);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', ensureUi, { once: true });
    } else {
        ensureUi();
    }

    let lastRouteConversationId = getConversationId();

    function syncSpaRoute() {
        const currentId = getConversationId();

        if (currentId === lastRouteConversationId) return;

        const previousId = lastRouteConversationId;
        lastRouteConversationId = currentId;

        console.info(
            '[LeHaut RP Exporter] Chat route changed:',
            previousId || '(none)',
            '→',
            currentId || '(none)'
        );

        if (!loadedConversationIsCurrent()) {
            clearLoadedConversationState();

            const overlay = $('overlay');
            if (overlay?.classList.contains(`${APP}-open`)) {
                resetProgressErrorState();

                if (currentId) {
                    updateProgress('Чат изменился…', 'Загружаю новый разговор', null);
                    if (!state.busy) loadCurrentChat();
                } else {
                    showError(new Error('Сейчас открыт не обычный /c/<id> чат.'));
                }
            }
        }
    }

    const observer = new MutationObserver(() => {
        ensureUi();
        syncSpaRoute();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    // MutationObserver почти всегда поймает SPA-навигацию, а этот лёгкий poll —
    // страховка на случай изменения URL без заметной DOM-мутации.
    setInterval(syncSpaRoute, 750);

    window.addEventListener('popstate', syncSpaRoute);

    console.info('[LeHaut RP Exporter] GUI v0.2 loaded');
})();
