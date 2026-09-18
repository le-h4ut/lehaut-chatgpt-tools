// ==UserScript==
// @name         ChatGPT Le_Haut Fixpack
// @namespace    le_haut.chatgpt.fixpack
// @version      1.0.0
// @description  Full long-chat history + raw Markdown while typing + Markdown render on send.
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-start
// @noframes
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @require      https://cdn.jsdelivr.net/npm/marked@18.0.11/lib/marked.umd.js
// ==/UserScript==

/*
 * ChatGPT Le_Haut Fixpack
 *
 * Modules:
 *   1) Full History Injector
 *      - expands ChatGPT's paginated conversation response before React sees it,
 *        restoring the stock prompt navigator for long conversations.
 *
 *   2) Composer Format Guard
 *      - keeps typed/pasted Markdown literal while composing.
 *      - adapted from ChatGPT-ComposerFormatGuard by Mehver:
 *        https://github.com/MehverSynRGB/ChatGPT-ComposerFormatGuard
 *        Original license: BSD-3-Clause.
 *
 *   3) Markdown Render on Send
 *      - converts raw Markdown to rich text immediately before native ChatGPT send.
 *
 * IMPORTANT:
 *   Disable the three standalone scripts after installing this combined one.
 */

/*
BSD 3-Clause License

Copyright (c) 2026 Mehver (https://github.com/Mehver)
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

(() => {
    'use strict';

    const PAGE = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    if (PAGE.__LEHAUT_CHATGPT_FIXPACK_LOADED__) return;
    PAGE.__LEHAUT_CHATGPT_FIXPACK_LOADED__ = true;

    const PREFIX = '[LeHautFixpack]';
    const log = (...args) => console.log(PREFIX, ...args);
    const warn = (...args) => console.warn(PREFIX, ...args);

    // ========================================================================
    // 1. FULL HISTORY INJECTOR
    // ========================================================================

    (() => {
        if (PAGE.__LEHAUT_FULL_HISTORY_PATCHED__) return;
        PAGE.__LEHAUT_FULL_HISTORY_PATCHED__ = true;

        const NativeFetch = PAGE.fetch.bind(PAGE);
        const PageRequest = PAGE.Request;
        const PageResponse = PAGE.Response;
        const PageHeaders = PAGE.Headers;

        const PAGE_SIZE = 100;
        const MAX_PAGES = 500;

        function isConversationInitial(url) {
            try {
                const u = new URL(url, location.origin);
                return (
                    /^\/backend-api\/conversations\/[^/]+$/.test(u.pathname) &&
                    !u.searchParams.has('before')
                );
            } catch {
                return false;
            }
        }

        function conversationId(url) {
            try {
                const pathname = new URL(url, location.origin).pathname;
                return decodeURIComponent(
                    pathname.match(/^\/backend-api\/conversations\/([^/]+)$/)?.[1] || ''
                );
            } catch {
                return '';
            }
        }

        function previousCursor(payload) {
            if (!payload?.page_info?.has_previous_page) return '';
            return String(payload.page_info.start_cursor || '').trim();
        }

        function requestUrl(input) {
            if (typeof input === 'string') return input;
            if (input instanceof URL) return input.href;
            return input?.url || '';
        }

        function makeBackgroundHeaders(request) {
            const headers = new PageHeaders();
            try {
                for (const [key, value] of request.headers.entries()) {
                    headers.set(key, value);
                }
            } catch (e) {
                warn('FullHistory: could not clone request headers', e);
            }
            return headers;
        }

        async function fetchOlderPage(id, cursor, originalRequest) {
            const url = new URL(
                `/backend-api/conversations/${encodeURIComponent(id)}/messages`,
                location.origin
            );

            url.searchParams.set('before', cursor);
            url.searchParams.set('include_has_versions', 'true');
            url.searchParams.set('num_turns', String(PAGE_SIZE));

            const req = new PageRequest(url.href, {
                method: 'GET',
                headers: makeBackgroundHeaders(originalRequest),
                credentials: originalRequest.credentials || 'include',
                cache: 'no-store',
                redirect: originalRequest.redirect || 'follow',
            });

            const response = await NativeFetch(req);
            if (!response.ok) {
                throw new Error(`Older page HTTP ${response.status}`);
            }
            return response.json();
        }

        function mergeMessages(pagesNewestToOldest) {
            const pages = [...pagesNewestToOldest].reverse();
            const result = [];
            const seen = new Set();

            for (const page of pages) {
                for (const message of page || []) {
                    if (!message) continue;
                    const id = String(message.id || '');
                    if (id && seen.has(id)) continue;
                    if (id) seen.add(id);
                    result.push(message);
                }
            }
            return result;
        }

        async function expandConversation(initialPayload, id, originalRequest) {
            if (!Array.isArray(initialPayload?.messages)) return null;

            let cursor = previousCursor(initialPayload);
            if (!cursor) return null;

            const pagesNewestToOldest = [initialPayload.messages];
            const seenCursors = new Set();
            let lastPage = initialPayload;
            let pageCount = 1;

            log('FullHistory: loading complete history for', id);

            while (cursor) {
                if (seenCursors.has(cursor)) {
                    throw new Error('Pagination cursor repeated');
                }
                seenCursors.add(cursor);

                if (pageCount >= MAX_PAGES) {
                    throw new Error(`Pagination safety limit: ${MAX_PAGES} pages`);
                }

                const page = await fetchOlderPage(id, cursor, originalRequest);
                if (!Array.isArray(page?.messages)) {
                    throw new Error('History page has no messages[]');
                }

                pagesNewestToOldest.push(page.messages);
                lastPage = page;
                pageCount++;
                cursor = previousCursor(page);
            }

            const allMessages = mergeMessages(pagesNewestToOldest);

            const merged = {
                ...initialPayload,
                messages: allMessages,
                page_info: {
                    ...(initialPayload.page_info || {}),
                    has_previous_page: false,
                    has_next_page: false,
                    start_cursor:
                        lastPage?.page_info?.start_cursor ??
                        initialPayload?.page_info?.start_cursor,
                    end_cursor: initialPayload?.page_info?.end_cursor,
                },
            };

            log(
                'FullHistory: ready —',
                pageCount,
                'pages,',
                allMessages.length,
                'messages'
            );

            return merged;
        }

        PAGE.fetch = async function patchedFetch(input, init) {
            let request;

            try {
                request = new PageRequest(input, init);
            } catch {
                return NativeFetch(input, init);
            }

            const url = requestUrl(request);

            if (request.method !== 'GET' || !isConversationInitial(url)) {
                return NativeFetch(request);
            }

            const id = conversationId(url);
            if (!id) return NativeFetch(request);

            const originalResponse = await NativeFetch(request.clone());
            if (!originalResponse.ok) return originalResponse;

            let initialPayload;
            try {
                initialPayload = await originalResponse.clone().json();
            } catch {
                return originalResponse;
            }

            try {
                const merged = await expandConversation(initialPayload, id, request);
                if (!merged) return originalResponse;

                const headers = new PageHeaders(originalResponse.headers);
                headers.delete('content-length');
                headers.set('content-type', 'application/json');

                return new PageResponse(JSON.stringify(merged), {
                    status: originalResponse.status,
                    statusText: originalResponse.statusText,
                    headers,
                });
            } catch (error) {
                warn('FullHistory: could not inject full history', error);
                return originalResponse;
            }
        };

        log('FullHistory: fetch interceptor installed');
    })();

    // ========================================================================
    // 2. COMPOSER FORMAT GUARD
    //    Adapted from Mehver's ChatGPT-ComposerFormatGuard (BSD-3-Clause).
    // ========================================================================

    const COMPOSER_SELECTOR = [
        '#thread-bottom form[data-type="unified-composer"] #prompt-textarea.ProseMirror[contenteditable="true"]',
        'form[data-type="unified-composer"] #prompt-textarea.ProseMirror[contenteditable="true"]',
        '#prompt-textarea.ProseMirror[contenteditable="true"]',
    ].join(', ');

    const FORMAT_GUARD_STORAGE_KEY = 'chatgptComposerFormatGuardEnabled';
    const FORMAT_GUARD_TOGGLE_ID = 'chatgpt-composer-format-guard-toggle';
    const FORMAT_SHORTCUTS = new Set(['b', 'i', 'u']);
    const LIST_INPUT_TYPES = new Set(['insertOrderedList', 'insertUnorderedList']);
    const HTML_BLOCK_TAGS = new Set([
        'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT',
        'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3',
        'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE',
        'SECTION', 'TABLE', 'TD', 'TH', 'TR', 'UL',
    ]);
    const HTML_IGNORED_TAGS = new Set([
        'EMBED', 'IFRAME', 'NOSCRIPT', 'OBJECT', 'SCRIPT', 'STYLE', 'TEMPLATE', 'TITLE',
    ]);

    let formatGuardEnabled = getFormatGuardPreference();
    let composing = false;

    function getComposer(target) {
        return target instanceof Element ? target.closest(COMPOSER_SELECTOR) : null;
    }

    function containsFile(clipboardData) {
        return Array.from(clipboardData.items || []).some(item => item.kind === 'file');
    }

    function getClipboardText(clipboardData) {
        const plainText = clipboardData.getData('text/plain');
        if (plainText) return plainText;

        const html = clipboardData.getData('text/html');
        if (!html) return '';

        const parsed = new DOMParser().parseFromString(html, 'text/html');
        const text = [];

        function appendBreak() {
            if (text.length && !text[text.length - 1].endsWith('\n')) text.push('\n');
        }

        function isBlockBoundary(node) {
            return node && node.nodeType === 1 &&
                (node.tagName === 'BR' || HTML_BLOCK_TAGS.has(node.tagName));
        }

        function readNode(node) {
            if (node.nodeType === 3) {
                const value = node.nodeValue || '';
                const previous = node.previousSibling;
                const next = node.nextSibling;
                const isPreformatted = node.parentElement && node.parentElement.closest('pre, textarea');

                if (!value.trim() && !isPreformatted) {
                    if (isBlockBoundary(previous) || isBlockBoundary(next)) return;
                    text.push(/[\r\n\t]/.test(value) ? ' ' : value);
                    return;
                }

                text.push(value);
                return;
            }

            if (node.nodeType !== 1) return;
            if (HTML_IGNORED_TAGS.has(node.tagName)) return;

            if (node.tagName === 'BR') {
                text.push('\n');
                return;
            }

            const isBlock = HTML_BLOCK_TAGS.has(node.tagName);
            if (isBlock) appendBreak();
            for (const child of node.childNodes) readNode(child);
            if (isBlock) appendBreak();
        }

        readNode(parsed.body);
        return text.join('').replace(/^\n+|\n+$/g, '');
    }

    function getFormatGuardPreference() {
        try {
            if (typeof GM_getValue === 'function') {
                return GM_getValue(FORMAT_GUARD_STORAGE_KEY, true) !== false;
            }
        } catch (error) {
            warn('FormatGuard: unable to read saved setting', error);
        }

        return localStorage.getItem(FORMAT_GUARD_STORAGE_KEY) !== 'false';
    }

    function setFormatGuardPreference(value) {
        formatGuardEnabled = value;

        try {
            if (typeof GM_setValue === 'function') {
                GM_setValue(FORMAT_GUARD_STORAGE_KEY, value);
            } else {
                localStorage.setItem(FORMAT_GUARD_STORAGE_KEY, String(value));
            }
        } catch (error) {
            warn('FormatGuard: unable to save setting', error);
        }

        updateFormatGuardToggle();
    }

    function createPlainTextPasteEvent(text) {
        try {
            const rawClipboard = new DataTransfer();
            rawClipboard.setData('text/plain', text.replace(/\r\n?/g, '\n'));

            return new ClipboardEvent('paste', {
                bubbles: true,
                cancelable: true,
                composed: true,
                clipboardData: rawClipboard,
            });
        } catch (error) {
            warn('FormatGuard: unable to create plain-text paste event', error);
            return null;
        }
    }

    document.addEventListener('paste', event => {
        if (
            !formatGuardEnabled ||
            composing ||
            !event.isTrusted ||
            event.defaultPrevented
        ) return;

        const composer = getComposer(event.target);
        const clipboardData = event.clipboardData;
        if (!composer || !clipboardData || containsFile(clipboardData)) return;

        const plainText = getClipboardText(clipboardData);
        if (!plainText) return;

        const rawPasteEvent = createPlainTextPasteEvent(plainText);
        if (!rawPasteEvent) return;

        event.preventDefault();
        event.stopImmediatePropagation();
        composer.dispatchEvent(rawPasteEvent);
    }, true);

    document.addEventListener('beforeinput', event => {
        if (
            !formatGuardEnabled ||
            composing ||
            !event.isTrusted ||
            event.defaultPrevented ||
            event.isComposing
        ) return;

        const composer = getComposer(event.target);
        if (!composer) return;

        const inputType = event.inputType || '';

        if (inputType === 'insertText' && event.data) {
            const rawPasteEvent = createPlainTextPasteEvent(event.data);
            if (!rawPasteEvent) return;

            event.preventDefault();
            event.stopImmediatePropagation();
            composer.dispatchEvent(rawPasteEvent);
            return;
        }

        if (
            (inputType.startsWith('format') && inputType !== 'formatSetBlockTextDirection') ||
            LIST_INPUT_TYPES.has(inputType)
        ) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    }, true);

    document.addEventListener('keydown', event => {
        if (
            !formatGuardEnabled ||
            composing ||
            !event.isTrusted ||
            event.defaultPrevented ||
            event.isComposing
        ) return;

        if (
            (!event.ctrlKey && !event.metaKey) ||
            event.altKey ||
            !FORMAT_SHORTCUTS.has(event.key.toLowerCase())
        ) return;

        if (!getComposer(event.target)) return;

        event.preventDefault();
        event.stopImmediatePropagation();
    }, true);

    document.addEventListener('compositionstart', event => {
        if (getComposer(event.target)) composing = true;
    }, true);

    document.addEventListener('compositionend', event => {
        if (!getComposer(event.target)) return;
        window.setTimeout(() => {
            composing = false;
        }, 0);
    }, true);

    function updateFormatGuardToggle() {
        const toggle = document.getElementById(FORMAT_GUARD_TOGGLE_ID);
        if (!toggle) return;

        toggle.style.background = formatGuardEnabled ? '#10a37f' : '#6e6e80';
        toggle.style.boxShadow = formatGuardEnabled
            ? '0 2px 10px rgba(16, 163, 127, 0.42)'
            : '0 2px 10px rgba(0, 0, 0, 0.24)';
        toggle.style.opacity = formatGuardEnabled ? '1' : '0.72';
        toggle.setAttribute('aria-pressed', String(formatGuardEnabled));
        toggle.setAttribute(
            'aria-label',
            `Raw Markdown: ${formatGuardEnabled ? 'включён' : 'выключен'}`
        );
        toggle.title = `Raw Markdown: ${formatGuardEnabled ? 'включён' : 'выключен'}`;
    }

    function mountFormatGuardToggle() {
        if (document.getElementById(FORMAT_GUARD_TOGGLE_ID)) return true;
        if (!document.querySelector(COMPOSER_SELECTOR) || !document.body) return false;

        const toggle = document.createElement('button');
        toggle.id = FORMAT_GUARD_TOGGLE_ID;
        toggle.type = 'button';
        toggle.textContent = 'MD';
        toggle.style.cssText = [
            'all:unset',
            'box-sizing:border-box',
            'position:fixed',
            'right:20px',
            'bottom:96px',
            'z-index:1000',
            'display:flex',
            'align-items:center',
            'justify-content:center',
            'width:42px',
            'height:42px',
            'border:1px solid rgba(255,255,255,0.28)',
            'border-radius:50%',
            'color:#fff',
            'font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace',
            'font-size:12px',
            'font-weight:700',
            'letter-spacing:-0.5px',
            'cursor:pointer',
            'user-select:none',
            'transition:transform 0.15s ease,opacity 0.15s ease,background 0.15s ease,box-shadow 0.15s ease',
        ].join(';');

        toggle.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            setFormatGuardPreference(!formatGuardEnabled);
        });

        toggle.addEventListener('mouseenter', () => {
            toggle.style.transform = 'scale(1.08)';
        });
        toggle.addEventListener('mouseleave', () => {
            toggle.style.transform = '';
        });

        document.body.appendChild(toggle);
        updateFormatGuardToggle();
        return true;
    }

    function installFormatGuardToggle() {
        mountFormatGuardToggle();

        let scheduled = false;
        const observer = new MutationObserver(() => {
            if (document.getElementById(FORMAT_GUARD_TOGGLE_ID) || scheduled) return;

            scheduled = true;
            window.requestAnimationFrame(() => {
                scheduled = false;
                mountFormatGuardToggle();
            });
        });

        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', installFormatGuardToggle, { once: true });
    } else {
        installFormatGuardToggle();
    }

    // ========================================================================
    // 3. MARKDOWN RENDER ON SEND
    // ========================================================================

    (() => {
        const EDITOR = '#prompt-textarea.ProseMirror[contenteditable="true"]';
        const SEND = [
            '#composer-submit-button',
            'button[data-testid="send-button"]',
            'button[aria-label="Send prompt"]',
        ].join(',');
        const FORM = 'form[data-type="unified-composer"]';

        let busy = false;
        let bypass = false;

        function getEditor(form = null) {
            return form?.querySelector(EDITOR) || document.querySelector(EDITOR);
        }

        function getRawText(editor) {
            return (editor.innerText || '')
                .replace(/\u00a0/g, ' ')
                .replace(/\r\n?/g, '\n')
                .replace(/\n+$/, '');
        }

        function looksLikeMarkdown(text) {
            return (
                /(^|\n)\s{0,3}(#{1,6}\s|>\s|[-+*]\s|\d+[.)]\s|```|~~~)/m.test(text) ||
                /(\*\*[^*\n]+\*\*|__[^_\n]+__)/.test(text) ||
                /(\*[^*\n]+\*|_[^_\n]+_)/.test(text) ||
                /~~[^~\n]+~~/.test(text) ||
                /`[^`\n]+`/.test(text) ||
                /\[[^\]]+\]\([^)]+\)/.test(text)
            );
        }

        function sanitizeHTML(html) {
            const template = document.createElement('template');
            template.innerHTML = html;

            const allowed = new Set([
                'P', 'BR',
                'STRONG', 'B',
                'EM', 'I',
                'S', 'DEL',
                'CODE', 'PRE',
                'BLOCKQUOTE',
                'UL', 'OL', 'LI',
                'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
                'HR', 'A',
                'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD',
            ]);

            const removeCompletely = new Set([
                'SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED',
                'SVG', 'MATH', 'FORM', 'INPUT', 'BUTTON',
            ]);

            const elements = [...template.content.querySelectorAll('*')];

            for (const element of elements) {
                const tag = element.tagName;

                if (removeCompletely.has(tag)) {
                    element.remove();
                    continue;
                }

                if (!allowed.has(tag)) {
                    element.replaceWith(...Array.from(element.childNodes));
                    continue;
                }

                const href = tag === 'A' ? element.getAttribute('href') : null;
                const title = tag === 'A' ? element.getAttribute('title') : null;
                const start = tag === 'OL' ? element.getAttribute('start') : null;

                for (const attr of [...element.attributes]) {
                    element.removeAttribute(attr.name);
                }

                if (tag === 'A' && href) {
                    try {
                        const url = new URL(href, location.href);
                        if (
                            url.protocol === 'http:' ||
                            url.protocol === 'https:' ||
                            url.protocol === 'mailto:'
                        ) {
                            element.setAttribute('href', href);
                            if (title) element.setAttribute('title', title);
                        }
                    } catch {
                        // Leave malformed links as plain anchor text.
                    }
                }

                if (tag === 'OL' && start && /^\d+$/.test(start)) {
                    element.setAttribute('start', start);
                }
            }

            return template.innerHTML;
        }

        function markdownToHTML(markdown) {
            const parser = globalThis.marked;
            if (!parser?.parse) {
                throw new Error('Marked library was not loaded');
            }

            const html = parser.parse(markdown, {
                gfm: true,
                breaks: true,
            });

            return sanitizeHTML(html);
        }

        function selectEverything(editor) {
            editor.focus();

            const selection = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(editor);
            selection.removeAllRanges();
            selection.addRange(range);
        }

        function replaceWithHTML(editor, html, plainText) {
            selectEverything(editor);

            try {
                if (document.execCommand('insertHTML', false, html)) {
                    return true;
                }
            } catch (error) {
                warn('MarkdownSend: insertHTML failed', error);
            }

            try {
                selectEverything(editor);

                const clipboard = new DataTransfer();
                clipboard.setData('text/html', html);
                clipboard.setData('text/plain', plainText);

                const paste = new ClipboardEvent('paste', {
                    clipboardData: clipboard,
                    bubbles: true,
                    cancelable: true,
                    composed: true,
                });

                editor.dispatchEvent(paste);
                return true;
            } catch (error) {
                warn('MarkdownSend: HTML paste failed', error);
                return false;
            }
        }

        function frame() {
            return new Promise(resolve => requestAnimationFrame(resolve));
        }

        async function nativeSend(form) {
            // Two frames give ProseMirror/React time to accept the new rich-text state.
            await frame();
            await frame();

            let button = form?.querySelector(SEND) || document.querySelector(SEND);

            for (let i = 0; i < 10 && (!button || button.disabled); i++) {
                await new Promise(resolve => setTimeout(resolve, 25));
                button = form?.querySelector(SEND) || document.querySelector(SEND);
            }

            bypass = true;

            try {
                if (button && !button.disabled) {
                    button.click();
                    return;
                }

                if (form && typeof form.requestSubmit === 'function') {
                    form.requestSubmit();
                    return;
                }

                warn('MarkdownSend: send button not found');
            } finally {
                setTimeout(() => {
                    bypass = false;
                }, 0);
            }
        }

        async function formatAndSend(editor, form) {
            if (busy) return;

            const raw = getRawText(editor);
            if (!raw.trim()) return;

            // Ordinary messages are sent untouched.
            if (!looksLikeMarkdown(raw)) {
                bypass = true;

                try {
                    const button = form?.querySelector(SEND) || document.querySelector(SEND);
                    if (button) button.click();
                    else form?.requestSubmit?.();
                } finally {
                    setTimeout(() => {
                        bypass = false;
                    }, 0);
                }

                return;
            }

            busy = true;

            try {
                const html = markdownToHTML(raw);
                const success = replaceWithHTML(editor, html, raw);

                if (!success) {
                    warn('MarkdownSend: could not update composer');
                    return;
                }

                await nativeSend(form);
            } catch (error) {
                warn('MarkdownSend: error', error);
            } finally {
                setTimeout(() => {
                    busy = false;
                }, 200);
            }
        }

        document.addEventListener('keydown', event => {
            if (
                bypass ||
                busy ||
                !event.isTrusted ||
                event.isComposing ||
                event.key !== 'Enter' ||
                event.shiftKey ||
                event.altKey
            ) return;

            const editor = event.target instanceof Element
                ? event.target.closest(EDITOR)
                : null;

            if (!editor) return;

            const raw = getRawText(editor);
            if (!looksLikeMarkdown(raw)) return;

            event.preventDefault();
            event.stopImmediatePropagation();

            const form = editor.closest(FORM);
            formatAndSend(editor, form);
        }, true);

        document.addEventListener('click', event => {
            if (bypass || busy || !event.isTrusted) return;

            const button = event.target instanceof Element
                ? event.target.closest(SEND)
                : null;

            if (!button) return;

            const form = button.closest(FORM);
            const editor = getEditor(form);
            if (!editor) return;

            const raw = getRawText(editor);
            if (!looksLikeMarkdown(raw)) return;

            event.preventDefault();
            event.stopImmediatePropagation();
            formatAndSend(editor, form);
        }, true);

        document.addEventListener('submit', event => {
            if (bypass || busy || !event.isTrusted) return;

            const form = event.target;
            if (!(form instanceof HTMLFormElement) || !form.matches(FORM)) return;

            const editor = getEditor(form);
            if (!editor) return;

            const raw = getRawText(editor);
            if (!looksLikeMarkdown(raw)) return;

            event.preventDefault();
            event.stopImmediatePropagation();
            formatAndSend(editor, form);
        }, true);

        log('MarkdownSend: installed');
    })();

    log('Fixpack loaded');
})();
