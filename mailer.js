'use strict';

/**
 * mailer.js — e-mail for outsourced ("outside") job requests.
 *
 * - If SMTP is configured (SMTP_* env vars or mail.config.json), the message is
 *   sent for real over a built-in, zero-dependency SMTP client (TLS/STARTTLS).
 * - Either way a copy is written to the `outbox` table with a delivery status
 *   (simulated / sent / failed) so there is always an auditable record — the
 *   workflow works even before SMTP is set up ("simulate now, real SMTP later").
 *
 * SMTP transport ported from Job-Card-System/src/mailer.js.
 * Gmail: enable 2-Step Verification, create an App Password, then set
 *   host smtp.gmail.com, port 465, user = your gmail, pass = the App Password.
 */

const tls = require('tls');
const net = require('net');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const CONFIG_FILE = path.join(__dirname, 'mail.config.json');
const nowISO = () => new Date().toISOString();

/** SMTP config from env first, then mail.config.json. Null => simulate-only. */
function loadConfig() {
    let raw = null;
    const env = process.env;
    if (env.SMTP_USER && env.SMTP_PASS) {
        raw = { host: env.SMTP_HOST, port: env.SMTP_PORT, user: env.SMTP_USER, pass: env.SMTP_PASS, from: env.SMTP_FROM, secure: env.SMTP_SECURE };
    } else if (fs.existsSync(CONFIG_FILE)) {
        try { const jconf = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); if (jconf && jconf.user && jconf.pass) raw = jconf; }
        catch (err) { console.error('[MAIL] Ignoring invalid mail.config.json:', err.message); }
    }
    if (!raw) return null;
    const port = Number(raw.port) || 465;
    return {
        host: raw.host || 'smtp.gmail.com', port, user: raw.user, pass: raw.pass, from: raw.from || raw.user,
        secure: raw.secure !== undefined ? (raw.secure !== false && raw.secure !== 'false') : port === 465,
        starttls: port !== 465,
    };
}
const isLive = () => !!loadConfig();

// --- low-level SMTP --------------------------------------------------------
const b64 = (v) => Buffer.from(v, 'utf8').toString('base64');
const dotStuff = (v) => v.replace(/(^|\r\n)\./g, '$1..');

function makeReader(socket) {
    const queue = []; let waiter = null; let buf = '';
    const onData = (chunk) => {
        buf += chunk;
        while (true) {
            const lines = buf.split('\r\n'); let end = -1;
            for (let i = 0; i < lines.length; i++) if (/^\d{3} /.test(lines[i])) { end = i; break; }
            if (end === -1) break;
            const resp = { code: parseInt(lines[end].slice(0, 3), 10), text: lines.slice(0, end + 1).join('\n') };
            buf = lines.slice(end + 1).join('\r\n');
            if (waiter) { const w = waiter; waiter = null; w(resp); } else queue.push(resp);
        }
    };
    socket.on('data', onData);
    return { read: () => new Promise((r) => { if (queue.length) r(queue.shift()); else waiter = r; }), detach: () => socket.removeListener('data', onData) };
}
const onceSecure = (socket) => new Promise((resolve, reject) => { socket.once('secureConnect', resolve); socket.once('error', reject); });

function sendSmtp(cfg, mime, recipients, fromAddr) {
    return new Promise((resolve, reject) => {
        let socket = cfg.secure ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host }) : net.connect({ host: cfg.host, port: cfg.port });
        let settled = false;
        const finish = (err) => { if (settled) return; settled = true; try { socket.end(); } catch (_) {} err ? reject(err) : resolve(true); };
        socket.setTimeout(25000, () => finish(new Error('SMTP connection timed out')));
        socket.on('error', finish);
        socket.setEncoding('utf8');
        let reader = makeReader(socket);
        const expect = async (codes, label) => { const r = await reader.read(); if (![].concat(codes).includes(r.code)) throw new Error(`${label} failed: expected ${codes}, got ${r.code} — ${r.text.split('\n')[0]}`); return r; };
        const send = (line) => socket.write(line + '\r\n');
        (async () => {
            try {
                await expect(220, 'Greeting');
                send('EHLO ecmsstore'); await expect(250, 'EHLO');
                if (!cfg.secure && cfg.starttls) {
                    send('STARTTLS'); await expect(220, 'STARTTLS'); reader.detach();
                    const secure = tls.connect({ socket, servername: cfg.host }); secure.on('error', finish); await onceSecure(secure);
                    socket = secure; socket.setEncoding('utf8'); reader = makeReader(socket);
                    send('EHLO ecmsstore'); await expect(250, 'EHLO (TLS)');
                }
                send('AUTH LOGIN'); await expect(334, 'AUTH LOGIN');
                send(b64(cfg.user)); await expect(334, 'Username');
                send(b64(cfg.pass)); await expect(235, 'Authentication');
                send(`MAIL FROM:<${fromAddr}>`); await expect(250, 'MAIL FROM');
                for (const rcpt of recipients) { send(`RCPT TO:<${rcpt}>`); await expect([250, 251], `RCPT TO ${rcpt}`); }
                send('DATA'); await expect(354, 'DATA');
                const data = mime.endsWith('\r\n') ? mime : mime + '\r\n';
                socket.write(dotStuff(data) + '.\r\n'); await expect(250, 'Message body');
                send('QUIT'); finish();
            } catch (err) { finish(err); }
        })();
    });
}

