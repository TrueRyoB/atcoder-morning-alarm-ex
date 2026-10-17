// ==UserScript==
// @name         AtCoder 目覚まし
// @namespace    atcoder-morning-alarm
// @version      1.1.0
// @author       breso (original author); TrueRyoB / x.com/TrueAraki (modifications)
// @homepageURL  https://x.com/TrueAraki
// @license      MIT
// @description  AtCoderの問題を出題する目覚まし。Original work by breso; time-zone, virtual-contest, and custom-media changes by TrueRyoB (x.com/TrueAraki).
// @match        https://atcoder.jp/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @connect      kenkoooo.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
    'use strict';
    // Original work by breso. Modifications in this version by TrueRyoB (https://x.com/TrueAraki).
    const DEFAULT = {user: '', hour: 10, minute: 0, time_zone: 'Asia/Tokyo', pool: 'contests', virtual_contest_id: '', min_diff: 800, max_diff: 1599, contests: ['abc'], only_unsolved: true};
    const PREFIX = 'alarm.browser.v1.';
    function jst(now) {
        return zonedTime(now, 'Asia/Tokyo');
    }
    function timeZoneOf(config) { return config?.time_zone === 'America/Chicago' ? 'America/Chicago' : 'Asia/Tokyo'; }
    function zonedTime(now, timeZone) {
        const parts = new Intl.DateTimeFormat('en-CA', {timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).formatToParts(new Date(now));
        const value = type => Number(parts.find(p => p.type === type)?.value);
        const year = value('year'), month = value('month'), day = value('day');
        return {day: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, hour: value('hour'), minute: value('minute')};
    }
    function zonedTimestamp(day, hour, minute, timeZone) {
        const [year, month, date] = day.split('-').map(Number);
        const wanted = Date.UTC(year, month - 1, date, hour, minute);
        let timestamp = wanted;
        // Resolve the local wall-clock time through the zone offset, including CDT/CST changes.
        for (let i = 0; i < 3; i++) {
            const local = zonedTime(timestamp, timeZone);
            timestamp += wanted - Date.UTC(...local.day.split('-').map(Number).map((n, index) => index === 1 ? n - 1 : n), local.hour, local.minute);
        }
        // A time in the spring DST gap (for example 02:30 CDT/CST) does not exist.
        // Run it at the first real local minute after the requested wall-clock time.
        const requestedMinutes = hour * 60 + minute;
        for (let i = 0; i <= 180; i++, timestamp += 60000) {
            const local = zonedTime(timestamp, timeZone);
            if (local.day > day || local.day === day && local.hour * 60 + local.minute >= requestedMinutes) return timestamp;
        }
        return timestamp;
    }
    function timeZoneLabel(timeZone, now = Date.now()) {
        const name = new Intl.DateTimeFormat('en-US', {timeZone, timeZoneName: 'short'}).formatToParts(new Date(now)).find(p => p.type === 'timeZoneName')?.value;
        return timeZone === 'America/Chicago' ? `US Central (${name || 'CDT/CST'})` : 'JST';
    }
    function showUI(url, active = null, doc = null, acceptedURL = '') {
        try {
            const u = new URL(url);
            if (u.origin !== 'https://atcoder.jp') return false;
            if (u.pathname === '/home') return true;
            if (!active) return false;
            const base = `/contests/${active.contest_id}`;
            const task = `${base}/tasks/${active.id}`;
            if (u.pathname === task) return true;
            if (u.pathname === `${base}/submit`) {
                const selected = doc?.querySelector?.('[name="data.TaskScreenName"]');
                return (selected ? selected.value : u.searchParams.get('taskScreenName')) === active.id;
            }
            const hasTask = () => !!doc && Array.from(doc.querySelectorAll('a[href]')).some(a => pathOf(a) === task);
            if (u.pathname === `${base}/submissions` || u.pathname === `${base}/submissions/me`) {
                const filter = u.searchParams.get('f.Task');
                return filter === active.id || !filter && u.pathname.endsWith('/me') && hasTask();
            }
            if (u.pathname.startsWith(`${base}/submissions/`) && /^\d+$/.test(u.pathname.slice(`${base}/submissions/`.length))) {
                return !!(acceptedURL && new URL(acceptedURL).pathname === u.pathname) || hasTask();
            }
            return false;
        } catch { return false; }
    }
    function due(now, config, state, previous) {
        if (!/^[A-Za-z0-9_]+$/.test(config.user || '')) return false;
        const timeZone = timeZoneOf(config), t = zonedTime(now, timeZone);
        const target = zonedTimestamp(t.day, config.hour, config.minute, timeZone);
        return Number.isFinite(previous) && previous < target && target <= now && state.last_day !== t.day;
    }
    function timeReached(now, config) {
        const t = zonedTime(now, timeZoneOf(config));
        return t.hour * 60 + t.minute >= config.hour * 60 + config.minute;
    }
    function validate(config) {
        const c = {...config};
        if (!/^[A-Za-z0-9_]+$/.test(c.user)) throw new Error('AtCoderユーザー名を入力してください。');
        for (const k of ['hour', 'minute']) {
            if (!/^\d+$/.test(String(c[k]))) throw new Error('時刻・Difficultyには整数を入力してください。');
            c[k] = Number(c[k]);
        }
        if (c.hour > 23 || c.minute > 59) throw new Error('時刻は00:00〜23:59で指定してください。');
        c.time_zone = timeZoneOf(c);
        c.pool = c.pool === 'virtual' ? 'virtual' : 'contests';
        if (c.pool === 'virtual') {
            c.virtual_contest_id = virtualContestId(c.virtual_contest_id || c.virtual_contest_url);
        } else {
            for (const k of ['min_diff', 'max_diff']) {
                if (!/^\d+$/.test(String(c[k]))) throw new Error('Difficultyには整数を入力してください。');
                c[k] = Number(c[k]);
            }
            if (c.min_diff > c.max_diff || c.max_diff > 9999) throw new Error('Difficultyの下限・上限を確認してください。');
            if (!Array.isArray(c.contests) || !c.contests.length || c.contests.some(s => !['abc', 'arc', 'agc'].includes(s))) throw new Error('コンテストを1つ以上選んでください。');
        }
        c.only_unsolved = c.only_unsolved !== false;
        return c;
    }
    function virtualContestId(value) {
        const text = String(value || '').trim();
        if (/^[A-Za-z0-9-]+$/.test(text)) return text;
        try {
            const url = new URL(text);
            const match = url.origin === 'https://kenkoooo.com' && url.pathname === '/atcoder/' && url.hash.match(/^#\/contest\/show\/([A-Za-z0-9-]+)\/?$/);
            if (match) return match[1];
        } catch {}
        throw new Error('AtCoder Problems の Virtual Contest URL を入力してください。');
    }
    function candidates(data, history, config) {
        const solved = new Set(history.user === config.user ? history.solved : []);
        const virtualIds = new Set(config.virtual_problem_ids || data.virtualContests?.[config.virtual_contest_id]?.problem_ids || []);
        return data.problems.flatMap(p => {
            const raw = data.models[p.id]?.difficulty;
            const inPool = config.pool === 'virtual' ? virtualIds.has(p.id) : config.contests.some(s => p.contest_id.startsWith(s) && /^\d+$/.test(p.contest_id.slice(s.length)));
            if (!inPool || (config.only_unsolved !== false && solved.has(p.id))) return [];
            const difficulty = Number.isFinite(raw) ? Math.round(raw >= 400 ? raw : 400 * Math.exp(raw / 400 - 1)) : null;
            if (config.pool !== 'virtual' && (!Number.isFinite(difficulty) || difficulty < config.min_diff || difficulty > config.max_diff)) return [];
            return [{...p, difficulty}];
        });
    }
    function acceptAC(state, config, payload, run) {
        if (!state.ringing || !state.active || state.run !== run || payload.user !== config.user || payload.problem_id !== state.active.id || payload.result !== 'AC') return false;
        if (state.require_fresh && (!Number.isFinite(state.started_at) || !Number.isFinite(payload.submitted_at) || payload.submitted_at < Math.floor(state.started_at / 1000) * 1000)) return false;
        try {
            const u = new URL(payload.submission_url);
            return u.origin === 'https://atcoder.jp' && new RegExp(`^/contests/${state.active.contest_id}/submissions/\\d+$`).test(u.pathname);
        } catch { return false; }
    }
    function shouldSound(state, now) { return !!state.ringing && (state.mute_until || 0) <= now; }
    function submissionTime(text) {
        const normalized = String(text || '').trim().replace(/^(\d{4}-\d\d-\d\d)\s+/, '$1T').replace(/([+-]\d\d)(\d\d)$/, '$1:$2');
        const value = Date.parse(normalized);
        return Number.isFinite(value) ? value : null;
    }
    async function routeOutput(audio, deviceId) {
        if (typeof audio.setSinkId !== 'function') {
            return {fallback: !!deviceId, reason: deviceId ? 'このブラウザはスピーカー指定に対応していません。' : ''};
        }
        try { await audio.setSinkId(deviceId); return {fallback: false}; }
        catch (e) {
            await audio.setSinkId('');
            return {fallback: true, reason: '指定した機器を使用できません。接続と再生許可を確認してください。'};
        }
    }
    function pathOf(anchor) {
        try { const url = new URL(anchor.getAttribute('href'), 'https://atcoder.jp'); return url.origin === 'https://atcoder.jp' ? url.pathname : ''; } catch { return ''; }
    }

    function findAC(doc, state, pageURL) {
        const active = state.active;
        const task = `/contests/${active.contest_id}/tasks/${active.id}`;
        const owner = `/users/${state.user}`;
        const prefix = `/contests/${active.contest_id}/submissions/`;
        const pagePath = new URL(pageURL).pathname;
        const detail = pagePath.startsWith(prefix) && /^\d+$/.test(pagePath.slice(prefix.length));
        // List rows must be checked individually to avoid mixing different users.
        const groups = detail ? doc.querySelectorAll('table') : doc.querySelectorAll('table tbody tr');
        for (const group of groups) {
            const links = Array.from(group.querySelectorAll('a[href]'));
            if (!links.some(a => pathOf(a) === task) || !links.some(a => pathOf(a) === owner)) continue;
            let accepted = false;
            if (detail) {
                for (const row of group.querySelectorAll('tr')) {
                    const cells = Array.from(row.querySelectorAll('th,td'));
                    if (cells.length >= 2 && /^(Status|Result|結果|判定)$/i.test(cells[0].textContent.trim())) {
                        accepted = Array.from(cells[1].querySelectorAll('.label, #judge-status')).some(el => el.textContent.trim() === 'AC') || cells[1].textContent.trim() === 'AC';
                        if (accepted) break;
                    }
                }
            } else {
                accepted = Array.from(group.querySelectorAll('.label')).some(el => el.textContent.trim() === 'AC');
            }
            if (!accepted) continue;
            const link = detail ? pagePath : links.map(pathOf).find(p => p.startsWith(prefix) && /^\d+$/.test(p.slice(prefix.length)));
            if (link) {
                const time = group.querySelectorAll('time')[0];
                return {user: state.user, problem_id: active.id, result: 'AC', submission_url: 'https://atcoder.jp' + link, submitted_at: time ? submissionTime(time.getAttribute('datetime') || time.textContent) : null};
            }
        }
        return null;
    }



    if (typeof module !== 'undefined' && module.exports && typeof document === 'undefined') {
        module.exports = {jst, zonedTime, zonedTimestamp, timeZoneOf, due, timeReached, showUI, validate, virtualContestId, candidates, acceptAC, shouldSound, findAC, routeOutput, submissionTime};
        return;
    }

    const get = (key, fallback) => GM_getValue(PREFIX + key, fallback);
    const put = (key, value) => GM_setValue(PREFIX + key, value);
    const tab = crypto.randomUUID();
    const config = () => get('config', DEFAULT);
    const state = () => get('state', {});
    const history = () => get('history', {user: config().user, cursor: 0, solved: []});
    let dataset = get('data', null);
    let context = null;
    let source = null;
    let buffer = null;
    let defaultBuffer = null;
    let customSound = get('sound', null);
    let decodedSound = null;
    let loadedSound = null;
    let soundQueue = Promise.resolve();
    let uiMounted = false;
    let preparing = false;
    let checking = false;
    let lastCheck = 0;
    let retryPrepare = 0;
    let prepareFailures = 0;
    let lastTick = Date.now();
    let scheduleBusy = false;
    let audioAttempt = 0;
    let leaseRenewed = 0;
    let timeEdited = false;
    let outputApplied = null;
    let outputQueue = Promise.resolve();
    let soundDatabasePromise = null;
    function soundDatabase() {
        if (!soundDatabasePromise) soundDatabasePromise = new Promise((resolve, reject) => {
            const request = indexedDB.open('atcoder-morning-alarm-media', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('media');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('ブラウザのメディア保存領域を開けませんでした。'));
        });
        return soundDatabasePromise;
    }
    async function storeSoundFile(id, file) {
        const db = await soundDatabase();
        await new Promise((resolve, reject) => {
            const transaction = db.transaction('media', 'readwrite');
            transaction.objectStore('media').put(file, id);
            transaction.oncomplete = resolve;
            transaction.onerror = () => reject(transaction.error || new Error('ファイルを保存できませんでした。'));
            transaction.onabort = () => reject(transaction.error || new Error('ファイルの保存が中断されました。'));
        });
    }
    async function readStoredSound(selected) {
        if (selected.storage !== 'indexeddb') {
            // Keep sounds saved by versions before 1.1.0 usable while users replace them.
            const binary = atob(selected.data || '');
            return Uint8Array.from(binary, c => c.charCodeAt(0)).buffer;
        }
        const db = await soundDatabase();
        const file = await new Promise((resolve, reject) => {
            const request = db.transaction('media', 'readonly').objectStore('media').get(selected.id);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('ファイルを読み込めませんでした。'));
        });
        if (!file) throw new Error('保存したファイルが見つかりません。もう一度選択してください。');
        return file.arrayBuffer();
    }
    async function deleteStoredSound(id) {
        if (!id) return;
        try {
            const db = await soundDatabase();
            await new Promise((resolve, reject) => {
                const transaction = db.transaction('media', 'readwrite');
                transaction.objectStore('media').delete(id);
                transaction.oncomplete = resolve;
                transaction.onerror = () => reject(transaction.error);
            });
        } catch { /* The metadata is already enough to stop using this file. */ }
    }
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647';
    const ui = host.attachShadow({mode: 'open'});
    ui.innerHTML = `<style>
      *{box-sizing:border-box}section{font:14px/1.6 system-ui,sans-serif;color:#172033;width:390px;max-width:calc(100vw - 32px);background:#f8fafc;border:1px solid #cbd5e1;border-radius:16px;box-shadow:0 12px 40px #0f172a26;overflow:hidden}header{display:flex;align-items:center;justify-content:space-between;background:#172033;color:white;padding:12px 16px}header strong{font-size:16px}button{cursor:pointer;border:1px solid #cbd5e1;border-radius:8px;background:white;color:#172033;padding:8px 11px;font:inherit}button.primary{background:#047857;border-color:#047857;color:white}button:disabled{opacity:.5;cursor:default}.body{padding:16px;max-height:75vh;overflow:auto}.small{font-size:12px;color:#64748b}h3{font-size:18px;margin:12px 0 2px}.actions{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0}details{margin-top:12px;border-top:1px solid #e2e8f0;padding-top:10px}label{display:block;margin:8px 0}input:not([type=checkbox]){width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:7px;font:inherit}.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.checks{display:flex;gap:14px}.checks label{margin:0}#status{white-space:pre-wrap}.warn{background:#fffbeb;border-radius:8px;padding:10px;margin:12px 0;font-size:12px}#toggle{background:transparent;border:0;color:white}
      select{width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:7px;font:inherit}
      [hidden]{display:none!important}section.compact{width:auto;max-width:none;background:transparent;border:0;border-radius:0;box-shadow:none;overflow:visible}.compact header{padding:0;background:transparent}.compact header strong{display:none}.compact #toggle{background:#172033;border-radius:20px;padding:7px 12px;font-size:12px;box-shadow:0 3px 12px #0f172a26}
      #success{background:#dcfce7;border:2px solid #16a34a;border-radius:10px;padding:14px;margin:12px 0;color:#166534}#success strong{display:block;font-size:23px}#success a{color:#166534;text-decoration:underline}.credit{margin:16px 0 0}.credit a{color:inherit}.compact #toggle.completed{background:#15803d}
      </style><section id="panel"><header><strong>AtCoder 目覚まし</strong><button id="toggle">縮める</button></header><div class="body" id="body">
      <div id="schedule" class="small"></div><p id="audio" class="small"></p>
      <div id="success" role="status" aria-live="polite" hidden><strong>✓ AC確認済み</strong><div>アラームを停止しました</div><a id="accepted" target="_blank" rel="noopener">ACした提出を見る</a></div>
      <h3 id="problem" hidden></h3><div id="diff" class="small" hidden></div><p id="status" hidden></p>
      <div class="actions"><button id="open">問題を開く</button><button id="results">提出結果</button><button id="switch">別の問題</button></div>
      <div class="actions"><button id="mute">5分間だけ消音</button><button id="test">音を3秒テスト</button><button id="prepare">データを更新</button></div>
      <details id="settingsSection"><summary>時刻・出題範囲の設定</summary><form id="settings">
      <label>AtCoderユーザー名<input id="user" required></label><div class="grid"><label>毎日の時刻<input id="time" type="time" required></label><label>時刻の地域<select id="timeZone"><option value="Asia/Tokyo">JST (Asia/Tokyo)</option><option value="America/Chicago">US Central (CDT/CST)</option></select></label></div>
      <label>問題プール<select id="pool"><option value="contests">ABC / ARC / AGC から選ぶ</option><option value="virtual">AtCoder Problems の Virtual Contest から選ぶ</option></select></label>
      <div id="standardPool"><div class="checks"><label><input type="checkbox" id="abc">ABC</label><label><input type="checkbox" id="arc">ARC</label><label><input type="checkbox" id="agc">AGC</label></div>
      <div class="grid"><label>Difficulty 下限<input id="low" type="number" min="0" max="9999" required></label><label>上限<input id="high" type="number" min="0" max="9999" required></label></div>
      <div class="actions"><button type="button" data-range="800,1199">緑</button><button type="button" data-range="1200,1599">水色</button><button type="button" data-range="800,1599">緑〜水色</button></div></div>
      <div id="virtualPool" hidden><label>Virtual Contest URL<input id="virtualContest" type="url" placeholder="https://kenkoooo.com/atcoder/#/contest/show/..." inputmode="url"></label><p class="small">このプールでは Difficulty 範囲を指定せず、Virtual Contest に入っている問題から選びます。</p></div>
      <label><input type="checkbox" id="onlyUnsolved">未ACの問題だけ出題する</label>
      <div class="actions"><button class="primary" type="submit">保存</button></div>
      </form></details><details><summary>アラーム音</summary>
      <label>音声・動画ファイル（10MB・5分以内、音声トラックが必要）<input id="soundFile" type="file" accept="audio/*,video/*,.mp3,.wav,.ogg,.m4a,.flac,.mp4,.webm"></label>
      <p class="small" id="soundName"></p><button id="resetSound">標準の音に戻す</button>
      <p class="small">選んだファイルの音声を繰り返し再生します。データはこのブラウザの IndexedDB に保存し、外部には送信しません。</p></details><details><summary>音の出力先</summary>
      <label>スピーカー（選ぶと保存）<select id="speaker"><option value="">OSの既定の出力先</option></select></label>
      <div class="actions"><button id="devices">一覧を更新</button><button id="permitDevices"></button></div>
      <p class="small" id="outputStatus"></p><p class="small">ブラウザによっては全機器の表示にマイク許可が必要です。許可を取得したら入力を直ちに停止し、録音・送信は行いません。</p></details>
      <p class="small credit">Original userscript: breso. This version’s changes: <a href="https://x.com/TrueAraki" target="_blank" rel="noopener">TrueRyoB (@TrueAraki)</a>.</p>
      </div></section>`;
    const $ = id => ui.getElementById(id);
    const message = text => put('message', text);
    const random = items => items[Math.floor(Math.random() * items.length)];
    const stamp = c => JSON.stringify(c);
    function updateForm() {
        const c = config();
        $('user').value = c.user;
        $('time').value = `${String(c.hour).padStart(2, '0')}:${String(c.minute).padStart(2, '0')}`;
        $('timeZone').value = timeZoneOf(c);
        $('pool').value = c.pool === 'virtual' ? 'virtual' : 'contests';
        $('virtualContest').value = c.virtual_contest_id || '';
        $('low').value = c.min_diff; $('high').value = c.max_diff;
        for (const s of ['abc', 'arc', 'agc']) $(s).checked = c.contests.includes(s);
        $('onlyUnsolved').checked = c.only_unsolved !== false;
        updatePoolFields();
        timeEdited = false;
    }
    function updatePoolFields() {
        const virtual = $('pool').value === 'virtual';
        $('standardPool').hidden = virtual;
        $('virtualPool').hidden = !virtual;
        $('low').disabled = $('high').disabled = virtual;
        for (const id of ['abc', 'arc', 'agc']) $(id).disabled = virtual;
    }
    function stopSound() { if (source) { try { source.stop(); } catch {} source = null; } }
    function startSound() {
        if (source || !context || context.state !== 'running' || outputApplied !== get('output', {id:''}).id || loadedSound !== (customSound?.id || 'default')) return;
        source = context.createBufferSource(); source.buffer = buffer; source.loop = true;
        source.connect(context.destination); source.start();
    }
    function soundState() {
        if (get('owner', '') === tab && shouldSound(state(), Date.now())) startSound(); else stopSound();
    }
    function loadAlarmSound() {
        soundQueue = soundQueue.catch(() => {}).then(async () => {
            if (!context) return;
            const selected = customSound;
            const id = selected?.id || 'default';
            if (loadedSound === id) return;
            stopSound();
            let next = defaultBuffer;
            if (selected) {
                try {
                    if (!decodedSound || decodedSound.id !== id) decodedSound = {id, buffer: await context.decodeAudioData((await readStoredSound(selected)).slice(0))};
                    next = decodedSound.buffer;
                } catch (_) { message('保存したアラーム音を読み込めませんでした。標準の音で再生します。'); }
            }
            buffer = next; loadedSound = id;
            render();
        });
        return soundQueue;
    }
    function applyOutput() {
        outputQueue = outputQueue.catch(() => {}).then(async () => {
            if (!context) return;
            const selected = get('output', {id:'', label:'OSの既定の出力先'});
            if (outputApplied === selected.id) return;
            stopSound();
            const result = await routeOutput(context, selected.id);
            outputApplied = selected.id;
            $('outputStatus').textContent = result.fallback ? result.reason + ' OSの既定の出力先で再生します。' : '出力先：' + selected.label;
            render();
        });
        return outputQueue;
    }
    async function loadOutputs() {
        if (!navigator.mediaDevices?.enumerateDevices) { $('outputStatus').textContent='このブラウザでは機器一覧を取得できません。'; return; }
        const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==='audiooutput' && d.deviceId);
        const selected = get('output', {id:'',label:'OSの既定の出力先'});
        $('speaker').replaceChildren();
        const add = (id,label) => { const option=document.createElement('option');option.value=id;option.textContent=label;$('speaker').append(option); };
        add('', 'OSの既定の出力先');
        for (const [i,d] of devices.entries()) add(d.deviceId, d.label || `出力機器 ${i+1}`);
        if (selected.id && !devices.some(d=>d.deviceId===selected.id)) add(selected.id,selected.label+'（未検出・未許可）');
        $('speaker').value=selected.id;
        if (!context) $('outputStatus').textContent='保存済み：'+selected.label;
    }
    function render() {
        const c = config(), s = state(), completed = !s.ringing && s.completed?.user === c.user ? s.completed : null, p = s.active || completed?.problem;
        updateLayout();
        if (!c.user) { $('settingsSection').open = true; $('body').hidden = false; $('panel').className = ''; $('toggle').textContent = '縮める'; }
        const visible = showUI(location.href, p, document, completed?.submission_url);
        if (visible !== uiMounted) {
            if (visible) { document.body.append(host); loadOutputs().catch(()=>{}); }
            else host.remove();
            uiMounted = visible;
        }
        $('soundName').textContent = customSound ? '現在の音：' + customSound.name : '現在の音：標準のビープ音';
        $('resetSound').disabled = !customSound;
        $('success').hidden = !completed;
        $('accepted').href = completed?.submission_url || '';
        const poolLabel = c.pool === 'virtual' ? `Virtual Contest (${c.virtual_contest_id || '未設定'})` : `${c.contests.join('/').toUpperCase()} · Diff ${c.min_diff}〜${c.max_diff}`;
        $('schedule').textContent = `毎日 ${String(c.hour).padStart(2, '0')}:${String(c.minute).padStart(2, '0')} ${timeZoneLabel(timeZoneOf(c))} · ${poolLabel} · ${c.only_unsolved !== false ? '未ACのみ' : 'AC済みも含む'}`;
        const owner = get('owner', '');
        const own = owner === tab && context?.state === 'running';
        $('audio').textContent = s.ringing && owner === tab && !own ? '音の再生が制限されています。ページをクリックするかキーを押してください。' : '';
        $('audio').hidden = !$('audio').textContent;
        $('problem').textContent = p?.title || p?.id || (s.ringing ? '問題を取得中…' : '');
        $('problem').hidden = !$('problem').textContent;
        $('diff').textContent = p ? `${p.contest_id.toUpperCase()} · ${Number.isFinite(p.difficulty) ? `Difficulty ${p.difficulty}` : 'Difficulty 未設定'} · ${c.user}` : '';
        $('diff').hidden = !p;
        const text = get('message', '');
        $('status').textContent = !c.user ? '最初にAtCoderユーザー名と時刻を設定して保存してください。' : /^(準備完了|アラームを開始しました|設定・データは|履歴を更新しました。切り替え後)/.test(text) ? '' : text;
        $('status').hidden = !$('status').textContent;
        const remaining = Math.max(0, Math.ceil(((s.mute_until || 0) - Date.now()) / 1000));
        $('mute').textContent = remaining ? `消音中 ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}` : '5分間だけ消音';
        $('mute').disabled = !s.ringing || remaining > 0;
        $('open').disabled = $('results').disabled = !p;
        $('switch').disabled = !s.ringing || !dataset || preparing;
        $('prepare').disabled = preparing;
        soundState();
    }
    async function api(endpoint) {
        // AtCoder Problems asks API consumers to leave more than one second between calls.
        const pause = Math.max(0, 1500 - (Date.now() - get('lastApi', 0)));
        await new Promise(r => setTimeout(r, pause));
        put('lastApi', Date.now());
        return new Promise((resolve, reject) => GM_xmlhttpRequest({
            method: 'GET', url: 'https://kenkoooo.com/atcoder/' + endpoint, timeout: 25000,
            onload: r => { try { if (r.status !== 200) throw new Error(`APIエラー ${r.status}`); resolve(JSON.parse(r.responseText)); } catch (e) { reject(e); } },
            onerror: () => reject(new Error('問題取得の通信に失敗しました。再度「データを更新」を押してください。')),
            ontimeout: () => reject(new Error('問題取得がタイムアウトしました。')),
        }));
    }
    async function loadVirtualContest(c) {
        const id = c.virtual_contest_id;
        const cached = dataset?.virtualContests?.[id];
        if (cached && Date.now() - cached.updated < 3600000) return cached;
        message('Virtual Contest の問題一覧を取得しています…');
        const response = await api('internal-api/contest/get/' + encodeURIComponent(id));
        const problem_ids = [...new Set((response.problems || []).map(problem => typeof problem === 'string' ? problem : problem?.id || problem?.problem_id).filter(id => typeof id === 'string'))];
        if (!problem_ids.length) throw new Error('Virtual Contest に問題がありません。公開されている URL か確認してください。');
        const contest = {title: response.info?.title || id, problem_ids, updated: Date.now()};
        dataset = {...dataset, virtualContests: {...(dataset.virtualContests || {}), [id]: contest}};
        put('data', dataset);
        return contest;
    }
    async function prepareWork() {
        if (!config().user) return;
        if (preparing) return;
        preparing = true; render();
        const c = config(), signature = stamp(c), selectionVersion = state().selectionVersion || 0;
        const unchanged = () => { if (stamp(config()) !== signature) throw new Error('設定が変わりました。新しい設定で再度準備してください。'); };
        try {
            let h = history();
            if (h.user !== c.user) h = {user: c.user, cursor: 0, solved: []};
            while (true) {
                message(` ${c.user}の提出履歴を確認しています…（AC ${h.solved.length}問）`);
                const rows = await api('atcoder-api/v3/user/submissions?' + new URLSearchParams({user: c.user, from_second: h.cursor}));
                unchanged();
                const local = history();
                const solved = new Set([...h.solved, ...(local.user === c.user ? local.solved : []), ...rows.filter(r => r.result === 'AC').map(r => r.problem_id)]);
                const latest = rows.length ? Math.max(...rows.map(r => r.epoch_second)) : h.cursor;
                if (rows.length >= 500 && latest <= h.cursor) throw new Error('提出履歴の取得が進みませんでした。');
                h = {user: c.user, cursor: latest, solved: [...solved]}; put('history', h);
                if (rows.length < 500) break;
            }
            if (!dataset || Date.now() - dataset.updated > 86400000) {
                message('問題一覧と難易度を取得しています…');
                const problems = await api('resources/problems.json');
                const models = await api('resources/problem-models.json');
                unchanged(); dataset = {problems, models, virtualContests: dataset?.virtualContests || {}, updated: Date.now()}; put('data', dataset);
            }
            if (c.pool === 'virtual') { await loadVirtualContest(c); unchanged(); }
            unchanged();
            const pool = candidates(dataset, history(), c);
            if (!pool.length) throw new Error(c.pool === 'virtual' ? 'Virtual Contest 内に対象の問題がありません。未ACのみを解除するか Contest URL を確認してください。' : '指定範囲に対象の問題がありません。設定を広げてください。');
            const s = state();
            if ((s.selectionVersion || 0) !== selectionVersion) { message('履歴を更新しました。切り替え後の問題を維持します。'); return; }
            if (s.ringing && !s.active) { s.active = random(pool); s.run = crypto.randomUUID(); s.started_at = Date.now(); s.require_fresh = c.only_unsolved === false; }
            else if (!s.ringing) { s.ready = null; }
            put('state', s); message(''); prepareFailures = 0;
        } catch (e) {
            message(e.message);
            // Do not repeatedly poll a failing service: 30 s, 60 s, 2 min, 4 min, then 5 min.
            retryPrepare = Date.now() + Math.min(300000, 30000 * 2 ** prepareFailures);
            prepareFailures = Math.min(prepareFailures + 1, 4);
        }
        finally { preparing = false; render(); }
    }
    async function prepare() {
        if (navigator.locks) {
            await navigator.locks.request('atcoder-alarm-browser-prepare', {ifAvailable: true}, async lock => {
                if (lock) await prepareWork(); else message('別のタブで問題を準備しています。');
            });
        } else await prepareWork();
    }
    function switchProblem() {
        if (!state().ringing) return;
        if (!dataset) { message('先に問題を準備してください。'); return; }
        const s = state(), current = s.active;
        const pool = candidates(dataset, history(), config()).filter(p => p.id !== current?.id);
        if (!pool.length) { message('切り替え候補がありません。範囲を広げてください。'); return; }
        const p = random(pool);
        s.selectionVersion = (s.selectionVersion || 0) + 1;
        s.active = p; s.run = crypto.randomUUID(); s.started_at = Date.now(); s.require_fresh = config().only_unsolved === false;
        put('state', s); message('別の問題に切り替えました。'); render();
    }
    function finishAC(payload, expectedRun) {
        const s = state(), c = config();
        if (!acceptAC(s, c, payload, expectedRun)) return;
        const h = history();
        if (h.user === c.user) put('history', {...h, solved: [...new Set([...h.solved, payload.problem_id])]});
        put('state', {...s, ringing: false, active: null, ready: null, mute_until: 0, completed: {user: c.user, problem: s.active, submission_url: payload.submission_url, confirmed_at: Date.now()}});
        put('compact', false);
        message(''); stopSound(); render();
    }
    async function checkAC() {
        if (checking) return;
        const s = state(), c = config();
        if (!c.user || !s.ringing || !s.active) return;
        const view = {user: c.user, active: s.active};
        const onPage = findAC(document, view, location.href);
        if (onPage) { finishAC(onPage, s.run); return; }
        if (get('owner', '') !== tab || Date.now() - lastCheck < 5000) return;
        checking = true; lastCheck = Date.now();
        try {
            const url = `https://atcoder.jp/contests/${s.active.contest_id}/submissions?` + new URLSearchParams({'f.Task': s.active.id, 'f.User': c.user});
            const response = await fetch(url, {credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10000)});
            if (new URL(response.url).pathname === '/login') { message('AC確認にはAtCoderへのログインが必要です。'); return; }
            if (!response.ok) throw new Error('提出結果を取得できませんでした。');
            const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
            const ac = findAC(doc, view, response.url);
            if (ac) finishAC(ac, s.run);
        } catch (e) { message('AC確認を再試行します：' + e.message); }
        finally { checking = false; }
    }
    function claimOwner(now) {
        if (!get('owner', '') || now - get('ownerLease', 0) > 120000) put('owner', tab);
        if (get('owner', '') === tab && now - leaseRenewed >= 15000) { put('ownerLease', now); leaseRenewed = now; }
    }
    function beginAlarm(now) {
        const s = state(), c = config();
        if (!c.user || s.ringing) return;
        const pool = dataset ? candidates(dataset, history(), c) : [];
        put('state', {...s, ringing: true, active: pool.length ? random(pool) : null, completed: null, ready: null, started_at: now, require_fresh: c.only_unsolved === false, last_day: zonedTime(now, timeZoneOf(c)).day, run: crypto.randomUUID(), mute_until: 0});
        message('');
    }
    async function schedule(now, previous) {
        if (scheduleBusy) return;
        scheduleBusy = true;
        const start = () => {
            const s = state(), c = config();
            if (!s.ringing && due(now, c, s, previous)) beginAlarm(now);
        };
        try {
            if (navigator.locks) await navigator.locks.request('atcoder-alarm-browser-schedule', start);
            else start();
        } finally { scheduleBusy = false; render(); }
    }
    function tick() {
        const now = Date.now(), previous = lastTick;
        lastTick = now;
        claimOwner(now);
        if (!state().ringing && due(now, config(), state(), previous)) schedule(now, previous);
        if (get('owner', '') === tab) {
            const current = state();
            if (shouldSound(current, now) && context?.state !== 'running' && now - audioAttempt >= 5000) { audioAttempt = now; allowAudio().catch(() => {}); }
            if (current.ringing && !current.active && !preparing && now >= retryPrepare) { retryPrepare = now + 30000; prepare(); }
        }
        render(); checkAC();
    }
    function updateLayout() {
        const compact = get('compact', false);
        $('panel').className = compact ? 'compact' : '';
        $('body').hidden = compact;
        const completed = !state().ringing && state().completed?.user === config().user;
        $('toggle').textContent = compact ? (completed ? '✓ AC確認済み' : '目覚まし') : '縮める';
        $('toggle').className = completed ? 'completed' : '';
        $('toggle').title = compact ? '目覚ましを開く' : '目覚ましを縮める';
    }
    $('toggle').onclick = () => { put('compact', !get('compact', false)); updateLayout(); };
    function ensureAudioContext() {
            if (!context) {
                context = new AudioContext(); buffer = context.createBuffer(1, context.sampleRate, context.sampleRate);
                defaultBuffer = buffer;
                const samples = buffer.getChannelData(0);
                for (let i = 0; i < samples.length; i++) {
                    const t = i / context.sampleRate;
                    const phase = t < .3 ? t : t < .65 && t >= .35 ? t - .35 : -1;
                    if (phase >= 0) samples[i] = .16 * Math.sin(2 * Math.PI * (t < .3 ? 880 : 660) * phase) * Math.min(1, phase * 100, (.3 - phase) * 100);
                }
            }
    }
    async function allowAudio() {
            ensureAudioContext();
            await context.resume();
            if (context.state !== 'running') throw new Error('音の再生を許可してから、もう一度押してください。');
            await loadAlarmSound();
            await applyOutput();
            render();
    }
    const unlockAudio = async () => {
        try {
            await allowAudio();
            put('owner', tab); put('ownerLease', Date.now());
            render();
        } catch (_) { /* A later page interaction can retry audio playback. */ }
    };
    document.addEventListener('pointerdown', unlockAudio, {capture: true, passive: true});
    document.addEventListener('keydown', unlockAudio, {capture: true, passive: true});
    $('prepare').onclick = prepare; $('switch').onclick = switchProblem;
    $('mute').onclick = () => { const s = state(); if (s.ringing && (s.mute_until || 0) <= Date.now()) { put('state', {...s, mute_until: Date.now() + 300000}); message('5分間だけ消音します。AC確認は継続します。'); render(); } };
    $('test').onclick = async () => {
        if (state().ringing) { message('鳴動中・消音中の音テストは行いません。'); return; }
        try { await allowAudio(); } catch (e) { message(e.message); return; }
        const test = context.createBufferSource(); test.buffer = buffer; test.loop = true; test.connect(context.destination); test.start(); test.stop(context.currentTime + 3);
    };
    $('soundFile').onchange = async () => {
        const file = $('soundFile').files[0];
        if (!file) return;
        $('soundFile').disabled = true;
        try {
            if (!file.size || file.size > 10 * 1024 * 1024) throw new Error('0バイトより大きい、10MB以下の音声・動画ファイルを選んでください。');
            ensureAudioContext();
            const data = await file.arrayBuffer();
            const decoded = await context.decodeAudioData(data.slice(0));
            if (!Number.isFinite(decoded.duration) || decoded.duration <= 0 || decoded.duration > 300) throw new Error('音声トラックがあり、5分以内のファイルを選んでください。');
            const id = crypto.randomUUID();
            await storeSoundFile(id, file);
            const selected = {id, name: file.name, storage: 'indexeddb'};
            decodedSound = {id, buffer: decoded};
            const oldSound = customSound;
            put('sound', selected);
            customSound = selected;
            deleteStoredSound(oldSound?.storage === 'indexeddb' ? oldSound.id : '');
            await loadAlarmSound();
            message('アラーム音を保存しました。');
        } catch (e) { message('アラーム音を変更できませんでした：' + e.message); }
        finally { $('soundFile').disabled = false; $('soundFile').value = ''; render(); }
    };
    $('resetSound').onclick = () => { const oldSound = customSound; put('sound', null); deleteStoredSound(oldSound?.storage === 'indexeddb' ? oldSound.id : ''); message('標準のビープ音に戻しました。'); };
    $('devices').onclick = () => loadOutputs().catch(e=>{$('outputStatus').textContent='一覧を取得できませんでした：'+e.message;});
    const directSpeakerSelection = typeof navigator.mediaDevices?.selectAudioOutput === 'function';
    $('permitDevices').textContent = directSpeakerSelection ? 'ブラウザで出力先を選ぶ' : 'マイク許可で機器一覧を取得';
    $('permitDevices').onclick = async () => {
        try {
            if (directSpeakerSelection) {
                const device = await navigator.mediaDevices.selectAudioOutput();
                put('output',{id:device.deviceId,label:device.label || '選択したスピーカー'});
            } else {
                if (!navigator.mediaDevices?.getUserMedia) throw new Error('機器へのアクセスに対応していません。');
                const stream = await navigator.mediaDevices.getUserMedia({audio:true});
                stream.getTracks().forEach(track=>track.stop());
            }
            await loadOutputs(); await applyOutput();
        } catch (e) { $('outputStatus').textContent='機器の許可・選択を完了できませんでした：'+e.message; }
    };
    $('speaker').onchange = async () => {
        const select=$('speaker');
        put('output',{id:select.value,label:select.selectedOptions[0]?.textContent || '選択したスピーカー'});
        await applyOutput().catch(e=>{$('outputStatus').textContent='出力先を変更できませんでした：'+e.message;});
    };
    function openPage(results) {
        const s = state(), p = s.active || (s.completed?.user === config().user ? s.completed.problem : null);
        if (!p) return;
        const url = results ? `https://atcoder.jp/contests/${p.contest_id}/submissions?` + new URLSearchParams({'f.Task': p.id, 'f.User': config().user}) : `https://atcoder.jp/contests/${p.contest_id}/tasks/${p.id}`;
        window.open(url, '_blank', 'noopener');
    }
    $('open').onclick = () => openPage(false); $('results').onclick = () => openPage(true);
    for (const button of ui.querySelectorAll('[data-range]')) button.onclick = () => { const [a,b] = button.dataset.range.split(','); $('low').value = a; $('high').value = b; };
    $('time').oninput = () => { timeEdited = true; };
    $('timeZone').onchange = () => { timeEdited = true; };
    $('pool').onchange = updatePoolFields;
    $('settings').onsubmit = event => {
        event.preventDefault();
        try {
            const [hour, minute] = $('time').value.split(':');
            const c = validate({user: $('user').value.trim(), hour, minute, time_zone: $('timeZone').value, pool: $('pool').value, virtual_contest_url: $('virtualContest').value, min_diff: $('low').value, max_diff: $('high').value, contests: ['abc','arc','agc'].filter(s => $(s).checked), only_unsolved: $('onlyUnsolved').checked});
            const old = config();
            const timeWasSet = timeEdited || old.hour !== c.hour || old.minute !== c.minute || timeZoneOf(old) !== c.time_zone;
            const s = state();
            if (s.ringing && c.user !== config().user) throw new Error('鳴動中はユーザー名を変更できません。');
            put('config', c);
            const rearmToday = timeWasSet && !timeReached(Date.now(), c);
            put('state', {...s, selectionVersion: (s.selectionVersion || 0) + 1, ...(!s.ringing ? {ready: null, signature: null, ...(rearmToday ? {last_day: null} : {})} : {})});
            timeEdited = false;
            message('設定を保存しました。');
            if (!s.ringing) prepare();
            render();
        } catch (e) { message(e.message); }
    };
    for (const key of ['state', 'owner', 'message', 'config', 'data', 'output', 'sound', 'compact']) GM_addValueChangeListener(PREFIX + key, (_k, _old, value, remote) => {
        if (key === 'data') dataset = value;
        if (key === 'config') { lastTick = Date.now(); if (remote) updateForm(); }
        if (key === 'output') { stopSound(); loadOutputs().catch(()=>{}); applyOutput().catch(e=>{$('outputStatus').textContent=e.message;}); }
        if (key === 'sound') { customSound = value; decodedSound = remote || !value ? null : decodedSound; stopSound(); loadAlarmSound().catch(e=>message(e.message)); }
        render();
    });
    window.addEventListener('pagehide', () => { if (get('owner', '') === tab) put('owner', ''); stopSound(); });
    document.addEventListener('visibilitychange', tick);
    updateForm(); tick(); setInterval(tick, 1000);
    navigator.mediaDevices?.addEventListener?.('devicechange',()=>{outputApplied=null;loadOutputs().catch(()=>{});applyOutput().catch(()=>{});});
    if (config().user && showUI(location.href, state().active) && !state().ringing) prepare();
})();
