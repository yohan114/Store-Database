'use strict';

/**
 * auth.js — Authentication & sessions for the unified Workshop + Store system.
 *
 * Ported from Job-Card-System/src/auth.js: scrypt password hashing + cookie
 * sessions, using Node's `crypto` only (no extra dependency). Difference: here
 * sessions are persisted in the SQLite `sessions` table so they survive a
 * server restart (the Store-Database is launched/relaunched by batch scripts),
 * instead of an in-memory Map.
 */

const crypto = require('crypto');
const db = require('./db');

const SESSION_COOKIE = 'ecms_sid';                 // Edward & Christie management system
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;    // 7 days
// Set COOKIE_SECURE=true when serving over HTTPS so the session cookie is not
// sent over plaintext (leave unset for a plain-HTTP LAN deployment).
const COOKIE_SECURE = String(process.env.COOKIE_SECURE || '').toLowerCase() === 'true';
const cookieFlags = (maxAge) => `HttpOnly; Path=/; SameSite=Lax;${COOKIE_SECURE ? ' Secure;' : ''} Max-Age=${maxAge}`;

// Role identifiers (mirrors Job-Card-System/src/domain.js for future workflow use).
const ROLES = {
    TRANSPORT_OFFICER: 'TRANSPORT_OFFICER',
    TRANSPORT_MANAGER: 'TRANSPORT_MANAGER',
    ASST_MECH_ENGINEER: 'ASST_MECH_ENGINEER',
    MECH_ENGINEER: 'MECH_ENGINEER',
    OPERATIONAL_MANAGER: 'OPERATIONAL_MANAGER',
    TECHNICIAN: 'TECHNICIAN',
    ADMIN: 'ADMIN',
};

const ROLE_LABELS = {
    TRANSPORT_OFFICER: 'Transport Officer',
    TRANSPORT_MANAGER: 'Transport Manager',
    ASST_MECH_ENGINEER: 'Assistant Mechanical Engineer',
    MECH_ENGINEER: 'Mechanical Engineer',
    OPERATIONAL_MANAGER: 'Operational Manager',
    TECHNICIAN: 'Workshop Technician',
    ADMIN: 'Administrator',
};

// --- passwords -------------------------------------------------------------
function hashPassword(plain) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(plain), salt, 64).toString('hex');
    return { salt, hash };
}

function verifyPassword(plain, salt, hash) {
    if (!salt || !hash) return false;
    const computed = crypto.scryptSync(String(plain), salt, 64).toString('hex');
    const a = Buffer.from(computed, 'hex');
    const b = Buffer.from(hash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// --- cookies ---------------------------------------------------------------
function parseCookies(req) {
    const header = req.headers.cookie || '';
    const out = {};
    header.split(';').forEach((part) => {
        const idx = part.indexOf('=');
        if (idx === -1) return;
        const k = part.slice(0, idx).trim();
        const v = part.slice(idx + 1).trim();
        if (k) out[k] = decodeURIComponent(v);
    });
    return out;
}

// --- sessions (SQLite-backed) ----------------------------------------------
function createSession(res, userId) {
    const sid = crypto.randomBytes(24).toString('hex');
    const now = Date.now();
    db.run(
        'INSERT INTO sessions (sid, userId, createdAt, expiresAt) VALUES (?,?,?,?)',
        [sid, userId, new Date(now).toISOString(), new Date(now + SESSION_TTL_MS).toISOString()]
    );
    res.setHeader('Set-Cookie',
        `${SESSION_COOKIE}=${sid}; ${cookieFlags(Math.floor(SESSION_TTL_MS / 1000))}`);
    return sid;
}

function destroySession(req, res) {
    const sid = parseCookies(req)[SESSION_COOKIE];
    if (sid) {
        try { db.run('DELETE FROM sessions WHERE sid=?', [sid]); } catch (_) {}
    }
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; ${cookieFlags(0)}`);
}

function safeRoles(raw) {
    if (Array.isArray(raw)) return raw;
    try { const r = JSON.parse(raw || '[]'); return Array.isArray(r) ? r : []; } catch (_) { return []; }
}

/** Resolve the user for a request from its session cookie (or null). */
function userFromRequest(req) {
    const sid = parseCookies(req)[SESSION_COOKIE];
    if (!sid) return null;
    const sess = db.get('SELECT * FROM sessions WHERE sid=?', [sid]);
    if (!sess) return null;
    if (sess.expiresAt && Date.parse(sess.expiresAt) < Date.now()) {
        try { db.run('DELETE FROM sessions WHERE sid=?', [sid]); } catch (_) {}
        return null;
    }
    const user = db.get('SELECT * FROM users WHERE id=? AND active=1', [sess.userId]);
    if (!user) return null;
    user.roles = safeRoles(user.roles);
    req._sid = sid;
    return user;
}

/** Public shape of a user (never leak hash/salt to the client). */
function publicUser(user) {
    if (!user) return null;
    return {
        id: user.id,
        username: user.username,
        name: user.name,
        designation: user.designation,
        email: user.email,
        roles: safeRoles(user.roles),
        mustChangePassword: !!user.mustChangePassword,
    };
}

// --- middleware ------------------------------------------------------------
function attachUser(req, res, next) {
    try { req.user = userFromRequest(req); } catch (_) { req.user = null; }
    next();
}

function requireApiAuth(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
    next();
}

function requirePageAuth(req, res, next) {
    if (!req.user) return res.redirect('/login');
    next();
}

function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
        if (!roles.some((r) => req.user.roles.includes(r))) {
            return res.status(403).json({ error: 'You do not have permission to perform this action.' });
        }
        next();
    };
}

/** Seed a default admin on an empty users table (idempotent). */
function ensureSeedUser() {
    const row = db.get('SELECT COUNT(*) AS c FROM users');
    if (row && row.c > 0) return;
    // Configurable via SEED_ADMIN_PASSWORD; keeps a documented default so a fresh
    // install / test run can log in, but mustChangePassword forces a reset.
    const seedPass = process.env.SEED_ADMIN_PASSWORD || 'admin123';
    const { salt, hash } = hashPassword(seedPass);
    db.run(
        `INSERT INTO users (username, name, designation, email, roles, passwordHash, passwordSalt, active, mustChangePassword, createdAt)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        ['admin', 'Administrator', 'System Administrator', '', JSON.stringify(['ADMIN']), hash, salt, 1, 1, new Date().toISOString()]
    );
    const shown = process.env.SEED_ADMIN_PASSWORD ? '(from SEED_ADMIN_PASSWORD)' : `password: ${seedPass}`;
    console.log(`  Seeded default login  →  username: admin   ${shown}   (change on first login)`);
}

module.exports = {
    SESSION_COOKIE,
    SESSION_TTL_MS,
    ROLES,
    ROLE_LABELS,
    hashPassword,
    verifyPassword,
    parseCookies,
    createSession,
    destroySession,
    userFromRequest,
    publicUser,
    safeRoles,
    attachUser,
    requireApiAuth,
    requirePageAuth,
    requireRole,
    ensureSeedUser,
};
