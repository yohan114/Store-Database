'use strict';

/**
 * config.js — one home for the tuning knobs that were duplicated as magic
 * numbers across the server, the job matcher and the backfill tools (see
 * docs/SYSTEM_REVIEW.md, architecture/config finding). Centralising them means
 * the live auto-linker and the backfill tools use provably identical windows,
 * and operational cadences are changed in one place.
 *
 * Server-side only (CommonJS). The browser client keeps its own copies of the
 * few values it needs; those are commented as mirrors where they live.
 */

module.exports = {
    // --- job ↔ vehicle/date matching -------------------------------------
    // A job "claims" work dated within [start - WINDOW_DAYS … (expected||start)
    // + WINDOW_DAYS]. Used identically by jobcards.findMatch (live) and
    // tools/_jobmatch (backfill).
    WINDOW_DAYS: 2,
    // Tier-2 backfill: attribute to the nearest same-vehicle dated job within
    // this many days when nothing falls in the exact window (a lower-confidence
    // guess, recorded as linkMethod='NEAR'). Overridable per-run via --max-gap.
    NEAR_MAX_GAP_DAYS: 60,

    // --- backups ----------------------------------------------------------
    BACKUP_INTERVAL_MS: 30 * 60 * 1000,   // half-hourly online backup
    BACKUP_KEEP_ALL_MS: 24 * 60 * 60 * 1000,   // keep every backup < 24 h old
    BACKUP_KEEP_DAILY_DAYS: 30,           // then one/day up to 30 days

    // --- login throttle ---------------------------------------------------
    LOGIN_WINDOW_MS: 15 * 60 * 1000,      // rolling lockout window
    LOGIN_MAX_FAILS: 8,                   // failures before a username+IP lock

    // --- dashboard result caps -------------------------------------------
    DASHBOARD_DAILY_LIMIT: 60,            // days in the daily split
    DASHBOARD_MONTHLY_LIMIT: 12,          // months in the monthly split
    DASHBOARD_PENDING_LIMIT: 100,         // rows per pending-source bucket
    DASHBOARD_SUPPLIER_LIMIT: 12,         // suppliers in the spend breakdown

    // --- business timezone -----------------------------------------------
    // Day-only data (reqDateISO etc.) is in local business time; the Today /
    // Yesterday / MTD boundaries are computed in this zone so a UTC server near
    // midnight doesn't attribute spend to the wrong calendar day. Override with
    // BUSINESS_TZ. Default Asia/Colombo (UTC+5:30, the deployment's locale).
    BUSINESS_TZ: process.env.BUSINESS_TZ || 'Asia/Colombo',
};