function buildMime({ from, to, cc, subject, text }) {
    const headers = [
        `From: ${from}`, `To: ${to}`, cc && cc.length ? `Cc: ${cc.join(', ')}` : null,
        `Subject: ${subject}`, `Date: ${new Date().toUTCString()}`, 'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit',
    ].filter(Boolean);
    return `${headers.join('\r\n')}\r\n\r\n${text.replace(/\r?\n/g, '\r\n')}`;
}

/** Log to outbox and (if configured) send for real, updating the row status. */
function deliver(msg) {
    const cfg = loadConfig();
    const status = cfg ? 'sending' : 'simulated';
    const r = db.run(
        `INSERT INTO outbox (requestId, reqNo, toAddr, cc, subject, body, status, error, at) VALUES (?,?,?,?,?,?,?,?,?)`,
        [msg.requestId || null, msg.reqNo || null, msg.to, (msg.cc || []).join(', '), msg.subject, msg.body, status, null, nowISO()]
    );
    console.log(`[MAIL] to=${msg.to} subject="${msg.subject}" mode=${cfg ? 'smtp' : 'simulated'}`);
    if (cfg) {
        const fromAddr = (String(cfg.from).match(/<([^>]+)>/) || [])[1] || cfg.from;
        const mime = buildMime({ from: cfg.from, to: msg.to, cc: msg.cc, subject: msg.subject, text: msg.body });
        sendSmtp(cfg, mime, msg.recipients, fromAddr)
            .then(() => db.run('UPDATE outbox SET status=? WHERE id=?', ['sent', r.lastInsertRowid]))
            .catch((err) => { console.error('[MAIL] send failed:', err.message); db.run('UPDATE outbox SET status=?, error=? WHERE id=?', ['failed', err.message, r.lastInsertRowid]); });
    }
    return { id: r.lastInsertRowid, status };
}

const splitEmails = (v) => String(v || '').split(/[,;\n]/).map((x) => x.trim()).filter((x) => /@/.test(x));

/** Email an outsourced job request to the vendor + selected parties + standing CC. */
function sendOutsourced(req) {
    const vendorEmail = String(req.vendorEmail || '').trim();
    const selected = Array.isArray(req.emailRecipients) ? req.emailRecipients : splitEmails(req.emailRecipients);
    const standing = splitEmails((db.get(`SELECT value FROM app_settings WHERE key='standingCc'`) || {}).value || '');
    const to = vendorEmail || (selected[0] || standing[0] || '');
    if (!to) { console.warn('[MAIL] outsourced request has no recipient; skipped'); return null; }
    const cc = [...new Set([...selected, ...standing].filter((e) => e && e !== to))];
    const recipients = [...new Set([to, ...cc])];
    const body = [
        `Dear ${req.vendorName || 'Sir/Madam'},`, '',
        `Please carry out the following job for Edward and Christie (Pvt) Ltd. Reference: ${req.reqNo || '-'}.`, '',
        `  Vehicle / Machinery : ${req.vehicleMachinery || '-'}`,
        `  ECD No.             : ${req.ecdNo || '-'}`,
        `  Project / Site      : ${req.projectName || req.site || '-'}`,
        `  Priority            : ${req.priority || 'Normal'}`,
        `  Needed by           : ${req.neededBy || 'As soon as possible'}`, '',
        `Job: ${req.title || '-'}`,
        `Details: ${req.details || '-'}`, '',
        `Approved by Operational Manager: ${req.omApprovedByName || '-'}`, '',
        'Thank you,', 'Edward and Christie (Pvt) Ltd',
    ].join('\n');
    return deliver({
        requestId: req.id, reqNo: req.reqNo, to, cc, recipients,
        subject: `Job Request ${req.reqNo || ''} — ${req.vehicleMachinery || 'Vehicle/Machinery'} | Edward and Christie (Pvt) Ltd`,
        body,
    });
}

module.exports = { deliver, sendOutsourced, isLive, buildMime, sendSmtp, loadConfig, splitEmails };
