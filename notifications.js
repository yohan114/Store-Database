'use strict';

/**
 * notifications.js — in-app notifications (SQLite). Each row targets one user
 * and links to a job request. Adapted from Job-Card-System/src/notifications.js
 * (which used an in-memory JSON store) to the Store-Database `notifications`
 * table.
 */

const db = require('./db');
const auth = require('./auth');

const nowISO = () => new Date().toISOString();

function usersByRole(role) {
    return db.all('SELECT id, roles FROM users WHERE active=1')
        .filter((u) => auth.safeRoles(u.roles).includes(role));
}

function notifyUser(userId, req, message) {
    if (!userId) return;
    db.run(
        'INSERT INTO notifications (userId, requestId, reqNo, message, isRead, at) VALUES (?,?,?,?,0,?)',
        [userId, req ? req.id : null, req ? (req.reqNo || null) : null, message, nowISO()]
    );
}

/** Notify every active user holding any of the given roles (deduped). */
function notifyRoles(roles, req, message) {
    const seen = new Set();
    roles.forEach((role) => {
        usersByRole(role).forEach((u) => {
            if (!seen.has(u.id)) { seen.add(u.id); notifyUser(u.id, req, message); }
        });
    });
}

const unreadCount = (userId) =>
    (db.get('SELECT COUNT(*) AS c FROM notifications WHERE userId=? AND isRead=0', [userId]) || {}).c || 0;

const listFor = (userId, limit = 50) =>
    db.all('SELECT * FROM notifications WHERE userId=? ORDER BY id DESC LIMIT ?', [userId, limit]);

function markRead(id, userId) {
    db.run('UPDATE notifications SET isRead=1 WHERE id=? AND userId=?', [id, userId]);
}
function markAllRead(userId) {
    db.run('UPDATE notifications SET isRead=1 WHERE userId=? AND isRead=0', [userId]);
}

module.exports = { usersByRole, notifyUser, notifyRoles, unreadCount, listFor, markRead, markAllRead };
