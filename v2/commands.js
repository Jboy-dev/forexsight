/* ============================================================================
   v2/commands.js — the order layer.

   The point of this file: you type an instruction, the site obeys it, and the
   instruction sticks. Not a settings panel with six checkboxes someone has to
   go and find — a line you talk to.

   IT IS BUILT TO BE CHANGED. Adding a new order is one object in COMMANDS:

       { name: 'thing', aliases: ['stuff'], help: 'what it does',
         run(cfg, rest) { cfg.whatever = rest; return 'what I did'; } }

   That is the whole contract. run() mutates the config, returns a sentence
   describing what it did, and the page re-renders. No wiring, no registration
   elsewhere, nothing else to remember. Everything below — parsing, the chips,
   persistence, help — picks the new command up automatically.

   Orders persist in localStorage, so they survive a reload and a reopen.
   ========================================================================== */
'use strict';

const FS_DEFAULTS = {
  pairs: null,          // null = every pair; otherwise an array of substrings
  direction: null,      // 'BUY' | 'SELL' | null
  minConfidence: null,  // number | null
  hideWeak: false,
  minR: null,           // minimum TP1 R multiple
  sort: 'newest',       // newest | confidence | r | pair
  limit: null,          // max cards to show
  expand: false,        // open every collapsible section
  density: 'normal',    // normal | compact
  newsStrict: false,    // hide anything whose news verdict is not 'clear'
  tab: 'signals',       // which pane is open
  histFilter: 'all',    // History pane: all | won | lost | target | open
  balance: 1000,        // account size, for the money figures
  riskPct: 1,           // percent of balance risked per trade
  currency: 'GBP',      // account currency
  perSignal: {},        // per-signal balance overrides, keyed by signal
  tabOrder: null,       // user-dragged tab order
  segOrder: {},         // user-dragged section order, per pane
  alerts: false,        // notify when a NEW signal passes the standing orders
  alertMinConf: null,   // optional extra bar that applies to alerts only
};

const FS_STORE = 'fs.orders.v1';

function fsLoadConfig() {
  const cfg = { ...FS_DEFAULTS };
  try {
    const raw = localStorage.getItem(FS_STORE);
    if (raw) Object.assign(cfg, JSON.parse(raw));
  } catch (_) { /* private mode, blocked storage — defaults are fine */ }
  return cfg;
}
function fsSaveConfig(cfg) {
  try { localStorage.setItem(FS_STORE, JSON.stringify(cfg)); } catch (_) {}
}

/* ── helpers shared by commands ──────────────────────────────────────────── */
const fsNum = (s) => { const m = String(s).match(/-?\d+(\.\d+)?/); return m ? parseFloat(m[0]) : null; };

