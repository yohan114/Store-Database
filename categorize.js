/**
 * categorize.js — keyword-based item classifier.
 *
 * Divides items into the agreed "expanded set" of categories. Rules are ordered:
 * the FIRST matching rule wins, so overlaps resolve sensibly
 * (e.g. "oil filter" -> Filters, "oil seal" -> Bearings & Seals, "engine oil" -> Oil).
 *
 * Anything that matches nothing falls through to "General Items".
 */

const GENERAL = 'General Items';

// The selectable category list (used to populate UI dropdowns / chips).
const CATEGORIES = [
    'Battery',
    'Filters',
    'Tyre',
    'Oil & Lubricants',
    'Electrical',
    'Bearings & Seals',
    'Belts',
    'Hydraulics',
    GENERAL,
];

// Ordered rules — first match wins.
const RULES = [
    // Require real battery terms (the word battery, or Ah / Amp capacity).
    // NB: a bare trailing "A" (e.g. "FC-70/7A") is intentionally NOT a battery signal.
    { category: 'Battery',          re: /batter|battey|\bbatt\b|\d+\s*ah\b|\d+\s*amp\b/i },
    { category: 'Filters',          re: /filter/i },
    { category: 'Belts',            re: /\bbelt/i },
    { category: 'Bearings & Seals', re: /bearing|\bseal\b|\bseals\b|\bbush|\bo-?ring|gasket/i },
    { category: 'Tyre',             re: /\btyre|\btire|\btube|\bwheel|\brim\b|\bflap\b/i },
    { category: 'Hydraulics',       re: /hydraulic|\bhose\b|cylinder/i },
    { category: 'Electrical',       re: /bulb|\blamp|\bwire|cable|\bfuse|relay|sensor|switch|alternator|\bstarter|solenoid|\bhorn|\bplug\b|\bcoil\b|\bled\b|head\s*light|tail\s*light/i },
    { category: 'Oil & Lubricants', re: /\boil\b|grease|lubric|coolant|antifreeze|\batf\b|\bgear\s*oil/i },
];

/** Classify an item name (description used as a secondary hint). */
function classify(name, desc = '') {
    const text = `${name || ''} ${desc || ''}`.toLowerCase();
    if (!text.trim()) return GENERAL;
    for (const rule of RULES) {
        if (rule.re.test(text)) return rule.category;
    }
    return GENERAL;
}

module.exports = { CATEGORIES, GENERAL, classify };
