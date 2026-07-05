'use strict';

/**
 * users.js — user directory + admin management for the Operations workflow.
 * Uses the existing `users` table and auth.js password helpers.
 */

const db = require('./db');
const auth = require('./auth');
const R = auth.ROLES;
const nowISO = () => new Date().toISOString();
const s = (v) => (v === null || v === undefined) ? '' : String(v).trim();

const VALID_ROLES = Object.values(R);
function cleanRoles(raw) {
    const arr = Array.isArray(raw) ? raw : auth.safeRoles(raw);
    return arr.map((x) => String(x).trim().toUpperCase()).filter((x) => VALID_ROLES.includes(x));
}

/** Seed example approver accounts once, so the approval flow is usable on day one.
 *  Real names/emails are set later via the Users admin screen. Idempotent. */
function ensureSeedApprovers() {
    const seeds = [
        ['transport', 'Transport Officer', R.TRANSPORT_OFFICER],
        ['tmanager', 'Transport Manager', R.TRANSPORT_MANAGER],
        ['opsmanager', 'Operational Manager', R.OPERATIONAL_MANAGER],
    ];
    const seedPass = process.env.SEED_APPROVER_PASSWORD || 'changeme123';
    for (const [username, name, role] of seeds) {
        const exists = db.get('SELECT 1 FROM users WHERE username=?', [username]);
        if (exists) continue;
        const { salt, hash } = auth.hashPassword(seedPass);
        db.run(
            `INSERT INTO users (username, name, designation, email, roles, passwordHash, passwordSalt, active, mustChangePassword, createdAt)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
            [username, name, name, '', JSON.stringify([role]), hash, salt, 1, 1, nowISO()]
        );
        const shown = process.env.SEED_APPROVER_PASSWORD ? '(from SEED_APPROVER_PASSWORD)' : `password: ${seedPass}`;
        console.log(`  Seeded ${role} login  →  username: ${username}   ${shown}`);
    }
}

function list() {
    return db.all('SELECT * FROM users ORDER BY username COLLATE NOCASE').map(auth.publicUser);
}

function create(form) {
    const username = s(form.username).toLowerCase();
    if (!username) return { error: 'Username is required.', status: 400 };
    if (db.get('SELECT 1 FROM users WHERE username=?', [username])) return { error: 'That username already exists.', status: 400 };
    const roles = cleanRoles(form.roles);
    if (!roles.length) return { error: 'Choose at least one role.', status: 400 };
    const pwd = s(form.password) || 'changeme123';
    if (pwd.length < 6) return { error: 'Password must be at least 6 characters.', status: 400 };
    const { salt, hash } = auth.hashPassword(pwd);
    const r = db.run(
        `INSERT INTO users (username, name, designation, email, roles, passwordHash, passwordSalt, active, mustChangePassword, createdAt)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [username, s(form.name) || username, s(form.designation), s(form.email), JSON.stringify(roles), hash, salt, 1, 1, nowISO()]
    );
    return { user: auth.publicUser(db.get('SELECT * FROM users WHERE id=?', [r.lastInsertRowid])) };
}

function update(id, form) {
    const existing = db.get('SELECT * FROM users WHERE id=?', [id]);
    if (!existing) return { error: 'User not found.', status: 404 };
    const roles = form.roles !== undefined ? cleanRoles(form.roles) : auth.safeRoles(existing.roles);
    if (!roles.length) return { error: 'A user must keep at least one role.', status: 400 };
    const active = (form.active === undefined) ? existing.active : (form.active ? 1 : 0);
    db.run(
        `UPDATE users SET name=?, designation=?, email=?, roles=?, active=? WHERE id=?`,
        [s(form.name) || existing.name, s(form.designation), s(form.email), JSON.stringify(roles), active, id]
    );
    return { user: auth.publicUser(db.get('SELECT * FROM users WHERE id=?', [id])) };
}

function resetPassword(id, form) {
    const existing = db.get('SELECT * FROM users WHERE id=?', [id]);
    if (!existing) return { error: 'User not found.', status: 404 };
    const pwd = s(form.password) || 'changeme123';
    if (pwd.length < 6) return { error: 'Password must be at least 6 characters.', status: 400 };
    const { salt, hash } = auth.hashPassword(pwd);
    db.run('UPDATE users SET passwordHash=?, passwordSalt=?, mustChangePassword=1 WHERE id=?', [hash, salt, id]);
    return { success: true };
}

/** Directory for recipient pickers: id, name, email (only users with an email). */
function directory() {
    return db.all('SELECT id, name, username, email, roles FROM users WHERE active=1 ORDER BY name COLLATE NOCASE')
        .map((u) => ({ id: u.id, name: u.name || u.username, email: u.email || '', roles: auth.safeRoles(u.roles) }));
}

module.exports = { ensureSeedApprovers, list, create, update, resetPassword, directory, cleanRoles };