/** Turns "gold", "eurusd", "eur/usd", "eur usd" into a matchable token. */
const FS_ALIASES = {
  gold: 'XAU', xau: 'XAU', silver: 'XAG', bitcoin: 'BTC', btc: 'BTC',
  ethereum: 'ETH', eth: 'ETH', cable: 'GBP/USD', fiber: 'EUR/USD',
  aussie: 'AUD/USD', kiwi: 'NZD/USD', loonie: 'USD/CAD', swissy: 'USD/CHF',
  yen: 'JPY', euro: 'EUR', pound: 'GBP', dollar: 'USD',
};
// The set of things that are actually instruments. A token has to be one of
// these to be read as a pair filter. Without this check "make me rich" parsed
// as "only MAKE, RICH" and silently filtered the page to empty — a nonsense
// order has to be refused out loud, never obeyed into a blank screen.
const FS_CODES = ['EUR','USD','GBP','JPY','AUD','NZD','CAD','CHF','XAU','XAG','BTC','ETH','US30','NAS100','SPX500'];
const FS_CODE_RE = new RegExp('^(' + FS_CODES.join('|') + ')$');
// A pair is two known codes, optionally separated. Matching "any six letters"
// was the earlier mistake: PROFIT and BANANA are six letters, and SOMETHING
// contains ETH, so nonsense was being obeyed as an instrument filter and the
// page silently went blank.
const FS_PAIR_RE = new RegExp('^(' + FS_CODES.join('|') + ')[/\\-_ ]?(' + FS_CODES.join('|') + ')$');
function fsIsInstrument(tok) {
  const t = String(tok).toUpperCase().replace(/[^A-Z0-9/]/g, '');
  return FS_CODE_RE.test(t) || FS_PAIR_RE.test(t);
}
/** Strips separators so EURUSD, EUR/USD and EUR-USD all compare equal. */
function fsNorm(x) { return String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

function fsPairTokens(rest, strict = true) {
  return String(rest).split(/[\s,]+/).filter(Boolean).map(w => {
    const k = w.toLowerCase().replace(/[^a-z]/g, '');
    if (FS_ALIASES[k]) return FS_ALIASES[k];
    return w.toUpperCase().replace(/[^A-Z0-9/]/g, '');
  }).filter(t => t && (!strict || fsIsInstrument(t)));
}

/* ── THE REGISTRY ────────────────────────────────────────────────────────
   Each entry is self-describing, so `help` is generated from this list and
   can never drift out of date with what the commands actually do.
   ---------------------------------------------------------------------- */
const FS_COMMANDS = [
  {
    name: 'only', aliases: ['show', 'just', 'filter'],
    help: 'only gold · only eurusd gbpusd · only buy · only sell',
    run(cfg, rest) {
      const r = rest.trim().toLowerCase();
      if (/^(buy|long)s?$/.test(r))  { cfg.direction = 'BUY';  return 'Showing BUY setups only.'; }
      if (/^(sell|short)s?$/.test(r)) { cfg.direction = 'SELL'; return 'Showing SELL setups only.'; }
      const toks = fsPairTokens(rest);
      if (!toks.length) return null;      // refused upstream, with the help text
      cfg.pairs = toks;
      return `Showing only ${toks.join(', ')}.`;
    },
  },
  {
    name: 'hide', aliases: ['drop', 'exclude', 'remove'],
    help: 'hide weak · hide buys · hide sells',
    run(cfg, rest) {
      const r = rest.trim().toLowerCase();
      if (/weak/.test(r))            { cfg.hideWeak = true;     return 'Hiding anything flagged weak.'; }
      if (/^(buy|long)s?$/.test(r))  { cfg.direction = 'SELL';  return 'Hiding BUYs — SELL setups only.'; }
      if (/^(sell|short)s?$/.test(r)) { cfg.direction = 'BUY';  return 'Hiding SELLs — BUY setups only.'; }
      return null;
    },
  },
  {
    name: 'confidence', aliases: ['conf', 'minconfidence', 'score'],
    help: 'confidence 70 — hide anything scored below it',
    run(cfg, rest) {
      const n = fsNum(rest);
      if (n === null) return null;
      cfg.minConfidence = n;
      return `Hiding setups scored under ${n}.`;
    },
  },
  {
    name: 'minr', aliases: ['rr', 'reward', 'minreward'],
    help: 'minr 1.5 — require TP1 to pay at least that many R',
    run(cfg, rest) {
      const n = fsNum(rest);
      if (n === null) return null;
      cfg.minR = n;
      return `Requiring TP1 to pay at least ${n}R.`;
    },
  },
  {
    name: 'sort', aliases: ['order', 'rank', 'sortby'],
    help: 'sort by confidence · sort by r · sort by pair · sort by newest',
    run(cfg, rest) {
      const r = rest.toLowerCase();
      const key = /conf/.test(r) ? 'confidence' : /\br\b|reward|ratio/.test(r) ? 'r'
                : /pair|name|alpha/.test(r) ? 'pair' : /new|time|recent/.test(r) ? 'newest' : null;
      if (!key) return null;
      cfg.sort = key;
      return `Sorted by ${key}.`;
    },
  },
  {
    name: 'top', aliases: ['limit', 'first', 'best'],
    help: 'top 3 — show only that many',
    run(cfg, rest) {
      const n = fsNum(rest);
      if (n === null) return null;
      cfg.limit = Math.max(1, Math.round(n));
      return `Showing the top ${cfg.limit}.`;
    },
  },
  {
    name: 'news', aliases: ['newsgate'],
    help: 'news strict — hide anything whose news risk is not confirmed clear',
    run(cfg, rest) {
      const r = rest.toLowerCase();
      if (/strict|safe|on/.test(r))  { cfg.newsStrict = true;  return 'Hiding anything whose news risk is not confirmed clear.'; }
      if (/off|any|loose/.test(r))   { cfg.newsStrict = false; return 'Showing setups regardless of news coverage.'; }
      return null;
    },
  },
  {
    name: 'expand', aliases: ['unfold', 'details', 'expandall'],
    help: 'expand — open every detail section · collapse to close them',
    run(cfg) { cfg.expand = true; return 'Opening every detail section.'; },
  },
  {
    name: 'collapse', aliases: ['close', 'fold'],
    help: 'collapse — close every detail section',
    run(cfg) { cfg.expand = false; return 'Closing the detail sections.'; },
  },
  {
    name: 'compact', aliases: ['dense', 'tight'],
    help: 'compact — tighter layout, more on screen',
    run(cfg) { cfg.density = 'compact'; return 'Compact layout.'; },
  },
  {
    name: 'comfortable', aliases: ['normal', 'roomy', 'spacious'],
    help: 'comfortable — the default spacing',
    run(cfg) { cfg.density = 'normal'; return 'Normal spacing.'; },
  },
  {
    name: 'alerts', aliases: ['alert', 'notify', 'notifications', 'ping'],
    help: 'alerts on · alerts off · alerts 80 — notify me when a new setup passes my orders',
    run(cfg, rest) {
      const r = rest.trim().toLowerCase();
      const n = fsNum(r);
      if (/off|stop|no|none|disable/.test(r)) {
        cfg.alerts = false;
        if (typeof disablePush === 'function') disablePush();
        return 'Alerts off.';
      }
      if (n !== null) {
        cfg.alerts = true; cfg.alertMinConf = n;
        return `Alerts on for new setups scored ${n} or better that also pass your other orders.`
             + (typeof Notification !== 'undefined' && Notification.permission !== 'granted'
                ? ' Your browser will ask permission.' : '');
      }
      if (/on|yes|enable|/.test(r)) {
        cfg.alerts = true;
        // Also subscribe to real push, which is what reaches a closed app. The
        // page-only Notification API cannot, and relying on it alone is why
        // alerts did nothing on the installed app.
        if (typeof enablePush === 'function') {
          enablePush().then((res) => {
            if (typeof S !== 'undefined') {
              S.lastMsg = { ok: res.ok, msg: res.msg };
              if (typeof render === 'function') render();
            }
          });
          return 'Alerts on — setting up notifications…';
        }
        return 'Alerts on. You will be told when a NEW setup passes your standing orders.';
      }
      return null;
    },
  },
  {
    name: 'reset', aliases: ['clear', 'default', 'everything', 'all'],
    help: 'reset — forget every order and show everything again',
    run(cfg) { Object.assign(cfg, FS_DEFAULTS); return 'Cleared every order. Showing everything.'; },
  },
  {
    name: 'refresh', aliases: ['reload', 'update', 'fetch'],
    help: 'refresh — pull the feed again now',
    run() { if (typeof cycle === 'function') cycle(); return 'Pulling the feed again.'; },
  },
  {
    name: 'balance', aliases: ['account', 'capital', 'deposit', 'funds', 'bankroll'],
    help: 'balance 5000 — set your account size for the money figures',
    run(cfg, rest) {
      const n = fsNum(String(rest).replace(/,/g, ''));
      if (n === null || n <= 0) return null;
      cfg.balance = n;
      return `Account set to ${n.toLocaleString()} ${cfg.currency}. Every money figure now uses it.`;
    },
  },
  {
    name: 'risk', aliases: ['riskpct', 'risking', 'perTrade'],
    help: 'risk 2% — percent of the account risked per trade',
    run(cfg, rest) {
      const n = fsNum(rest);
      if (n === null || n <= 0 || n > 100) return null;
      cfg.riskPct = n;
      const amt = cfg.balance * n / 100;
      return `Risking ${n}% per trade — ${amt.toLocaleString(undefined,{maximumFractionDigits:2})} ${cfg.currency}, which is your 1R.`;
    },
  },
  {
    name: 'currency', aliases: ['ccy', 'gbp', 'usd', 'eur', 'jpy', 'chf', 'cad', 'pounds', 'dollars', 'euros', 'yen'],
    help: 'currency gbp · usd · eur · jpy · chf · cad',
    run(cfg, rest, matched) {
      const all = ((rest || '') + ' ' + (matched || '')).toLowerCase();
      const c = /gbp|pound|sterling|£/.test(all) ? 'GBP'
              : /\busd\b|dollar|\$/.test(all) ? 'USD'
              : /eur|euro|€/.test(all) ? 'EUR'
              : /jpy|yen|¥/.test(all) ? 'JPY'
              : /chf|franc|swiss/.test(all) ? 'CHF'
              : /cad|loonie|canad/.test(all) ? 'CAD' : null;
      if (!c) return null;
      cfg.currency = c;
      return `Showing money in ${c}.`;
    },
  },
  {
    name: 'tab', aliases: ['open', 'go', 'view', 'switch'],
    help: 'ledger · market · tested · signals — switch pane',
    run(cfg, rest, matched) {
      // "ledger" on its own is both the verb and the target.
      const all = ((rest || '') + ' ' + (matched || '')).toLowerCase();
      const want = /history|past|won|lost/.test(all) ? 'history'
                 : /ledger|record|result/.test(all) ? 'ledger'
                 : /market|voice|context|condition/.test(all) ? 'market'
                 : /calc|maths|math|money/.test(all) ? 'calc'
                 : /test|trial|strateg|search/.test(all) ? 'tested'
                 : /signal|setup|live|trade/.test(all) ? 'signals' : null;
      if (!want) return null;
      cfg.tab = want;
      return `Opened ${want}.`;
    },
  },
  {
    name: 'research', aliases: ['ask', 'explain', 'why', 'learn', 'teach'],
    help: 'research <question> — ask anything about this site or about trading',
    run(cfg, rest) {
      if (typeof openResearch === 'function') { openResearch(rest || ''); return 'Opening Research.'; }
      return null;
    },
  },
  {
    name: 'help', aliases: ['commands', 'orders', '?', 'what'],
    help: 'help — list everything you can tell it to do',
    run() {
      return 'ORDERS:\n' + FS_COMMANDS.map(c => '  ' + c.help).join('\n');
    },
  },
];

/* ── parsing ─────────────────────────────────────────────────────────────
   Deliberately forgiving. "only gold", "show me gold", "gold only", "GOLD"
   all land in the same place, because an order you have to phrase exactly is
   not an order, it is a syntax.
   ---------------------------------------------------------------------- */
function fsParse(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  // strip filler so "show me only the gold setups please" still works
  const text = raw.toLowerCase()
    .replace(/\b(me|the|a|an|please|by|to|is|are|with|and)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();

  // A pane name anywhere in the input wins outright. These words are not
  // ambiguous — nothing else on this site is called "ledger" — and resolving
  // them first stops "open market" matching expand's 'open' alias and
  // "show me the ledger" matching only's 'show'.
  const PANE_RE = /\b(ledger|market|tested|signals?|trials?|record|history|past|results?|calculator|calc|maths|math)\b/;
  const paneHit = text.match(PANE_RE);
  if (paneHit) {
    const tabCmd = FS_COMMANDS.find(c => c.name === 'tab');
    // ...unless the input also names a filter that takes a target, e.g.
    // "only gold" has no pane word, but "hide signals" should still hide.
    const isFilterish = /\b(only|show|hide|just|filter)\b/.test(text) && !/\b(open|go|tab|view|switch)\b/.test(text)
                        && /\b(gold|xau|eur|gbp|usd|jpy|btc|eth|buy|sell|weak)\b/.test(text);
    if (tabCmd && !isFilterish) return { cmd: tabCmd, rest: paneHit[1], matched: paneHit[1] };
  }

  const words = text.split(' ');
  for (let i = 0; i < words.length; i++) {
    const w = words[i].replace(/[^a-z?]/g, '');
    const cmd = FS_COMMANDS.find(c => c.name === w || (c.aliases || []).includes(w));
    // Pass the matched word through. An alias can BE the argument — typing
    // "ledger" matches the tab command via its alias list, and without this the
    // command received an empty rest and could not tell which pane was meant.
    if (cmd) return { cmd, rest: words.slice(i + 1).join(' '), matched: w };
  }
  // No verb found. Treat a bare instrument as "only <that>", because typing
  // "gold" plainly means show me gold.
  const toks = fsPairTokens(text);
  if (toks.length) return { cmd: FS_COMMANDS[0], rest: toks.join(' ') };
  return { cmd: null, rest: raw };
}

function fsRun(input, cfg) {
  const p = fsParse(input);
  if (!p) return { ok: false, msg: '' };
  if (!p.cmd) return { ok: false, msg: `I do not have an order for "${p.rest}". Type help to see what I can do.` };
  let msg;
  try { msg = p.cmd.run(cfg, p.rest, p.matched); }
  catch (e) { return { ok: false, msg: `That order failed: ${e.message}` }; }
  if (msg === null || msg === undefined) {
    return { ok: false, msg: `I understood "${p.cmd.name}" but not "${p.rest}". Try: ${p.cmd.help}` };
  }
  fsSaveConfig(cfg);
  return { ok: true, msg };
}

/** Short labels for the orders currently in force, so state is never hidden. */
function fsActiveChips(cfg) {
  const out = [];
  if (cfg.pairs)              out.push(['only ' + cfg.pairs.join(' '), 'pairs']);
  if (cfg.direction)          out.push([cfg.direction + ' only', 'direction']);
  if (cfg.minConfidence != null) out.push(['conf ≥ ' + cfg.minConfidence, 'minConfidence']);
  if (cfg.minR != null)       out.push(['TP1 ≥ ' + cfg.minR + 'R', 'minR']);
  if (cfg.hideWeak)           out.push(['no weak', 'hideWeak']);
  if (cfg.newsStrict)         out.push(['news strict', 'newsStrict']);
  if (cfg.limit != null)      out.push(['top ' + cfg.limit, 'limit']);
  if (cfg.sort !== 'newest')  out.push(['by ' + cfg.sort, 'sort']);
  if (cfg.expand)             out.push(['expanded', 'expand']);
  if (cfg.density !== 'normal') out.push([cfg.density, 'density']);
  if (cfg.balance !== FS_DEFAULTS.balance || cfg.riskPct !== FS_DEFAULTS.riskPct || cfg.currency !== FS_DEFAULTS.currency)
    out.push([`${cfg.riskPct}% of ${Number(cfg.balance).toLocaleString()} ${cfg.currency}`, 'balance']);
  if (cfg.alerts) out.push(['alerts' + (cfg.alertMinConf != null ? ' ≥ ' + cfg.alertMinConf : ''), 'alerts']);
  return out;
}

/** Applies the standing orders to a signal list. Pure: no DOM, no side effects. */
function fsApply(signals, cfg, read) {
  let list = signals.slice();
  if (cfg.pairs && cfg.pairs.length) {
    list = list.filter(s => {
      const p = fsNorm(read.pair(s));                 // EUR/USD -> EURUSD
      return cfg.pairs.some(t => p.includes(fsNorm(t)));
    });
  }
  if (cfg.direction) list = list.filter(s => String(read.dir(s) || '').toUpperCase().startsWith(cfg.direction[0]));
  if (cfg.minConfidence != null) list = list.filter(s => { const c = read.conf(s); return c != null && c >= cfg.minConfidence; });
  if (cfg.minR != null) list = list.filter(s => { const r = read.r1(s); return r != null && r >= cfg.minR; });
  if (cfg.hideWeak) list = list.filter(s => read.weak(s) !== true);
  if (cfg.newsStrict) list = list.filter(s => read.news(s) === 'clear');

  const cmp = {
    confidence: (a, b) => (read.conf(b) ?? -1e9) - (read.conf(a) ?? -1e9),
    r:          (a, b) => (read.r1(b) ?? -1e9) - (read.r1(a) ?? -1e9),
    pair:       (a, b) => String(read.pair(a)).localeCompare(String(read.pair(b))),
    newest:     (a, b) => (read.at(b) ?? 0) - (read.at(a) ?? 0),
  }[cfg.sort] || null;
  if (cmp) list.sort(cmp);

  if (cfg.limit != null) list = list.slice(0, cfg.limit);
  return list;
}

window.FS = { DEFAULTS: FS_DEFAULTS, COMMANDS: FS_COMMANDS, load: fsLoadConfig, save: fsSaveConfig,
              run: fsRun, parse: fsParse, apply: fsApply, chips: fsActiveChips };
