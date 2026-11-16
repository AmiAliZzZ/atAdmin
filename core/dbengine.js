'use strict';
/*
 * DBEngine - internal, zero-dependency, in-memory SQL database with disk persistence.
 * Used by the txAdmin "Database" page. Nothing here needs MySQL/MariaDB/SQLite.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
let CURRENT_DB = 'dbengine';

class SQLError extends Error {}
const fail = (m) => { throw new SQLError(m); };

/* ------------------------------------------------------------------ tokenizer */
const ID_RE = /[A-Za-z_\u0080-\uffff][\w$\u0080-\uffff]*/y;
const NUM_RE = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const HEX_RE = /0[xX][0-9a-fA-F]+/y;
const OPS2 = new Set(['<=', '>=', '<>', '!=', '||', '&&', ':=']);
const ESC = { n: '\n', r: '\r', t: '\t', '0': '\0', b: '\b', Z: '\x1a' };

function* statements(sql) {
    const n = sql.length;
    let i = 0, toks = [];
    while (i < n) {
        const c = sql.charCodeAt(i);
        if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 0xfeff) { i++; continue; }
        const ch = sql[i];
        if ((ch === '-' && sql[i + 1] === '-' && (i + 2 >= n || /\s/.test(sql[i + 2]))) || ch === '#') {
            const e = sql.indexOf('\n', i); i = e < 0 ? n : e + 1; continue;
        }
        if (ch === '/' && sql[i + 1] === '*') {
            const e = sql.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue;
        }
        const s = i;
        if (ch === "'" || ch === '"') {
            let v = '', j = i + 1, closed = false;
            while (j < n) {
                const d = sql[j];
                if (d === '\\' && j + 1 < n) {
                    const nx = sql[j + 1];
                    v += (nx in ESC) ? ESC[nx] : nx; j += 2; continue;
                }
                if (d === ch) {
                    if (sql[j + 1] === ch) { v += ch; j += 2; continue; }
                    closed = true; j++; break;
                }
                v += d; j++;
            }
            if (!closed) fail('Unterminated string literal');
            toks.push({ k: 'str', v, s, e: j }); i = j; continue;
        }
        if (ch === '`') {
            const e = sql.indexOf('`', i + 1);
            if (e < 0) fail('Unterminated identifier');
            const v = sql.slice(i + 1, e).replace(/``/g, '`');
            toks.push({ k: 'id', v, u: v.toUpperCase(), q: true, s, e: e + 1 }); i = e + 1; continue;
        }
        if (ch === '0' && (sql[i + 1] === 'x' || sql[i + 1] === 'X')) {
            HEX_RE.lastIndex = i; const m = HEX_RE.exec(sql);
            if (m) { toks.push({ k: 'num', v: parseInt(m[0], 16), s, e: i + m[0].length }); i += m[0].length; continue; }
        }
        if ((ch >= '0' && ch <= '9') || (ch === '.' && sql[i + 1] >= '0' && sql[i + 1] <= '9')) {
            NUM_RE.lastIndex = i; const m = NUM_RE.exec(sql);
            toks.push({ k: 'num', v: Number(m[0]), s, e: i + m[0].length }); i += m[0].length; continue;
        }
        ID_RE.lastIndex = i; const m = ID_RE.exec(sql);
        if (m && m.index === i) {
            toks.push({ k: 'id', v: m[0], u: m[0].toUpperCase(), q: false, s, e: i + m[0].length }); i += m[0].length; continue;
        }
        const two = sql.substr(i, 2);
        if (OPS2.has(two)) { toks.push({ k: 'op', v: two, s, e: i + 2 }); i += 2; continue; }
        if (ch === ';') {
            if (toks.length) yield { toks, src: sql, from: toks[0].s, to: toks[toks.length - 1].e };
            toks = []; i++; continue;
        }
        if ('()+-*/%=<>,.?!'.includes(ch)) {
            toks.push({ k: ch === '?' ? 'param' : 'op', v: ch, s, e: i + 1 }); i++; continue;
        }
        fail(`Unexpected character '${ch}' at position ${i}`);
    }
    if (toks.length) yield { toks, src: sql, from: toks[0].s, to: toks[toks.length - 1].e };
}

/* ------------------------------------------------------------------ parser */
const RESERVED = new Set(['SELECT', 'FROM', 'WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'CROSS', 'OUTER', 'ON', 'UNION', 'SET', 'VALUES', 'AND', 'OR', 'NOT', 'AS', 'INTO', 'USING', 'NATURAL', 'FOR', 'DUPLICATE']);
const AGG = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'GROUP_CONCAT']);

class Parser {
    constructor(st, params) { this.t = st.toks; this.src = st.src; this.i = 0; this.params = params || []; this.pi = 0; }
    peek(o = 0) { return this.t[this.i + o]; }
    next() { return this.t[this.i++]; }
    end() { return this.i >= this.t.length; }
    isKw(...ws) { const t = this.t[this.i]; return !!t && t.k === 'id' && !t.q && ws.includes(t.u); }
    isKwAt(o, ...ws) { const t = this.t[this.i + o]; return !!t && t.k === 'id' && !t.q && ws.includes(t.u); }
    eatKw(...ws) { if (this.isKw(...ws)) { this.i++; return true; } return false; }
    expectKw(w) { if (!this.eatKw(w)) this.err(`expected ${w}`); }
    isOp(o) { const t = this.t[this.i]; return !!t && t.k === 'op' && t.v === o; }
    eatOp(o) { if (this.isOp(o)) { this.i++; return true; } return false; }
    expectOp(o) { if (!this.eatOp(o)) this.err(`expected '${o}'`); }
    err(m) { const t = this.t[this.i]; fail(`Syntax error: ${m}${t ? ` near '${this.src.slice(t.s, Math.min(t.e + 12, t.s + 40))}'` : ' at end of statement'}`); }
    ident() {
        const t = this.next();
        if (!t || t.k !== 'id') { this.i--; this.err('expected identifier'); }
        return t.v;
    }
    /* table name, optionally db-qualified (db.table -> table) */
    tableName() {
        let n = this.ident();
        if (this.isOp('.')) { this.i++; n = this.ident(); }
        return n;
    }
    ifExists() { if (this.isKw('IF') && this.isKwAt(1, 'EXISTS')) { this.i += 2; return true; } return false; }
    ifNotExists() { if (this.isKw('IF') && this.isKwAt(1, 'NOT') && this.isKwAt(2, 'EXISTS')) { this.i += 3; return true; } return false; }
    done() { if (!this.end()) this.err('unexpected token'); }

    /* ---------------- statements ---------------- */
    statement() {
        const t = this.peek();
        if (!t || t.k !== 'id') this.err('expected a statement');
        const w = t.u;
        switch (w) {
            case 'SELECT': { const s = this.select(); this.done(); return s; }
            case 'INSERT': case 'REPLACE': return this.insert();
            case 'UPDATE': return this.update();
            case 'DELETE': return this.del();
            case 'CREATE': return this.create();
            case 'DROP': return this.drop();
            case 'ALTER': return this.alter();
            case 'TRUNCATE': { this.i++; this.eatKw('TABLE'); const name = this.tableName(); this.done(); return { type: 'truncate', table: name }; }
            case 'RENAME': { this.i++; this.expectKw('TABLE'); const from = this.tableName(); this.expectKw('TO'); const to = this.tableName(); this.done(); return { type: 'rename', from, to }; }
            case 'SHOW': return this.show();
            case 'DESCRIBE': case 'DESC': { this.i++; const name = this.tableName(); this.i = this.t.length; return { type: 'show', what: 'columns', table: name }; }
            case 'EXPLAIN': { this.i++; if (this.isKw('SELECT')) { const s = this.select(); this.done(); return { type: 'explain', sel: s }; } const name = this.tableName(); this.i = this.t.length; return { type: 'show', what: 'columns', table: name }; }
            case 'BEGIN': case 'COMMIT': case 'ROLLBACK': this.i = this.t.length; return { type: 'tx', op: w };
            case 'START': this.i = this.t.length; return { type: 'tx', op: 'BEGIN' };
            case 'USE': case 'SET': case 'LOCK': case 'UNLOCK': case 'OPTIMIZE': case 'ANALYZE': case 'FLUSH': case 'CHECK': case 'REPAIR': case 'GRANT': case 'REVOKE': case 'COMMENT':
                this.i = this.t.length; return { type: 'noop', what: w };
            default: this.err(`unsupported statement '${t.v}'`);
        }
    }

    show() {
        this.i++;
        this.eatKw('FULL');
        if (this.eatKw('TABLES')) { if (this.eatKw('FROM', 'IN')) this.ident(); this.i = this.t.length; return { type: 'show', what: 'tables' }; }
        if (this.eatKw('DATABASES', 'SCHEMAS')) { this.i = this.t.length; return { type: 'show', what: 'databases' }; }
        if (this.eatKw('COLUMNS', 'FIELDS')) { this.expectKw('FROM'); const n = this.tableName(); this.i = this.t.length; return { type: 'show', what: 'columns', table: n }; }
        if (this.eatKw('INDEX', 'INDEXES', 'KEYS')) { this.expectKw('FROM'); const n = this.tableName(); this.i = this.t.length; return { type: 'show', what: 'indexes', table: n }; }
        if (this.eatKw('CREATE')) { this.expectKw('TABLE'); const n = this.tableName(); this.i = this.t.length; return { type: 'show', what: 'create', table: n }; }
        if (this.eatKw('TABLE')) { this.expectKw('STATUS'); this.i = this.t.length; return { type: 'show', what: 'status' }; }
        if (this.eatKw('VARIABLES', 'STATUS', 'WARNINGS', 'ERRORS', 'PROCESSLIST', 'ENGINES')) { this.i = this.t.length; return { type: 'show', what: 'empty' }; }
        this.err('unsupported SHOW');
    }

    /* ---------------- SELECT ---------------- */
    select() {
        this.expectKw('SELECT');
        const s = { type: 'select', distinct: false, cols: [], from: null, joins: [], where: null, group: [], having: null, order: [], limit: null, offset: 0, union: null };
        if (this.eatKw('DISTINCT')) s.distinct = true; else this.eatKw('ALL');
        for (;;) {
            if (this.isOp('*')) { this.i++; s.cols.push({ star: true }); }
            else if (this.peek() && this.peek().k === 'id' && this.isOpAt(1, '.') && this.isOpAt(2, '*')) {
                const tb = this.ident(); this.i += 2; s.cols.push({ star: true, tbl: tb });
            } else {
                const a = this.i; const e = this.expr(); const b = this.i;
                let alias = null;
                if (this.eatKw('AS')) { const t = this.next(); if (!t || (t.k !== 'id' && t.k !== 'str')) this.err('bad alias'); alias = t.v; }
                else if (this.peek() && this.peek().k === 'id' && (this.peek().q || !RESERVED.has(this.peek().u))) alias = this.next().v;
                const label = this.src.slice(this.t[a].s, this.t[b - 1].e);
                s.cols.push({ e, alias, label });
            }
            if (!this.eatOp(',')) break;
        }
        if (this.eatKw('FROM')) {
            s.from = this.tableRef();
            for (;;) {
                if (this.eatOp(',')) { s.joins.push({ type: 'CROSS', ...this.tableRef(), on: null }); continue; }
                let type = null;
                if (this.eatKw('JOIN')) type = 'INNER';
                else if (this.isKw('INNER', 'CROSS')) { type = this.next().u; this.expectKw('JOIN'); }
                else if (this.isKw('LEFT', 'RIGHT')) { type = this.next().u; this.eatKw('OUTER'); this.expectKw('JOIN'); }
                if (!type) break;
                if (type === 'RIGHT') fail('RIGHT JOIN is not supported - swap the tables and use LEFT JOIN');
                const ref = this.tableRef();
                let on = null;
                if (this.eatKw('ON')) on = this.expr();
                else if (this.eatKw('USING')) {
                    this.expectOp('('); const cs = [this.ident()]; while (this.eatOp(',')) cs.push(this.ident()); this.expectOp(')');
                    on = { n: 'using', cols: cs };
                }
                s.joins.push({ type, ...ref, on });
            }
        }
        if (this.eatKw('WHERE')) s.where = this.expr();
        if (this.eatKw('GROUP')) { this.expectKw('BY'); do { s.group.push(this.expr()); } while (this.eatOp(',')); }
        if (this.eatKw('HAVING')) s.having = this.expr();
        if (this.eatKw('ORDER')) {
            this.expectKw('BY');
            do { const e = this.expr(); let dir = 1; if (this.eatKw('DESC')) dir = -1; else this.eatKw('ASC'); s.order.push({ e, dir }); } while (this.eatOp(','));
        }
        if (this.eatKw('LIMIT')) {
            const a = this.limNum();
            if (this.eatOp(',')) { s.offset = a; s.limit = this.limNum(); }
            else { s.limit = a; if (this.eatKw('OFFSET')) s.offset = this.limNum(); }
        }
        if (this.isKw('UNION')) {
            this.i++; const all = this.eatKw('ALL'); this.eatKw('DISTINCT');
            s.union = { all, sel: this.select() };
        }
        return s;
    }
    isOpAt(o, v) { const t = this.t[this.i + o]; return !!t && t.k === 'op' && t.v === v; }
    limNum() {
        const t = this.next();
        if (t && t.k === 'param') return Number(this.params[this.pi++]);
        if (!t || t.k !== 'num') { this.i--; this.err('expected number'); }
        return t.v;
    }
    tableRef() {
        if (this.isOp('(')) {
            this.i++; const sel = this.select(); this.expectOp(')');
            this.eatKw('AS'); const alias = this.ident();
            return { sub: sel, alias };
        }
        const table = this.tableName();
        let alias = null;
        if (this.eatKw('AS')) alias = this.ident();
        else if (this.peek() && this.peek().k === 'id' && (this.peek().q || !RESERVED.has(this.peek().u))) alias = this.next().v;
        return { table, alias };
    }

    /* ---------------- expressions ---------------- */
    expr() { return this.or(); }
    or() { let l = this.and(); while (this.isKw('OR') || this.isOp('||')) { this.i++; l = { n: 'bin', op: 'OR', l, r: this.and() }; } return l; }
    and() { let l = this.not(); while (this.isKw('AND') || this.isOp('&&')) { this.i++; l = { n: 'bin', op: 'AND', l, r: this.not() }; } return l; }
    not() { if (this.isKw('NOT') && !this.isKwAt(1, 'EXISTS')) { this.i++; return { n: 'un', op: 'NOT', e: this.not() }; } if (this.isOp('!')) { this.i++; return { n: 'un', op: 'NOT', e: this.not() }; } return this.cmp(); }
    cmp() {
        let l = this.add();
        for (;;) {
            const t = this.peek();
            if (!t) return l;
            if (t.k === 'op' && ['=', '<>', '!=', '<', '>', '<=', '>='].includes(t.v)) {
                this.i++; let op = t.v === '<>' ? '!=' : t.v;
                l = { n: 'bin', op, l, r: this.add() }; continue;
            }
            if (this.isKw('IS')) {
                this.i++; const neg = this.eatKw('NOT');
                if (this.eatKw('NULL')) { l = { n: 'isnull', e: l, not: neg }; continue; }
                if (this.eatKw('TRUE')) { l = { n: 'bin', op: neg ? '!=' : '=', l, r: { n: 'lit', v: 1 } }; continue; }
                if (this.eatKw('FALSE')) { l = { n: 'bin', op: neg ? '!=' : '=', l, r: { n: 'lit', v: 0 } }; continue; }
                this.err('expected NULL/TRUE/FALSE after IS');
            }
            let neg = false;
            if (this.isKw('NOT') && this.isKwAt(1, 'IN', 'LIKE', 'BETWEEN', 'REGEXP', 'RLIKE')) { neg = true; this.i++; }
            if (this.eatKw('IN')) {
                this.expectOp('(');
                if (this.isKw('SELECT')) { const sel = this.select(); this.expectOp(')'); l = { n: 'insub', e: l, sel, not: neg }; continue; }
                const list = [this.expr()]; while (this.eatOp(',')) list.push(this.expr());
                this.expectOp(')'); l = { n: 'in', e: l, list, not: neg }; continue;
            }
            if (this.eatKw('LIKE')) { const p = this.add(); l = { n: 'like', e: l, p, not: neg }; if (this.eatKw('ESCAPE')) this.next(); continue; }
            if (this.eatKw('REGEXP', 'RLIKE')) { const p = this.add(); l = { n: 'regexp', e: l, p, not: neg }; continue; }
            if (this.eatKw('BETWEEN')) { const lo = this.add(); this.expectKw('AND'); const hi = this.add(); l = { n: 'between', e: l, lo, hi, not: neg }; continue; }
            if (neg) this.err('unexpected NOT');
            return l;
        }
    }
    add() { let l = this.mul(); while (this.isOp('+') || this.isOp('-')) { const op = this.next().v; l = { n: 'bin', op, l, r: this.mul() }; } return l; }
    mul() {
        let l = this.unary();
        for (;;) {
            if (this.isOp('*') || this.isOp('/') || this.isOp('%')) { const op = this.next().v; l = { n: 'bin', op, l, r: this.unary() }; }
            else if (this.isKw('DIV')) { this.i++; l = { n: 'bin', op: 'DIV', l, r: this.unary() }; }
            else if (this.isKw('MOD')) { this.i++; l = { n: 'bin', op: '%', l, r: this.unary() }; }
            else return l;
        }
    }
    unary() {
        if (this.isOp('-')) { this.i++; const e = this.unary(); if (e.n === 'lit' && typeof e.v === 'number') return { n: 'lit', v: -e.v }; return { n: 'un', op: '-', e }; }
        if (this.isOp('+')) { this.i++; return this.unary(); }
        return this.primary();
    }
    primary() {
        const t = this.next();
        if (!t) { this.i--; this.err('unexpected end of expression'); }
        if (t.k === 'num' || t.k === 'str') return { n: 'lit', v: t.v };
        if (t.k === 'param') { if (this.pi >= this.params.length) fail('Missing value for placeholder ?'); return { n: 'lit', v: this.params[this.pi++] }; }
        if (t.k === 'op' && t.v === '(') {
            if (this.isKw('SELECT')) { const sel = this.select(); this.expectOp(')'); return { n: 'sub', sel }; }
            const e = this.expr(); this.expectOp(')'); return e;
        }
        if (t.k !== 'id') { this.i--; this.err('unexpected token in expression'); }
        if (!t.q) {
            switch (t.u) {
                case 'NULL': return { n: 'lit', v: null };
                case 'TRUE': return { n: 'lit', v: 1 };
                case 'FALSE': return { n: 'lit', v: 0 };
                case 'DEFAULT': if (!this.isOp('(')) return { n: 'default' }; break;
                case 'CURRENT_TIMESTAMP': case 'CURRENT_DATE': case 'CURRENT_TIME': case 'LOCALTIMESTAMP':
                    if (!this.isOp('(')) return { n: 'fn', name: 'NOW', args: [] }; break;
                case 'EXISTS': { this.expectOp('('); const sel = this.select(); this.expectOp(')'); return { n: 'exists', sel }; }
                case 'NOT': if (this.isKw('EXISTS')) { this.i++; this.expectOp('('); const sel = this.select(); this.expectOp(')'); return { n: 'exists', sel, not: true }; } break;
                case 'CASE': return this.caseExpr();
                case 'CAST': {
                    this.expectOp('('); const e = this.expr(); this.expectKw('AS'); const ty = this.ident().toUpperCase();
                    if (this.eatOp('(')) { while (!this.eatOp(')')) this.i++; }
                    this.eatKw('SIGNED', 'UNSIGNED'); this.expectOp(')'); return { n: 'cast', e, ty };
                }
            }
        }
        if (this.isOp('(') && !t.q) {
            this.i++;
            const name = t.u;
            const node = { n: 'fn', name, args: [], distinct: false, star: false };
            if (AGG.has(name)) {
                if (this.eatKw('DISTINCT')) node.distinct = true;
                if (this.isOp('*')) { this.i++; node.star = true; }
                else {
                    node.args.push(this.expr());
                    if (name === 'GROUP_CONCAT') {
                        while (this.eatOp(',')) node.args.push(this.expr());
                        if (this.eatKw('SEPARATOR')) node.sep = this.next().v;
                    }
                }
                this.expectOp(')'); return node;
            }
            if (!this.isOp(')')) { do { node.args.push(this.expr()); } while (this.eatOp(',')); }
            this.expectOp(')'); return node;
        }
        let tbl = null, col = t.v;
        if (this.isOp('.')) {
            this.i++; tbl = col;
            const c2 = this.next(); if (!c2 || c2.k !== 'id') { this.i--; this.err('expected column name'); }
            col = c2.v;
            if (this.isOp('.')) { this.i++; tbl = col; const c3 = this.next(); col = c3.v; } // db.table.col
        }
        return { n: 'col', t: tbl, c: col };
    }
    caseExpr() {
        const node = { n: 'case', base: null, whens: [], els: null };
        if (!this.isKw('WHEN')) node.base = this.expr();
        while (this.eatKw('WHEN')) { const c = this.expr(); this.expectKw('THEN'); node.whens.push({ c, r: this.expr() }); }
        if (this.eatKw('ELSE')) node.els = this.expr();
        this.expectKw('END');
        return node;
    }

    /* ---------------- INSERT / UPDATE / DELETE ---------------- */
    insert() {
        const verb = this.next().u;
        const st = { type: 'insert', replace: verb === 'REPLACE', ignore: false, table: null, cols: null, rows: null, sel: null, dup: null };
        if (this.eatKw('IGNORE')) st.ignore = true;
        this.eatKw('INTO');
        st.table = this.tableName();
        if (this.isOp('(') && !this.isKwAt(1, 'SELECT')) {
            this.i++; st.cols = [this.ident()]; while (this.eatOp(',')) st.cols.push(this.ident()); this.expectOp(')');
        }
        if (this.eatKw('VALUES', 'VALUE')) {
            st.rows = [];
            do {
                this.expectOp('('); const row = [];
                if (!this.isOp(')')) { do { row.push(this.expr()); } while (this.eatOp(',')); }
                this.expectOp(')'); st.rows.push(row);
            } while (this.eatOp(','));
        } else if (this.eatKw('SET')) {
            st.cols = []; const row = [];
            do { st.cols.push(this.ident()); this.expectOp('='); row.push(this.expr()); } while (this.eatOp(','));
            st.rows = [row];
        } else if (this.isKw('SELECT')) { st.sel = this.select(); }
        else if (this.isOp('(')) { this.i++; st.sel = this.select(); this.expectOp(')'); }
        else this.err('expected VALUES or SELECT');
        if (this.isKw('ON') && this.isKwAt(1, 'DUPLICATE')) {
            this.i += 3; this.expectKw('UPDATE');
            st.dup = [];
            do { const c = this.ident(); this.expectOp('='); st.dup.push({ c, e: this.expr() }); } while (this.eatOp(','));
        }
        this.done();
        return st;
    }
    update() {
        this.i++;
        const st = { type: 'update', table: this.tableName(), alias: null, sets: [], where: null, order: [], limit: null };
        if (this.peek() && this.peek().k === 'id' && !this.isKw('SET')) st.alias = this.ident();
        this.expectKw('SET');
        do {
            let c = this.ident(); if (this.isOp('.')) { this.i++; c = this.ident(); }
            this.expectOp('='); st.sets.push({ c, e: this.expr() });
        } while (this.eatOp(','));
        if (this.eatKw('WHERE')) st.where = this.expr();
        if (this.eatKw('ORDER')) { this.expectKw('BY'); do { const e = this.expr(); let dir = 1; if (this.eatKw('DESC')) dir = -1; else this.eatKw('ASC'); st.order.push({ e, dir }); } while (this.eatOp(',')); }
        if (this.eatKw('LIMIT')) st.limit = this.limNum();
        this.done();
        return st;
    }
    del() {
        this.i++; this.expectKw('FROM');
        const st = { type: 'delete', table: this.tableName(), alias: null, where: null, order: [], limit: null };
        if (this.peek() && this.peek().k === 'id' && !this.isKw('WHERE', 'ORDER', 'LIMIT')) st.alias = this.ident();
        if (this.eatKw('WHERE')) st.where = this.expr();
        if (this.eatKw('ORDER')) { this.expectKw('BY'); do { const e = this.expr(); let dir = 1; if (this.eatKw('DESC')) dir = -1; else this.eatKw('ASC'); st.order.push({ e, dir }); } while (this.eatOp(',')); }
        if (this.eatKw('LIMIT')) st.limit = this.limNum();
        this.done();
        return st;
    }

    /* ---------------- DDL ---------------- */
    create() {
        this.i++;
        const temp = this.eatKw('TEMPORARY');
        if (this.eatKw('DATABASE', 'SCHEMA')) { this.ifNotExists(); this.i = this.t.length; return { type: 'noop', what: 'CREATE DATABASE' }; }
        if (this.eatKw('UNIQUE')) { this.expectKw('INDEX'); return this.createIndex(true); }
        if (this.eatKw('INDEX')) return this.createIndex(false);
        if (this.eatKw('VIEW') || this.isKw('OR')) this.err('views are not supported');
        this.expectKw('TABLE');
        const st = { type: 'create', ifNot: this.ifNotExists(), name: this.tableName(), cols: [], indexes: [], auto: null };
        if (this.eatKw('LIKE')) { st.like = this.tableName(); this.done(); return st; }
        this.expectOp('(');
        for (;;) {
            if (this.isKw('PRIMARY')) { this.i++; this.expectKw('KEY'); st.indexes.push({ name: 'PRIMARY', cols: this.colList(), unique: true, pk: true }); this.idxTail(); }
            else if (this.isKw('UNIQUE')) { this.i++; this.eatKw('KEY', 'INDEX'); let nm = null; if (!this.isOp('(')) nm = this.ident(); st.indexes.push({ name: nm, cols: this.colList(), unique: true }); this.idxTail(); }
            else if (this.isKw('KEY', 'INDEX')) { this.i++; let nm = null; if (!this.isOp('(')) nm = this.ident(); st.indexes.push({ name: nm, cols: this.colList(), unique: false }); this.idxTail(); }
            else if (this.isKw('FULLTEXT', 'SPATIAL')) { this.i++; this.eatKw('KEY', 'INDEX'); if (!this.isOp('(')) this.ident(); this.colList(); }
            else if (this.isKw('CONSTRAINT') || this.isKw('FOREIGN') || this.isKw('CHECK')) this.skipItem();
            else st.cols.push(this.colDef());
            if (!this.eatOp(',')) break;
        }
        this.expectOp(')');
        // table options
        while (!this.end()) {
            if (this.isKw('AUTO_INCREMENT')) { this.i++; this.eatOp('='); const v = this.next(); if (v && v.k === 'num') st.auto = v.v; continue; }
            this.i++;
        }
        void temp;
        return st;
    }
    idxTail() { let d = 0; while (!this.end()) { if (this.isOp('(')) d++; else if (this.isOp(')')) { if (d === 0) return; d--; } else if (this.isOp(',') && d === 0) return; this.i++; } }
    skipItem() { let d = 0; while (!this.end()) { if (this.isOp('(')) d++; else if (this.isOp(')')) { if (d === 0) return; d--; } else if (this.isOp(',') && d === 0) return; this.i++; } }
    colList() {
        this.expectOp('('); const cs = [];
        do { cs.push(this.ident()); if (this.eatOp('(')) { this.next(); this.expectOp(')'); } this.eatKw('ASC', 'DESC'); } while (this.eatOp(','));
        this.expectOp(')'); return cs;
    }
    colDef() {
        const c = { name: this.ident(), type: 'text', notnull: false, def: undefined, auto: false, unique: false, pk: false };
        const tt = this.next(); if (!tt || tt.k !== 'id') { this.i--; this.err('expected column type'); }
        let ty = tt.u;
        if (ty === 'DOUBLE' && this.isKw('PRECISION')) this.i++;
        if (ty === 'LONG' && this.isKw('VARCHAR', 'TEXT')) ty = this.next().u;
        let args = '';
        if (this.isOp('(')) {
            const a = this.i; let d = 0;
            do { if (this.isOp('(')) d++; else if (this.isOp(')')) d--; this.i++; } while (d > 0 && !this.end());
            args = this.src.slice(this.t[a].s, this.t[this.i - 1].e);
        }
        c.type = ty.toLowerCase() + args;
        for (;;) {
            if (this.eatKw('UNSIGNED', 'SIGNED', 'ZEROFILL', 'BINARY')) { if (this.t[this.i - 1].u === 'UNSIGNED') c.type += ' unsigned'; continue; }
            if (this.isKw('NOT') && this.isKwAt(1, 'NULL')) { this.i += 2; c.notnull = true; continue; }
            if (this.eatKw('NULL')) { continue; }
            if (this.eatKw('AUTO_INCREMENT', 'AUTOINCREMENT')) { c.auto = true; continue; }
            if (this.isKw('PRIMARY')) { this.i++; this.eatKw('KEY'); c.pk = true; c.notnull = true; continue; }
            if (this.isKw('KEY')) { this.i++; c.pk = true; c.notnull = true; continue; }
            if (this.eatKw('UNIQUE')) { this.eatKw('KEY'); c.unique = true; continue; }
            if (this.eatKw('DEFAULT')) { c.def = this.defaultVal(); continue; }
            if (this.eatKw('COMMENT')) { this.next(); continue; }
            if (this.eatKw('COLLATE')) { this.next(); continue; }
            if (this.isKw('CHARACTER') || this.isKw('CHARSET')) { this.i++; this.eatKw('SET'); this.eatOp('='); this.next(); continue; }
            if (this.isKw('ON') && this.isKwAt(1, 'UPDATE')) { this.i += 2; this.next(); if (this.eatOp('(')) this.expectOp(')'); c.onUpdateNow = true; continue; }
            if (this.eatKw('REFERENCES')) { this.tableName(); if (this.isOp('(')) this.colList(); continue; }
            if (this.isKw('AFTER') || this.isKw('FIRST')) break;
            break;
        }
        return c;
    }
    defaultVal() {
        const t = this.peek();
        if (this.isOp('(')) { this.i++; const e = this.expr(); this.expectOp(')'); return { expr: e }; }
        if (t.k === 'id' && !t.q) {
            this.i++;
            if (t.u === 'NULL') return { v: null };
            if (t.u === 'TRUE') return { v: 1 };
            if (t.u === 'FALSE') return { v: 0 };
            if (/^(CURRENT_TIMESTAMP|NOW|LOCALTIMESTAMP|CURRENT_DATE)$/.test(t.u)) { if (this.eatOp('(')) { if (!this.isOp(')')) this.next(); this.expectOp(')'); } return { now: true }; }
            return { v: t.v };
        }
        const e = this.unary();
        if (e.n !== 'lit') this.err('bad DEFAULT');
        return { v: e.v };
    }
    createIndex(unique) {
        const name = this.ident(); this.expectKw('ON'); const table = this.tableName();
        const cols = this.colList(); this.i = this.t.length;
        return { type: 'createindex', name, table, cols, unique };
    }
    drop() {
        this.i++;
        if (this.eatKw('DATABASE', 'SCHEMA')) { this.i = this.t.length; return { type: 'noop', what: 'DROP DATABASE' }; }
        if (this.eatKw('INDEX')) { const name = this.ident(); this.expectKw('ON'); const table = this.tableName(); this.done(); return { type: 'dropindex', name, table }; }
        this.eatKw('TEMPORARY');
        this.expectKw('TABLE');
        const ifExists = this.ifExists(); const names = [this.tableName()];
        while (this.eatOp(',')) names.push(this.tableName());
        this.eatKw('CASCADE', 'RESTRICT'); this.done();
        return { type: 'drop', ifExists, names };
    }
    alter() {
        this.i++; this.expectKw('TABLE');
        const st = { type: 'alter', table: this.tableName(), actions: [] };
        do {
            if (this.eatKw('ADD')) {
                if (this.isKw('PRIMARY')) { this.i++; this.expectKw('KEY'); st.actions.push({ op: 'addindex', index: { name: 'PRIMARY', cols: this.colList(), unique: true, pk: true } }); this.idxTail(); }
                else if (this.isKw('UNIQUE')) { this.i++; this.eatKw('KEY', 'INDEX'); let nm = null; if (!this.isOp('(')) nm = this.ident(); st.actions.push({ op: 'addindex', index: { name: nm, cols: this.colList(), unique: true } }); this.idxTail(); }
                else if (this.isKw('KEY', 'INDEX')) { this.i++; let nm = null; if (!this.isOp('(')) nm = this.ident(); st.actions.push({ op: 'addindex', index: { name: nm, cols: this.colList(), unique: false } }); this.idxTail(); }
                else if (this.isKw('CONSTRAINT', 'FOREIGN', 'CHECK')) this.skipItem();
                else {
                    this.eatKw('COLUMN');
                    const col = this.colDef(); let pos = null;
                    if (this.eatKw('FIRST')) pos = { first: true }; else if (this.eatKw('AFTER')) pos = { after: this.ident() };
                    st.actions.push({ op: 'addcol', col, pos });
                }
            } else if (this.eatKw('DROP')) {
                if (this.isKw('PRIMARY')) { this.i++; this.expectKw('KEY'); st.actions.push({ op: 'droppk' }); }
                else if (this.eatKw('INDEX', 'KEY')) st.actions.push({ op: 'dropindex', name: this.ident() });
                else if (this.isKw('FOREIGN') || this.isKw('CONSTRAINT')) { this.i++; this.eatKw('KEY'); this.ident(); }
                else { this.eatKw('COLUMN'); st.actions.push({ op: 'dropcol', name: this.ident() }); }
            } else if (this.eatKw('MODIFY')) {
                this.eatKw('COLUMN'); const col = this.colDef(); let pos = null;
                if (this.eatKw('FIRST')) pos = { first: true }; else if (this.eatKw('AFTER')) pos = { after: this.ident() };
                st.actions.push({ op: 'modify', old: col.name, col, pos });
            } else if (this.eatKw('CHANGE')) {
                this.eatKw('COLUMN'); const old = this.ident(); const col = this.colDef(); let pos = null;
                if (this.eatKw('FIRST')) pos = { first: true }; else if (this.eatKw('AFTER')) pos = { after: this.ident() };
                st.actions.push({ op: 'modify', old, col, pos });
            } else if (this.eatKw('RENAME')) {
                if (this.eatKw('COLUMN')) { const a = this.ident(); this.expectKw('TO'); st.actions.push({ op: 'renamecol', from: a, to: this.ident() }); }
                else if (this.eatKw('INDEX', 'KEY')) { const a = this.ident(); this.expectKw('TO'); st.actions.push({ op: 'renameindex', from: a, to: this.ident() }); }
                else { this.eatKw('TO', 'AS'); st.actions.push({ op: 'rename', to: this.tableName() }); }
            } else if (this.eatKw('AUTO_INCREMENT')) { this.eatOp('='); st.actions.push({ op: 'auto', v: this.next().v }); }
            else if (this.isKw('ENGINE', 'CHARSET', 'CHARACTER', 'COLLATE', 'COMMENT', 'DEFAULT', 'ROW_FORMAT')) { this.i++; while (!this.end() && !this.isOp(',')) this.i++; }
            else this.err('unsupported ALTER action');
        } while (this.eatOp(','));
        this.done();
        return st;
    }
}/* ------------------------------------------------------------------ value helpers */
const NUMSTR = /^\s*[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?\s*$/i;
const DEFAULT = Symbol('default');

function toNum(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    const s = String(v).trim();
    if (s === '') return 0;
    const n = Number(s);
    if (!Number.isNaN(n)) return n;
    const m = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(s);
    return m ? Number(m[0]) : 0;
}
const truthy = (v) => v !== null && v !== undefined && (typeof v === 'number' ? v !== 0 : (typeof v === 'string' ? toNum(v) !== 0 : !!v));
function cmpVals(a, b) {
    if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
    if (typeof a === 'number' || typeof b === 'number') { const x = toNum(a), y = toNum(b); return x < y ? -1 : x > y ? 1 : 0; }
    const x = String(a).toLowerCase(), y = String(b).toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
}
function sortCmp(a, b) {
    const an = a === null || a === undefined, bn = b === null || b === undefined;
    if (an && bn) return 0; if (an) return -1; if (bn) return 1;
    return cmpVals(a, b);
}
function nkey(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return 'n' + v;
    const s = String(v);
    return NUMSTR.test(s) ? 'n' + Number(s) : 's' + s.toLowerCase();
}
const pad = (n, l = 2) => String(n).padStart(l, '0');
function fmtDate(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }

function kindOf(type) {
    const t = String(type || 'text').toLowerCase().replace(/\(.*$/, '').replace(/\s+unsigned/, '').trim();
    if (/^(tinyint|smallint|mediumint|int|integer|bigint|serial|year)$/.test(t)) {
        if (t === 'tinyint' && /\(1\)/.test(String(type))) return 'int';
        return 'int';
    }
    if (/^(float|double|real|decimal|numeric|dec|fixed)$/.test(t)) return 'float';
    if (/^(bool|boolean|bit)$/.test(t)) return 'bool';
    if (/^(json)$/.test(t)) return 'json';
    if (/^(date|datetime|timestamp|time)$/.test(t)) return 'date';
    return 'text';
}
function coerce(c, v) {
    if (v === null || v === undefined) return null;
    switch (c.kind) {
        case 'int': {
            let n;
            if (typeof v === 'number') n = v; else if (typeof v === 'boolean') n = v ? 1 : 0;
            else { const s = String(v); if (!NUMSTR.test(s)) fail(`Incorrect integer value: '${s.slice(0, 30)}' for column '${c.name}'`); n = Number(s); }
            if (!Number.isFinite(n)) fail(`Out of range value for column '${c.name}'`);
            return Math.round(n);
        }
        case 'float': {
            let n = typeof v === 'number' ? v : (typeof v === 'boolean' ? (v ? 1 : 0) : (NUMSTR.test(String(v)) ? Number(v) : NaN));
            if (!Number.isFinite(n)) fail(`Incorrect decimal value: '${String(v).slice(0, 30)}' for column '${c.name}'`);
            return n;
        }
        case 'bool': return truthy(v) ? 1 : 0;
        default:
            if (typeof v === 'string') return v;
            if (typeof v === 'number') return String(v);
            if (typeof v === 'boolean') return v ? '1' : '0';
            if (Buffer.isBuffer(v)) return v.toString('utf8');
            return JSON.stringify(v);
    }
}
const implicitDefault = (c) => (c.kind === 'int' || c.kind === 'float' || c.kind === 'bool') ? 0 : '';
function sqlLit(v) {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
    const s = String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\0/g, '\\0').replace(/\x1a/g, '\\Z');
    return "'" + s + "'";
}
const qid = (n) => '`' + String(n).replace(/`/g, '``') + '`';
const likeCache = new Map();
function likeRe(p) {
    let r = likeCache.get(p);
    if (!r) {
        let s = '';
        for (let i = 0; i < p.length; i++) {
            const ch = p[i];
            if (ch === '\\' && i + 1 < p.length) { s += p[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
            else if (ch === '%') s += '[\\s\\S]*'; else if (ch === '_') s += '[\\s\\S]';
            else s += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }
        r = new RegExp('^' + s + '$', 'i');
        if (likeCache.size > 500) likeCache.clear();
        likeCache.set(p, r);
    }
    return r;
}
function walk(node, cb) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const x of node) walk(x, cb); return; }
    if (node.n) cb(node);
    for (const k in node) { if (k === 'sel') continue; const v = node[k]; if (v && typeof v === 'object') walk(v, cb); }
}
function flatAnd(n, out) { if (n && n.n === 'bin' && n.op === 'AND') { flatAnd(n.l, out); flatAnd(n.r, out); } else if (n) out.push(n); return out; }

const FN = {
    UPPER: (a) => a[0] == null ? null : String(a[0]).toUpperCase(), UCASE: (a) => FN.UPPER(a),
    LOWER: (a) => a[0] == null ? null : String(a[0]).toLowerCase(), LCASE: (a) => FN.LOWER(a),
    LENGTH: (a) => a[0] == null ? null : Buffer.byteLength(String(a[0])), CHAR_LENGTH: (a) => a[0] == null ? null : String(a[0]).length, CHARACTER_LENGTH: (a) => FN.CHAR_LENGTH(a),
    CONCAT: (a) => a.some((x) => x == null) ? null : a.map(String).join(''),
    CONCAT_WS: (a) => a[0] == null ? null : a.slice(1).filter((x) => x != null).map(String).join(String(a[0])),
    COALESCE: (a) => { for (const x of a) if (x != null) return x; return null; },
    IFNULL: (a) => a[0] != null ? a[0] : a[1], NULLIF: (a) => (a[0] != null && a[1] != null && cmpVals(a[0], a[1]) === 0) ? null : a[0],
    IF: (a) => truthy(a[0]) ? a[1] : a[2],
    ABS: (a) => a[0] == null ? null : Math.abs(toNum(a[0])), FLOOR: (a) => a[0] == null ? null : Math.floor(toNum(a[0])),
    CEIL: (a) => a[0] == null ? null : Math.ceil(toNum(a[0])), CEILING: (a) => FN.CEIL(a),
    ROUND: (a) => { if (a[0] == null) return null; const d = a[1] == null ? 0 : toNum(a[1]); const m = Math.pow(10, d); return Math.round(toNum(a[0]) * m) / m; },
    SQRT: (a) => a[0] == null ? null : Math.sqrt(toNum(a[0])), POWER: (a) => (a[0] == null || a[1] == null) ? null : Math.pow(toNum(a[0]), toNum(a[1])), POW: (a) => FN.POWER(a),
    MOD: (a) => (a[0] == null || a[1] == null || toNum(a[1]) === 0) ? null : toNum(a[0]) % toNum(a[1]),
    RAND: () => Math.random(), NOW: () => fmtDate(), SYSDATE: () => fmtDate(),
    UNIX_TIMESTAMP: (a) => a[0] == null ? Math.floor(Date.now() / 1000) : Math.floor(new Date(String(a[0]).replace(' ', 'T')).getTime() / 1000),
    FROM_UNIXTIME: (a) => a[0] == null ? null : fmtDate(new Date(toNum(a[0]) * 1000)),
    DATE: (a) => a[0] == null ? null : String(a[0]).slice(0, 10), CURDATE: () => fmtDate().slice(0, 10), CURTIME: () => fmtDate().slice(11),
    YEAR: (a) => a[0] == null ? null : Number(String(a[0]).slice(0, 4)), MONTH: (a) => a[0] == null ? null : Number(String(a[0]).slice(5, 7)), DAY: (a) => a[0] == null ? null : Number(String(a[0]).slice(8, 10)),
    SUBSTRING: (a) => { if (a[0] == null) return null; const s = String(a[0]); let st = toNum(a[1]); if (st > 0) st -= 1; else if (st < 0) st = s.length + st; else return ''; return a[2] == null ? s.slice(st) : s.substr(st, Math.max(0, toNum(a[2]))); },
    SUBSTR: (a) => FN.SUBSTRING(a), MID: (a) => FN.SUBSTRING(a),
    LEFT: (a) => a[0] == null ? null : String(a[0]).slice(0, Math.max(0, toNum(a[1]))), RIGHT: (a) => { if (a[0] == null) return null; const s = String(a[0]); const n = Math.max(0, toNum(a[1])); return n ? s.slice(-n) : ''; },
    TRIM: (a) => a[0] == null ? null : String(a[0]).trim(), LTRIM: (a) => a[0] == null ? null : String(a[0]).replace(/^\s+/, ''), RTRIM: (a) => a[0] == null ? null : String(a[0]).replace(/\s+$/, ''),
    REPLACE: (a) => a.some((x) => x == null) ? null : String(a[0]).split(String(a[1])).join(String(a[2])),
    REVERSE: (a) => a[0] == null ? null : String(a[0]).split('').reverse().join(''), REPEAT: (a) => a[0] == null ? null : String(a[0]).repeat(Math.max(0, Math.min(1e5, toNum(a[1])))),
    LOCATE: (a) => (a[0] == null || a[1] == null) ? null : String(a[1]).toLowerCase().indexOf(String(a[0]).toLowerCase()) + 1,
    INSTR: (a) => (a[0] == null || a[1] == null) ? null : String(a[0]).toLowerCase().indexOf(String(a[1]).toLowerCase()) + 1,
    LPAD: (a) => a[0] == null ? null : String(a[0]).padStart(toNum(a[1]), a[2] == null ? ' ' : String(a[2])).slice(-Math.max(toNum(a[1]), 0) || undefined),
    GREATEST: (a) => a.some((x) => x == null) ? null : a.reduce((m, x) => cmpVals(x, m) > 0 ? x : m),
    LEAST: (a) => a.some((x) => x == null) ? null : a.reduce((m, x) => cmpVals(x, m) < 0 ? x : m),
    UUID: () => crypto.randomUUID(), MD5: (a) => a[0] == null ? null : crypto.createHash('md5').update(String(a[0])).digest('hex'),
    SHA1: (a) => a[0] == null ? null : crypto.createHash('sha1').update(String(a[0])).digest('hex'), SHA2: (a) => a[0] == null ? null : crypto.createHash('sha256').update(String(a[0])).digest('hex'),
    JSON_VALID: (a) => { try { JSON.parse(String(a[0])); return 1; } catch (e) { return 0; } },
    JSON_EXTRACT: (a) => { if (a[0] == null || a[1] == null) return null; try { let o = JSON.parse(String(a[0])); for (const p of String(a[1]).replace(/^\$\.?/, '').split(/\.|\[(\d+)\]/).filter(Boolean)) { if (o == null) return null; o = o[p]; } if (o == null) return null; return typeof o === 'object' ? JSON.stringify(o) : o; } catch (e) { return null; } },
    VERSION: () => '8.0.36-DBEngine', DATABASE: () => CURRENT_DB, ROW_COUNT: () => 0, LAST_INSERT_ID: () => 0,
    SIGN: (a) => a[0] == null ? null : Math.sign(toNum(a[0])), ISNULL: (a) => a[0] == null ? 1 : 0,
};

/* ------------------------------------------------------------------ Table */
class Table {
    constructor(name, cols) {
        this.name = name; this.cols = cols; this.rows = new Map(); this.nextRid = 1; this.auto = 1; this.indexes = [];
        this.meta();
    }
    meta() { this.colMap = new Map(this.cols.map((c) => [c.name.toLowerCase(), c])); }
    colKey(c, v) { return c.kind === 'int' || c.kind === 'float' || c.kind === 'bool' ? 'n' + v : 's' + String(v).toLowerCase(); }
    keyOf(idx, row) {
        let k = '';
        for (let i = 0; i < idx.cols.length; i++) {
            const v = row[idx.cols[i]];
            if (v === null || v === undefined) { if (idx.unique) return null; k += (i ? '\u0001' : '') + '~'; continue; }
            k += (i ? '\u0001' : '') + this.colKey(this.colMap.get(idx.cols[i].toLowerCase()), v);
        }
        return k;
    }
    idxAdd(rid, row) {
        for (const ix of this.indexes) {
            const k = this.keyOf(ix, row);
            if (k === null) continue;
            if (ix.unique) ix.map.set(k, rid);
            else { let s = ix.map.get(k); if (!s) { s = new Set(); ix.map.set(k, s); } s.add(rid); }
        }
    }
    idxDel(rid, row) {
        for (const ix of this.indexes) {
            const k = this.keyOf(ix, row);
            if (k === null) continue;
            if (ix.unique) { if (ix.map.get(k) === rid) ix.map.delete(k); }
            else { const s = ix.map.get(k); if (s) { s.delete(rid); if (!s.size) ix.map.delete(k); } }
        }
    }
    conflict(row, exceptRid) {
        for (const ix of this.indexes) {
            if (!ix.unique) continue;
            const k = this.keyOf(ix, row);
            if (k === null) continue;
            const r = ix.map.get(k);
            if (r !== undefined && r !== exceptRid) return { ix, rid: r, key: k };
        }
        return null;
    }
    dupMsg(row, ix) {
        return `Duplicate entry '${ix.cols.map((c) => row[c]).join('-')}' for key '${this.name}.${ix.name}'`;
    }
    rebuildIndexes() {
        for (const ix of this.indexes) ix.map = new Map();
        for (const [rid, row] of this.rows) {
            for (const ix of this.indexes) {
                const k = this.keyOf(ix, row);
                if (k === null) continue;
                if (ix.unique) { if (ix.map.has(k)) fail(`Duplicate entry '${ix.cols.map((c) => row[c]).join('-')}' for key '${ix.name}'`); ix.map.set(k, rid); }
                else { let s = ix.map.get(k); if (!s) { s = new Set(); ix.map.set(k, s); } s.add(rid); }
            }
        }
    }
    addIndex(def) {
        const cols = def.cols.map((n) => { const c = this.colMap.get(String(n).toLowerCase()); if (!c) fail(`Key column '${n}' doesn't exist in table`); return c.name; });
        let name = def.pk ? 'PRIMARY' : (def.name || cols.join('_'));
        if (this.indexes.some((i) => i.name.toLowerCase() === name.toLowerCase())) {
            if (def.name) fail(`Duplicate key name '${name}'`);
            let k = 2; while (this.indexes.some((i) => i.name.toLowerCase() === (name + '_' + k).toLowerCase())) k++; name = name + '_' + k;
        }
        if (def.pk && this.indexes.some((i) => i.pk)) fail('Multiple primary key defined');
        const ix = { name, cols, unique: !!def.unique, pk: !!def.pk, map: new Map() };
        if (def.pk) for (const cn of cols) this.colMap.get(cn.toLowerCase()).notnull = true;
        this.indexes.push(ix);
        try { this.rebuildIndexes(); } catch (e) { this.indexes.pop(); throw e; }
        return ix;
    }
    toJSON() {
        return {
            v: 1, name: this.name, auto: this.auto,
            cols: this.cols.map((c) => ({ name: c.name, type: c.type, notnull: c.notnull, def: c.def, auto: c.auto, onUpdateNow: c.onUpdateNow || undefined })),
            indexes: this.indexes.map((i) => ({ name: i.name, cols: i.cols, unique: i.unique, pk: i.pk })),
            rows: Array.from(this.rows.values()),
        };
    }
    static fromJSON(o) {
        const cols = o.cols.map((c) => ({ name: c.name, type: c.type, kind: kindOf(c.type), notnull: !!c.notnull, def: c.def, auto: !!c.auto, onUpdateNow: !!c.onUpdateNow }));
        const t = new Table(o.name, cols);
        t.auto = o.auto || 1;
        for (const r of o.rows || []) t.rows.set(t.nextRid++, r);
        for (const i of o.indexes || []) t.indexes.push({ name: i.name, cols: i.cols, unique: !!i.unique, pk: !!i.pk, map: new Map() });
        try { t.rebuildIndexes(); } catch (e) { t.loadWarning = e.message; t.indexes = t.indexes.filter((i) => !i.unique); t.rebuildIndexes(); }
        const ac = cols.find((c) => c.auto);
        if (ac) { for (const r of t.rows.values()) if (typeof r[ac.name] === 'number' && r[ac.name] >= t.auto) t.auto = r[ac.name] + 1; }
        return t;
    }
    createSQL() {
        const lines = this.cols.map((c) => {
            let s = `  ${qid(c.name)} ${c.type}`;
            if (c.notnull) s += ' NOT NULL';
            if (c.auto) s += ' AUTO_INCREMENT';
            if (c.def !== undefined) s += c.def.now ? ' DEFAULT CURRENT_TIMESTAMP' : (c.def.expr ? '' : ' DEFAULT ' + sqlLit(c.def.v));
            if (c.onUpdateNow) s += ' ON UPDATE CURRENT_TIMESTAMP';
            return s;
        });
        for (const ix of this.indexes) {
            const cl = ix.cols.map(qid).join(', ');
            lines.push(ix.pk ? `  PRIMARY KEY (${cl})` : ix.unique ? `  UNIQUE KEY ${qid(ix.name)} (${cl})` : `  KEY ${qid(ix.name)} (${cl})`);
        }
        return `CREATE TABLE ${qid(this.name)} (\n${lines.join(',\n')}\n)${this.auto > 1 ? ` AUTO_INCREMENT=${this.auto}` : ''};`;
    }
}
function colFromDef(d) {
    return { name: d.name, type: d.type, kind: kindOf(d.type), notnull: !!d.notnull, def: d.def, auto: !!d.auto, onUpdateNow: !!d.onUpdateNow };
}

/* ------------------------------------------------------------------ Engine */
class DBEngine {
    constructor(dir, opts = {}) {
        this.dir = dir; this.tdir = path.join(dir, 'tables'); this.bdir = path.join(dir, 'backups');
        this.log = opts.log || (() => {});
        this.tables = new Map(); this.dirty = new Set(); this.dropped = new Set(); this.undo = null; this.txSnap = null;
        this.timer = null; this.lastFlushMs = 0; this.history = [];
        this.stats = { queries: 0, errors: 0, totalMs: 0, started: Date.now(), writes: 0, lastFlush: 0 };
        this.settings = null; this.fresh = false;
    }

    /* ---------- persistence ---------- */
    load() {
        fs.mkdirSync(this.tdir, { recursive: true }); fs.mkdirSync(this.bdir, { recursive: true });
        let meta = null;
        try { meta = JSON.parse(fs.readFileSync(path.join(this.dir, 'meta.json'), 'utf8')); } catch (e) { /* first run */ }
        this.fresh = !meta;
        this.settings = Object.assign(this.defaults(), meta && meta.settings || {});
        CURRENT_DB = this.settings.dbName;
        for (const f of fs.readdirSync(this.tdir)) {
            if (!f.endsWith('.json')) continue;
            try {
                const t = Table.fromJSON(JSON.parse(fs.readFileSync(path.join(this.tdir, f), 'utf8')));
                this.tables.set(t.name.toLowerCase(), t);
                if (t.loadWarning) this.log('warn', `Table ${t.name}: ${t.loadWarning} (unique indexes were dropped)`);
            } catch (e) { this.log('error', `Failed to load table file ${f}: ${e.message}`); }
        }
        if (this.fresh) this.saveMeta();
        return this;
    }
    defaults() {
        return {
            dbName: 'dbengine', host: '127.0.0.1', port: 3306, user: 'dbadmin',
            password: crypto.randomBytes(12).toString('base64').replace(/[+/=]/g, 'x'),
            autoBackupMin: 0, keepBackups: 10, cfgInitDone: false, cfgVar: 'mysql_connection_string', createdAt: Date.now(),
        };
    }
    saveMeta() {
        this.atomic(path.join(this.dir, 'meta.json'), JSON.stringify({ v: 1, settings: this.settings }, null, 2));
    }
    atomic(file, data) {
        const tmp = file + '.tmp';
        fs.writeFileSync(tmp, data);
        fs.renameSync(tmp, file);
    }
    tfile(name) { return path.join(this.tdir, encodeURIComponent(name.toLowerCase()) + '.json'); }
    markDirty(t) { this.dirty.add(t.name.toLowerCase()); this.stats.writes++; this.schedule(); }
    schedule() {
        if (this.timer) return;
        const delay = Math.min(5000, Math.max(250, this.lastFlushMs * 8));
        this.timer = setTimeout(() => { this.timer = null; this.flush(); }, delay);
        if (this.timer.unref) this.timer.unref();
    }
    flush() {
        const t0 = Date.now();
        try {
            for (const n of this.dropped) { try { fs.unlinkSync(this.tfile(n)); } catch (e) { /* gone */ } }
            this.dropped.clear();
            for (const n of this.dirty) {
                const t = this.tables.get(n);
                if (t) this.atomic(this.tfile(t.name), JSON.stringify(t.toJSON()));
            }
            this.dirty.clear();
            this.stats.lastFlush = Date.now();
        } catch (e) { this.log('error', 'DBEngine flush failed: ' + e.message); this.schedule(); }
        this.lastFlushMs = Date.now() - t0;
    }
    shutdown() { if (this.timer) { clearTimeout(this.timer); this.timer = null; } this.flush(); }

    /* ---------- schema helpers ---------- */
    tbl(name) {
        const t = this.tables.get(String(name).toLowerCase());
        if (!t) fail(`Table '${name}' doesn't exist`);
        return t;
    }
    realCol(t, name) {
        const c = t.colMap.get(String(name).toLowerCase());
        if (!c) fail(`Unknown column '${name}' in '${t.name}'`);
        return c;
    }
    snapshot() { return Array.from(this.tables.values()).map((t) => JSON.parse(JSON.stringify(t.toJSON()))); }
    restore(snap) {
        for (const t of this.tables.values()) this.dropped.add(t.name);
        this.tables = new Map();
        for (const o of snap) { const t = Table.fromJSON(o); this.tables.set(t.name.toLowerCase(), t); this.dropped.delete(t.name); this.markDirty(t); }
        this.schedule();
    }

    /* ---------- low level row ops (with undo) ---------- */
    _ins(t, rid, row) {
        t.rows.set(rid, row); t.idxAdd(rid, row); this.markDirty(t);
        if (this.undo) this.undo.push(() => { t.idxDel(rid, row); t.rows.delete(rid); });
    }
    _del(t, rid) {
        const row = t.rows.get(rid);
        t.idxDel(rid, row); t.rows.delete(rid); this.markDirty(t);
        if (this.undo) this.undo.push(() => { t.rows.set(rid, row); t.idxAdd(rid, row); });
    }
    _upd(t, rid, nrow) {
        const old = t.rows.get(rid);
        t.idxDel(rid, old); t.rows.set(rid, nrow); t.idxAdd(rid, nrow); this.markDirty(t);
        if (this.undo) this.undo.push(() => { t.idxDel(rid, nrow); t.rows.set(rid, old); t.idxAdd(rid, old); });
    }

    /* ---------- expression compiler ---------- */
    resolveCol(scope, tbl, c) {
        const lc = c.toLowerCase(), lt = tbl ? tbl.toLowerCase() : null;
        let found = null;
        for (let i = 0; i < scope.sources.length; i++) {
            const s = scope.sources[i];
            if (lt && s.alias.toLowerCase() !== lt && s.t.name.toLowerCase() !== lt) continue;
            const col = s.t.colMap.get(lc);
            if (col) { if (found && !lt) fail(`Column '${c}' is ambiguous`); found = { i, name: col.name }; if (lt) break; }
        }
        if (!found) {
            if (!tbl && scope.aliases && scope.aliases.has(lc)) return { alias: scope.aliases.get(lc) };
            fail(`Unknown column '${tbl ? tbl + '.' : ''}${c}'`);
        }
        return found;
    }
    comp(n, scope) {
        const self = this;
        switch (n.n) {
            case 'lit': { const v = n.v; return () => v; }
            case 'default': return () => DEFAULT;
            case 'col': {
                const r = this.resolveCol(scope, n.t, n.c);
                if (r.alias) return r.alias;
                const i = r.i, name = r.name;
                return (env) => { const row = env[i]; if (!row) return null; const v = row[name]; return v === undefined ? null : v; };
            }
            case 'un': {
                const e = this.comp(n.e, scope);
                if (n.op === 'NOT') return (env) => { const v = e(env); return v === null ? null : (truthy(v) ? 0 : 1); };
                return (env) => { const v = e(env); return v === null ? null : -toNum(v); };
            }
            case 'bin': return this.compBin(n, scope);
            case 'isnull': { const e = this.comp(n.e, scope); const neg = n.not; return (env) => { const v = e(env); return ((v === null || v === undefined) !== neg) ? 1 : 0; }; }
            case 'in': {
                const e = this.comp(n.e, scope), neg = n.not;
                if (n.list.every((x) => x.n === 'lit') && n.list.length > 6) {
                    const set = new Set(n.list.map((x) => nkey(x.v)));
                    const hasNull = n.list.some((x) => x.v === null);
                    return (env) => { const v = e(env); if (v === null) return null; if (set.has(nkey(v))) return neg ? 0 : 1; return hasNull ? null : (neg ? 1 : 0); };
                }
                const list = n.list.map((x) => this.comp(x, scope));
                return (env) => {
                    const v = e(env); if (v === null) return null;
                    let nul = false;
                    for (const f of list) { const x = f(env); if (x === null) { nul = true; continue; } if (cmpVals(v, x) === 0) return neg ? 0 : 1; }
                    return nul ? null : (neg ? 1 : 0);
                };
            }
            case 'insub': {
                const e = this.comp(n.e, scope), neg = n.not; let cache = null;
                return (env) => {
                    if (!cache) { const r = self.runSelect(n.sel); cache = { set: new Set(r.rows.map((x) => nkey(x[0]))), nul: r.rows.some((x) => x[0] === null) }; }
                    const v = e(env); if (v === null) return null;
                    if (cache.set.has(nkey(v))) return neg ? 0 : 1;
                    return cache.nul ? null : (neg ? 1 : 0);
                };
            }
            case 'sub': { let cache; return () => { if (cache === undefined) { const r = self.runSelect(n.sel); cache = r.rows.length ? r.rows[0][0] : null; } return cache; }; }
            case 'exists': { let cache; return () => { if (cache === undefined) { const r = self.runSelect({ ...n.sel, limit: 1 }); cache = r.rows.length > 0; } return (cache !== !!n.not) ? 1 : 0; }; }
            case 'like': {
                const e = this.comp(n.e, scope), neg = n.not;
                if (n.p.n === 'lit' && n.p.v !== null) { const re = likeRe(String(n.p.v)); return (env) => { const v = e(env); if (v === null) return null; return re.test(String(v)) !== neg ? 1 : 0; }; }
                const p = this.comp(n.p, scope);
                return (env) => { const v = e(env), pv = p(env); if (v === null || pv === null) return null; return likeRe(String(pv)).test(String(v)) !== neg ? 1 : 0; };
            }
            case 'regexp': {
                const e = this.comp(n.e, scope), p = this.comp(n.p, scope), neg = n.not;
                return (env) => { const v = e(env), pv = p(env); if (v === null || pv === null) return null; let re; try { re = new RegExp(String(pv), 'i'); } catch (x) { fail('Invalid regular expression'); } return re.test(String(v)) !== neg ? 1 : 0; };
            }
            case 'between': {
                const e = this.comp(n.e, scope), lo = this.comp(n.lo, scope), hi = this.comp(n.hi, scope), neg = n.not;
                return (env) => { const v = e(env), a = lo(env), b = hi(env); if (v === null || a === null || b === null) return null; return ((cmpVals(v, a) >= 0 && cmpVals(v, b) <= 0) !== neg) ? 1 : 0; };
            }
            case 'case': {
                const base = n.base ? this.comp(n.base, scope) : null;
                const whens = n.whens.map((w) => ({ c: this.comp(w.c, scope), r: this.comp(w.r, scope) }));
                const els = n.els ? this.comp(n.els, scope) : null;
                return (env) => {
                    const b = base ? base(env) : null;
                    for (const w of whens) { const c = w.c(env); if (base ? (b !== null && c !== null && cmpVals(b, c) === 0) : truthy(c)) return w.r(env); }
                    return els ? els(env) : null;
                };
            }
            case 'cast': {
                const e = this.comp(n.e, scope); const k = kindOf(n.ty); const col = { name: 'cast', kind: k };
                return (env) => { const v = e(env); if (v === null) return null; try { return coerce(col, k === 'int' || k === 'float' ? toNum(v) : v); } catch (x) { return null; } };
            }
            case 'fn': {
                if (AGG.has(n.name)) return (env) => { if (!env.agg) fail('Invalid use of group function'); return env.agg.get(n); };
                if (n.name === 'VALUES') {
                    const cn = n.args[0].n === 'col' ? n.args[0].c : null;
                    return (env) => env.newRow ? env.newRow[this.realColName(scope, cn)] : null;
                }
                const f = FN[n.name];
                if (!f) fail(`Unknown function ${n.name}()`);
                const args = n.args.map((a) => this.comp(a, scope));
                if (args.length === 0) return () => f([]);
                if (args.length === 1) { const a0 = args[0]; return (env) => f([a0(env)]); }
                return (env) => f(args.map((a) => a(env)));
            }
            default: fail('Unsupported expression: ' + n.n);
        }
    }
    realColName(scope, cn) { for (const s of scope.sources) { const c = s.t.colMap.get(String(cn).toLowerCase()); if (c) return c.name; } return cn; }
    compBin(n, scope) {
        const l = this.comp(n.l, scope), r = this.comp(n.r, scope), op = n.op;
        switch (op) {
            case 'AND': return (env) => { const a = l(env); if (a !== null && !truthy(a)) return 0; const b = r(env); if (b !== null && !truthy(b)) return 0; return (a === null || b === null) ? null : 1; };
            case 'OR': return (env) => { const a = l(env); if (a !== null && truthy(a)) return 1; const b = r(env); if (b !== null && truthy(b)) return 1; return (a === null || b === null) ? null : 0; };
            case '=': return (env) => { const a = l(env), b = r(env); return (a === null || b === null) ? null : (cmpVals(a, b) === 0 ? 1 : 0); };
            case '!=': return (env) => { const a = l(env), b = r(env); return (a === null || b === null) ? null : (cmpVals(a, b) !== 0 ? 1 : 0); };
            case '<': return (env) => { const a = l(env), b = r(env); return (a === null || b === null) ? null : (cmpVals(a, b) < 0 ? 1 : 0); };
            case '>': return (env) => { const a = l(env), b = r(env); return (a === null || b === null) ? null : (cmpVals(a, b) > 0 ? 1 : 0); };
            case '<=': return (env) => { const a = l(env), b = r(env); return (a === null || b === null) ? null : (cmpVals(a, b) <= 0 ? 1 : 0); };
            case '>=': return (env) => { const a = l(env), b = r(env); return (a === null || b === null) ? null : (cmpVals(a, b) >= 0 ? 1 : 0); };
            case '+': return (env) => { const a = l(env), b = r(env); return (a === null || b === null) ? null : toNum(a) + toNum(b); };
            case '-': return (env) => { const a = l(env), b = r(env); return (a === null || b === null) ? null : toNum(a) - toNum(b); };
            case '*': return (env) => { const a = l(env), b = r(env); return (a === null || b === null) ? null : toNum(a) * toNum(b); };
            case '/': return (env) => { const a = l(env), b = r(env); if (a === null || b === null) return null; const d = toNum(b); return d === 0 ? null : toNum(a) / d; };
            case 'DIV': return (env) => { const a = l(env), b = r(env); if (a === null || b === null) return null; const d = toNum(b); return d === 0 ? null : Math.trunc(toNum(a) / d); };
            case '%': return (env) => { const a = l(env), b = r(env); if (a === null || b === null) return null; const d = toNum(b); return d === 0 ? null : toNum(a) % d; };
            default: fail('Unsupported operator ' + op);
        }
    }

    /* ---------- index-assisted row picking ---------- */
    pick(t, where, alias) {
        if (!where || t.indexes.length === 0) return null;
        const conj = flatAnd(where, []);
        const eq = new Map(), ins = new Map();
        const mine = (c) => c.n === 'col' && (!c.t || c.t.toLowerCase() === alias.toLowerCase() || c.t.toLowerCase() === t.name.toLowerCase());
        for (const c of conj) {
            if (c.n === 'bin' && c.op === '=') {
                let a = c.l, b = c.r; if (b.n === 'col' && a.n === 'lit') [a, b] = [b, a];
                if (mine(a) && b.n === 'lit' && b.v !== null) { const col = t.colMap.get(a.c.toLowerCase()); if (col) eq.set(col.name, b.v); }
            } else if (c.n === 'in' && !c.not && mine(c.e) && c.list.every((x) => x.n === 'lit' && x.v !== null)) {
                const col = t.colMap.get(c.e.c.toLowerCase()); if (col) ins.set(col.name, c.list.map((x) => x.v));
            }
        }
        if (!eq.size && !ins.size) return null;
        const keyFor = (col, v) => {
            if (col.kind === 'int' || col.kind === 'float' || col.kind === 'bool') { if (typeof v === 'string' && !NUMSTR.test(v)) return undefined; return 'n' + toNum(v); }
            return 's' + String(v).toLowerCase();
        };
        const order = [...t.indexes].sort((a, b) => (b.unique - a.unique) || (b.cols.length - a.cols.length));
        for (const ix of order) {
            if (ix.cols.every((cn) => eq.has(cn))) {
                const parts = ix.cols.map((cn) => keyFor(t.colMap.get(cn.toLowerCase()), eq.get(cn)));
                if (parts.includes(undefined)) continue;
                const k = parts.join('\u0001'); const hit = ix.map.get(k);
                this._plan = { key: ix.name, type: ix.unique ? 'const' : 'ref' };
                if (hit === undefined) return [];
                return ix.unique ? [hit] : Array.from(hit);
            }
            if (ix.cols.length === 1 && ins.has(ix.cols[0])) {
                const col = t.colMap.get(ix.cols[0].toLowerCase()); const out = new Set();
                for (const v of ins.get(ix.cols[0])) { const k = keyFor(col, v); if (k === undefined) continue; const hit = ix.map.get(k); if (hit === undefined) continue; if (ix.unique) out.add(hit); else for (const r of hit) out.add(r); }
                this._plan = { key: ix.name, type: 'range' };
                return Array.from(out);
            }
        }
        return null;
    }/* ---------- statement runner ---------- */
    exec(sql, params, opts = {}) {
        params = params || [];
        const out = []; let n = 0, poff = 0;
        for (const st of statements(String(sql))) {
            n++;
            const t0 = process.hrtime.bigint();
            const label = st.src.slice(st.from, Math.min(st.to, st.from + 160));
            let res;
            try {
                res = this.runStatement(st, params.slice(poff), opts);
                poff += res._pi || 0; delete res._pi;
                this.stats.queries++;
            } catch (e) {
                this.stats.errors++;
                if (!(e instanceof SQLError)) throw e;
                const ms = Number(process.hrtime.bigint() - t0) / 1e6;
                this.pushHistory(label, ms, false, e.message);
                if (opts.continueOnError) { out.push({ type: 'error', error: e.message, sql: label, index: n }); continue; }
                e.statementIndex = n; e.results = out; e.sql = label;
                throw e;
            }
            res.ms = Number(process.hrtime.bigint() - t0) / 1e6;
            res.sql = label; res.index = n;
            this.stats.totalMs += res.ms;
            if (!opts.silent) this.pushHistory(label, res.ms, true, res.type === 'rows' ? `${res.rows.length} rows` : `${res.affected || 0} affected`);
            out.push(res);
        }
        return out;
    }
    pushHistory(sql, ms, ok, info) {
        this.history.unshift({ ts: Date.now(), sql, ms: Math.round(ms * 100) / 100, ok, info });
        if (this.history.length > 200) this.history.length = 200;
    }
    runStatement(st, params, opts) {
        const p = new Parser(st, params);
        const ast = p.statement();
        const noUndo = opts.noUndo;
        this.undo = noUndo ? null : [];
        try {
            const res = this.dispatch(ast);
            res._pi = p.pi;
            this.undo = null;
            return res;
        } catch (e) {
            const u = this.undo; this.undo = null;
            if (u) for (let i = u.length - 1; i >= 0; i--) { try { u[i](); } catch (x) { /* best effort */ } }
            throw e;
        }
    }
    ok(affected, extra) { return Object.assign({ type: 'ok', affected: affected || 0, insertId: 0, message: '' }, extra); }
    dispatch(a) {
        switch (a.type) {
            case 'select': { const r = this.runSelect(a); return { type: 'rows', columns: r.columns, rows: r.rows }; }
            case 'insert': return this.doInsert(a);
            case 'update': return this.doUpdate(a);
            case 'delete': return this.doDelete(a);
            case 'create': return this.doCreate(a);
            case 'drop': {
                let c = 0;
                for (const nm of a.names) {
                    const t = this.tables.get(nm.toLowerCase());
                    if (!t) { if (a.ifExists) continue; fail(`Unknown table '${nm}'`); }
                    this.tables.delete(nm.toLowerCase()); this.dropped.add(t.name); this.dirty.delete(t.name.toLowerCase()); c++;
                    if (this.undo) this.undo.push(() => { this.tables.set(t.name.toLowerCase(), t); this.dropped.delete(t.name); this.markDirty(t); });
                }
                this.schedule(); return this.ok(0, { message: `${c} table(s) dropped` });
            }
            case 'truncate': {
                const t = this.tbl(a.table); const n = t.rows.size;
                const old = t.rows; t.rows = new Map(); t.auto = 1; for (const ix of t.indexes) ix.map = new Map(); this.markDirty(t);
                if (this.undo) this.undo.push(() => { t.rows = old; t.rebuildIndexes(); });
                return this.ok(0, { message: `Table truncated (${n} rows removed)` });
            }
            case 'rename': this.renameTable(a.from, a.to); return this.ok(0, { message: 'Table renamed' });
            case 'alter': return this.doAlter(a);
            case 'createindex': { const t = this.tbl(a.table); t.addIndex({ name: a.name, cols: a.cols, unique: a.unique }); this.markDirty(t); return this.ok(0, { message: 'Index created' }); }
            case 'dropindex': { const t = this.tbl(a.table); this.dropIndex(t, a.name); return this.ok(0, { message: 'Index dropped' }); }
            case 'show': return this.doShow(a);
            case 'explain': return this.doExplain(a.sel);
            case 'tx':
                if (a.op === 'BEGIN') { this.txSnap = this.snapshot(); return this.ok(0, { message: 'Transaction started' }); }
                if (a.op === 'COMMIT') { this.txSnap = null; return this.ok(0, { message: 'Committed' }); }
                if (this.txSnap) { this.restore(this.txSnap); this.txSnap = null; return this.ok(0, { message: 'Rolled back' }); }
                return this.ok(0, { message: 'No active transaction' });
            case 'noop': return this.ok(0, { message: 'OK (ignored: ' + a.what + ')' });
            default: fail('Unsupported statement');
        }
    }

    /* ---------- SELECT ---------- */
    sourceOf(ref) {
        if (ref.sub) {
            const r = this.runSelect(ref.sub);
            const seen = new Set();
            const cols = r.columns.map((c, i) => { let nm = String(c || 'col' + i); while (seen.has(nm.toLowerCase())) nm += '_'; seen.add(nm.toLowerCase()); return { name: nm, type: 'text', kind: 'text' }; });
            const t = new Table(ref.alias, cols);
            for (const row of r.rows) { const o = {}; cols.forEach((c, i) => { o[c.name] = row[i]; }); t.rows.set(t.nextRid++, o); }
            return { alias: ref.alias, t };
        }
        const vt = !this.tables.has(String(ref.table).toLowerCase()) && this.infoSchema(String(ref.table));
        if (vt) return { alias: ref.alias || ref.table, t: vt };
        const t = this.tbl(ref.table);
        return { alias: ref.alias || t.name, t };
    }
    /* minimal INFORMATION_SCHEMA (tables / columns / statistics / schemata) so migration scripts that probe the schema work */
    infoSchema(name) {
        const n = name.toLowerCase();
        const db = this.settings.dbName;
        const mk = (cols, rows) => {
            const t = new Table(name, cols.map((c) => ({ name: c, type: 'text', kind: 'text' })));
            for (const r of rows) { const o = {}; cols.forEach((c, i) => { o[c] = r[i]; }); t.rows.set(t.nextRid++, o); }
            return t;
        };
        const T = Array.from(this.tables.values());
        if (n === 'tables') return mk(['TABLE_CATALOG', 'TABLE_SCHEMA', 'TABLE_NAME', 'TABLE_TYPE', 'ENGINE', 'ROW_FORMAT', 'TABLE_ROWS', 'AUTO_INCREMENT', 'DATA_LENGTH', 'INDEX_LENGTH', 'TABLE_COLLATION', 'TABLE_COMMENT'],
            T.map((t) => ['def', db, t.name, 'BASE TABLE', 'InnoDB', 'Dynamic', t.rows.size, t.auto, 0, 0, 'utf8mb4_general_ci', '']));
        if (n === 'schemata') return mk(['CATALOG_NAME', 'SCHEMA_NAME', 'DEFAULT_CHARACTER_SET_NAME', 'DEFAULT_COLLATION_NAME'], [['def', db, 'utf8mb4', 'utf8mb4_general_ci']]);
        if (n === 'columns') {
            const rows = [];
            for (const t of T) t.cols.forEach((c, i) => {
                const ix = t.indexes.find((x) => x.cols[0] === c.name);
                const base = String(c.type || 'text').toLowerCase().replace(/\(.*$/, '').trim();
                const len = /\((\d+)/.exec(String(c.type || ''));
                rows.push(['def', db, t.name, c.name, i + 1, c.def === undefined || c.def === null || c.def.v === undefined ? null : String(c.def.now ? 'CURRENT_TIMESTAMP' : c.def.v), c.notnull ? 'NO' : 'YES', base, len ? Number(len[1]) : null, String(c.type || 'text').toLowerCase(), ix ? (ix.pk ? 'PRI' : ix.unique ? 'UNI' : 'MUL') : '', c.auto ? 'auto_increment' : '']);
            });
            return mk(['TABLE_CATALOG', 'TABLE_SCHEMA', 'TABLE_NAME', 'COLUMN_NAME', 'ORDINAL_POSITION', 'COLUMN_DEFAULT', 'IS_NULLABLE', 'DATA_TYPE', 'CHARACTER_MAXIMUM_LENGTH', 'COLUMN_TYPE', 'COLUMN_KEY', 'EXTRA'], rows);
        }
        if (n === 'statistics') {
            const rows = [];
            for (const t of T) for (const ix of t.indexes) ix.cols.forEach((c, i) => rows.push(['def', db, t.name, ix.unique ? 0 : 1, db, ix.name, i + 1, c]));
            return mk(['TABLE_CATALOG', 'TABLE_SCHEMA', 'TABLE_NAME', 'NON_UNIQUE', 'INDEX_SCHEMA', 'INDEX_NAME', 'SEQ_IN_INDEX', 'COLUMN_NAME'], rows);
        }
        return null;
    }
    runSelect(s) {
        if (s.union) {
            const a = this.runSelect({ ...s, union: null }), b = this.runSelect(s.union.sel);
            if (a.columns.length !== b.columns.length) fail('The used SELECT statements have a different number of columns');
            let rows = a.rows.concat(b.rows);
            if (!s.union.all) { const seen = new Set(); rows = rows.filter((r) => { const k = JSON.stringify(r.map(nkey)); if (seen.has(k)) return false; seen.add(k); return true; }); }
            return { columns: a.columns, rows };
        }
        const sources = [];
        if (s.from) sources.push(this.sourceOf(s.from));
        for (const j of s.joins) { const src = this.sourceOf(j); src.join = j; sources.push(src); }
        const scope = { sources, aliases: null };

        /* fast path: SELECT COUNT(*) FROM t */
        if (sources.length === 1 && !s.where && !s.group.length && !s.having && !s.distinct && s.cols.length === 1 && s.cols[0].e && s.cols[0].e.n === 'fn' && s.cols[0].e.name === 'COUNT' && s.cols[0].e.star && !s.order.length) {
            const nm = s.cols[0].alias || s.cols[0].label;
            const rows = [[sources[0].t.rows.size]];
            return { columns: [nm], rows: s.offset ? [] : (s.limit === 0 ? [] : rows) };
        }

        /* select list */
        const items = [];
        for (const c of s.cols) {
            if (c.star) {
                let any = false;
                sources.forEach((src, i) => {
                    if (c.tbl && src.alias.toLowerCase() !== c.tbl.toLowerCase() && src.t.name.toLowerCase() !== c.tbl.toLowerCase()) return;
                    any = true;
                    for (const col of src.t.cols) { const nm = col.name; items.push({ name: nm, fn: (env) => { const r = env[i]; return r ? (r[nm] === undefined ? null : r[nm]) : null; } }); }
                });
                if (!any) fail(c.tbl ? `Unknown table '${c.tbl}'` : 'No tables used');
            } else {
                items.push({ name: c.alias || (c.e.n === 'col' ? c.e.c : c.label), fn: this.comp(c.e, scope), node: c.e });
            }
        }
        scope.aliases = new Map();
        for (const it of items) if (it.name) scope.aliases.set(String(it.name).toLowerCase(), it.fn);

        /* USING -> ON */
        sources.forEach((src, i) => {
            if (i > 0 && src.join && src.join.on && src.join.on.n === 'using') {
                let on = null;
                for (const cn of src.join.on.cols) {
                    let left = null; for (let k = 0; k < i; k++) if (sources[k].t.colMap.has(cn.toLowerCase())) { left = sources[k].alias; break; }
                    if (!left) fail(`Unknown column '${cn}' in USING`);
                    const eq = { n: 'bin', op: '=', l: { n: 'col', t: left, c: cn }, r: { n: 'col', t: src.alias, c: cn } };
                    on = on ? { n: 'bin', op: 'AND', l: on, r: eq } : eq;
                }
                src.join.on = on;
            }
        });

        const aggNodes = [];
        const collect = (node) => walk(node, (x) => { if (x.n === 'fn' && AGG.has(x.name) && !aggNodes.includes(x)) aggNodes.push(x); });
        for (const it of items) if (it.node) collect(it.node);
        if (s.having) collect(s.having);
        for (const o of s.order) collect(o.e);
        const grouped = aggNodes.length > 0 || s.group.length > 0;

        const where = s.where ? this.comp(s.where, scope) : null;
        const hasLimit = s.limit !== null && s.limit !== undefined;
        const early = (!grouped && !s.order.length && !s.distinct && hasLimit && sources.length <= 1) ? (s.offset + s.limit) : Infinity;

        /* gather rows */
        let envs = [];
        if (sources.length === 0) envs = [[]];
        else {
            const t0 = sources[0].t;
            const rids = sources.length === 1 ? this.pick(t0, s.where, sources[0].alias) : null;
            const iter = rids ? rids.map((r) => t0.rows.get(r)).filter(Boolean) : t0.rows.values();
            if (sources.length === 1) {
                for (const row of iter) {
                    const env = [row];
                    if (where && !truthy(where(env))) continue;
                    envs.push(env);
                    if (envs.length >= early) break;
                }
            } else {
                for (const row of iter) envs.push([row]);
                for (let i = 1; i < sources.length; i++) envs = this.joinStep(envs, sources, i, scope);
                if (where) envs = envs.filter((e) => truthy(where(e)));
            }
        }

        /* group / aggregate */
        let recs;
        if (grouped) {
            const gfns = s.group.map((g) => {
                if (g.n === 'lit' && typeof g.v === 'number') { const it = items[g.v - 1]; if (!it) fail(`Unknown column '${g.v}' in 'group clause'`); return it.fn; }
                return this.comp(g, scope);
            });
            const aggs = aggNodes.map((node) => ({ node, name: node.name, arg: node.star ? null : this.comp(node.args[0], scope), distinct: node.distinct, sep: node.sep === undefined ? ',' : node.sep }));
            const groups = new Map();
            for (const env of envs) {
                let key = '';
                if (gfns.length) key = JSON.stringify(gfns.map((f) => nkey(f(env))));
                let g = groups.get(key);
                if (!g) { g = { env, st: aggs.map((a) => ({ cnt: 0, sum: 0, min: undefined, max: undefined, set: a.distinct ? new Set() : null, list: a.name === 'GROUP_CONCAT' ? [] : null })) }; groups.set(key, g); }
                for (let i = 0; i < aggs.length; i++) {
                    const a = aggs[i], st = g.st[i];
                    if (!a.arg) { st.cnt++; continue; }
                    const v = a.arg(env);
                    if (v === null || v === undefined) continue;
                    if (a.distinct) { const k = nkey(v); if (st.set.has(k)) continue; st.set.add(k); }
                    st.cnt++;
                    if (a.name === 'SUM' || a.name === 'AVG') st.sum += toNum(v);
                    else if (a.name === 'MIN') { if (st.min === undefined || cmpVals(v, st.min) < 0) st.min = v; }
                    else if (a.name === 'MAX') { if (st.max === undefined || cmpVals(v, st.max) > 0) st.max = v; }
                    else if (a.name === 'GROUP_CONCAT') st.list.push(String(v));
                }
            }
            if (!groups.size && !gfns.length) groups.set('', { env: sources.map(() => null), st: aggs.map(() => ({ cnt: 0, sum: 0, min: undefined, max: undefined, set: null, list: [] })) });
            const having = s.having ? this.comp(s.having, scope) : null;
            recs = [];
            for (const g of groups.values()) {
                const env = g.env.slice(); env.agg = new Map();
                aggs.forEach((a, i) => {
                    const st = g.st[i]; let v;
                    switch (a.name) {
                        case 'COUNT': v = st.cnt; break;
                        case 'SUM': v = st.cnt ? st.sum : null; break;
                        case 'AVG': v = st.cnt ? st.sum / st.cnt : null; break;
                        case 'MIN': v = st.min === undefined ? null : st.min; break;
                        case 'MAX': v = st.max === undefined ? null : st.max; break;
                        default: v = st.cnt ? st.list.join(a.sep) : null;
                    }
                    env.agg.set(a.node, v);
                });
                if (having && !truthy(having(env))) continue;
                recs.push({ env, out: items.map((it) => it.fn(env)) });
            }
        } else {
            if (s.having) fail('HAVING requires GROUP BY or aggregates');
            recs = envs.map((env) => ({ env, out: items.map((it) => it.fn(env)) }));
        }

        if (s.distinct) {
            const seen = new Set();
            recs = recs.filter((r) => { const k = JSON.stringify(r.out.map(nkey)); if (seen.has(k)) return false; seen.add(k); return true; });
        }
        if (s.order.length) {
            const ofns = s.order.map((o) => {
                if (o.e.n === 'lit' && typeof o.e.v === 'number') { const idx = o.e.v - 1; if (idx < 0 || idx >= items.length) fail(`Unknown column '${o.e.v}' in 'order clause'`); return (r) => r.out[idx]; }
                const f = this.comp(o.e, scope); return (r) => f(r.env);
            });
            const keyed = recs.map((r) => ({ r, k: ofns.map((f) => f(r)) }));
            keyed.sort((a, b) => { for (let i = 0; i < ofns.length; i++) { const c = sortCmp(a.k[i], b.k[i]); if (c) return c * s.order[i].dir; } return 0; });
            recs = keyed.map((x) => x.r);
        }
        if (s.offset || hasLimit) recs = recs.slice(s.offset || 0, hasLimit ? (s.offset || 0) + s.limit : undefined);
        return { columns: items.map((i) => i.name), rows: recs.map((r) => r.out) };
    }
    joinStep(envs, sources, i, scope) {
        const src = sources[i], jn = src.join;
        const on = jn.on ? this.comp(jn.on, scope) : null;
        let hj = null;
        if (jn.on) {
            for (const c of flatAnd(jn.on, [])) {
                if (c.n === 'bin' && c.op === '=' && c.l.n === 'col' && c.r.n === 'col') {
                    const a = this.resolveCol(scope, c.l.t, c.l.c), b = this.resolveCol(scope, c.r.t, c.r.c);
                    if (a.alias || b.alias) continue;
                    if (a.i === i && b.i < i) { hj = { nc: a.name, oi: b.i, oc: b.name }; break; }
                    if (b.i === i && a.i < i) { hj = { nc: b.name, oi: a.i, oc: a.name }; break; }
                }
            }
        }
        let map = null; const all = Array.from(src.t.rows.values());
        if (hj) {
            map = new Map();
            for (const r of all) { const k = nkey(r[hj.nc]); if (k === null) continue; let l = map.get(k); if (!l) { l = []; map.set(k, l); } l.push(r); }
        }
        const out = [];
        for (const env of envs) {
            let cand = all;
            if (hj) { const orow = env[hj.oi]; const k = orow ? nkey(orow[hj.oc]) : null; cand = k === null ? [] : (map.get(k) || []); }
            let any = false;
            for (const r of cand) {
                const e2 = env.slice(); e2.push(r);
                if (!on || truthy(on(e2))) { out.push(e2); any = true; }
            }
            if (!any && jn.type === 'LEFT') { const e2 = env.slice(); e2.push(null); out.push(e2); }
        }
        return out;
    }
    doExplain(sel) {
        this._plan = null;
        const rows = [];
        if (sel.from && !sel.from.sub) {
            const t = this.tbl(sel.from.table);
            this.pick(t, sel.joins.length ? null : sel.where, sel.from.alias || t.name);
            const pl = this._plan;
            rows.push([1, 'SIMPLE', t.name, pl ? pl.type : 'ALL', pl ? pl.key : null, pl ? 'Using index' : 'Full table scan', t.rows.size]);
            for (const j of sel.joins) { const jt = this.tbl(j.table); rows.push([1, 'SIMPLE', jt.name, 'hash', null, 'Hash join', jt.rows.size]); }
        } else rows.push([1, 'SIMPLE', null, null, null, 'No tables used', null]);
        return { type: 'rows', columns: ['id', 'select_type', 'table', 'type', 'key', 'extra', 'rows'], rows };
    }

    /* ---------- INSERT ---------- */
    defaultOf(c) {
        if (c.def === undefined) return undefined;
        if (c.def.now) return fmtDate();
        if (c.def.expr) { try { return this.comp(c.def.expr, { sources: [] })([]); } catch (e) { return undefined; } }
        return c.def.v;
    }
    buildRow(t, provided) {
        const row = {}; let autoVal = 0;
        for (const c of t.cols) {
            let v = provided.get(c.name);
            if (v === undefined || v === DEFAULT) v = this.defaultOf(c);
            if (v !== undefined && v !== null) v = coerce(c, v);
            if (c.auto) {
                if (v === undefined || v === null || v === 0) { v = t.auto++; autoVal = v; }
                else if (typeof v === 'number' && v >= t.auto) t.auto = v + 1;
            }
            if (v === undefined) { v = c.notnull ? implicitDefault(c) : null; }
            if (v === null && c.notnull) fail(`Column '${c.name}' cannot be null`);
            row[c.name] = v;
        }
        return { row, autoVal };
    }
    doInsert(a) {
        const t = this.tbl(a.table);
        const colNames = a.cols ? a.cols.map((c) => this.realCol(t, c).name) : t.cols.map((c) => c.name);
        let source;
        if (a.sel) { const r = this.runSelect(a.sel); source = r.rows; if (r.columns.length !== colNames.length) fail("Column count doesn't match value count"); }
        else {
            const empty = { sources: [] };
            source = a.rows.map((row, ri) => {
                if (row.length !== colNames.length) fail(`Column count doesn't match value count at row ${ri + 1}`);
                return row.map((e) => e.n === 'lit' ? e.v : this.comp(e, empty)([]));
            });
        }
        let affected = 0, lastId = 0;
        const dupScope = a.dup ? { sources: [{ alias: t.name, t }] } : null;
        const dupFns = a.dup ? a.dup.map((d) => ({ c: this.realCol(t, d.c), fn: this.comp(d.e, dupScope) })) : null;
        for (const vals of source) {
            const provided = new Map();
            colNames.forEach((cn, i) => provided.set(cn, vals[i]));
            const { row, autoVal } = this.buildRow(t, provided);
            const cf = t.conflict(row, -1);
            if (cf) {
                if (a.ignore) continue;
                if (a.replace) { const old = t.rows.get(cf.rid); void old; this._del(t, cf.rid); affected++; const cf2 = t.conflict(row, -1); if (cf2) { this._del(t, cf2.rid); affected++; } }
                else if (a.dup) {
                    const oldRow = t.rows.get(cf.rid); const nr = { ...oldRow };
                    const env = [nr]; env.newRow = row;
                    let changed = false;
                    for (const d of dupFns) { const v = d.fn(env); const nv = v === null ? (d.c.notnull ? fail(`Column '${d.c.name}' cannot be null`) : null) : coerce(d.c, v); if (nr[d.c.name] !== nv) changed = true; nr[d.c.name] = nv; }
                    if (changed) {
                        const cf3 = t.conflict(nr, cf.rid); if (cf3) fail(t.dupMsg(nr, cf3.ix));
                        this._upd(t, cf.rid, nr); affected += 2;
                    }
                    continue;
                } else fail(t.dupMsg(row, cf.ix));
            }
            this._ins(t, t.nextRid++, row); affected++;
            if (autoVal) lastId = autoVal;
        }
        return this.ok(affected, { insertId: lastId, message: `${affected} row(s) affected` });
    }

    /* ---------- UPDATE / DELETE ---------- */
    matching(t, alias, whereAst, order, limit) {
        const scope = { sources: [{ alias, t }] };
        const where = whereAst ? this.comp(whereAst, scope) : null;
        const rids = this.pick(t, whereAst, alias);
        const out = [];
        const iter = rids ? rids.filter((r) => t.rows.has(r)).map((r) => [r, t.rows.get(r)]) : t.rows.entries();
        for (const [rid, row] of iter) { if (!where || truthy(where([row]))) out.push(rid); }
        if (order && order.length) {
            const ofns = order.map((o) => this.comp(o.e, scope));
            const keyed = out.map((rid) => ({ rid, k: ofns.map((f) => f([t.rows.get(rid)])) }));
            keyed.sort((x, y) => { for (let i = 0; i < ofns.length; i++) { const c = sortCmp(x.k[i], y.k[i]); if (c) return c * order[i].dir; } return 0; });
            return (limit != null ? keyed.slice(0, limit) : keyed).map((x) => x.rid);
        }
        return limit != null ? out.slice(0, limit) : out;
    }
    doUpdate(a) {
        const t = this.tbl(a.table); const alias = a.alias || t.name;
        const scope = { sources: [{ alias, t }] };
        const sets = a.sets.map((s) => ({ col: this.realCol(t, s.c), fn: this.comp(s.e, scope) }));
        const rids = this.matching(t, alias, a.where, a.order, a.limit);
        let affected = 0;
        for (const rid of rids) {
            const old = t.rows.get(rid); const nr = { ...old }; const env = [nr];
            let changed = false;
            for (const s of sets) {
                let v = s.fn(env);
                if (v === DEFAULT) v = this.defaultOf(s.col);
                if (v === undefined) v = null;
                if (v === null) { if (s.col.notnull) fail(`Column '${s.col.name}' cannot be null`); }
                else v = coerce(s.col, v);
                if (nr[s.col.name] !== v) changed = true;
                nr[s.col.name] = v;
            }
            if (!changed) continue;
            for (const c of t.cols) if (c.onUpdateNow && !sets.some((s) => s.col === c)) nr[c.name] = fmtDate();
            const cf = t.conflict(nr, rid); if (cf) fail(t.dupMsg(nr, cf.ix));
            for (const c of t.cols) if (c.auto && typeof nr[c.name] === 'number' && nr[c.name] >= t.auto) t.auto = nr[c.name] + 1;
            this._upd(t, rid, nr); affected++;
        }
        return this.ok(affected, { message: `${affected} row(s) affected` });
    }
    doDelete(a) {
        const t = this.tbl(a.table); const alias = a.alias || t.name;
        const rids = this.matching(t, alias, a.where, a.order, a.limit);
        for (const rid of rids) this._del(t, rid);
        return this.ok(rids.length, { message: `${rids.length} row(s) deleted` });
    }

    /* ---------- DDL ---------- */
    doCreate(a) {
        const key = a.name.toLowerCase();
        if (this.tables.has(key)) { if (a.ifNot) return this.ok(0, { message: 'Table already exists (skipped)' }); fail(`Table '${a.name}' already exists`); }
        let cols, indexes = a.indexes, auto = a.auto;
        if (a.like) {
            const src = this.tbl(a.like);
            cols = src.cols.map((c) => ({ ...c })); indexes = src.indexes.map((i) => ({ name: i.name, cols: i.cols, unique: i.unique, pk: i.pk }));
        } else {
            if (!a.cols.length) fail('A table must have at least one column');
            cols = a.cols.map(colFromDef);
            const seen = new Set();
            for (const c of cols) { if (seen.has(c.name.toLowerCase())) fail(`Duplicate column name '${c.name}'`); seen.add(c.name.toLowerCase()); }
            indexes = [];
            for (const d of a.cols) if (d.pk) indexes.push({ name: 'PRIMARY', cols: [d.name], unique: true, pk: true });
            for (const d of a.cols) if (d.unique) indexes.push({ name: d.name, cols: [d.name], unique: true });
            indexes = indexes.concat(a.indexes);
        }
        const t = new Table(a.name, cols);
        for (const ix of indexes) t.addIndex(ix);
        const ac = cols.filter((c) => c.auto);
        if (ac.length > 1) fail('There can be only one auto column');
        if (ac.length && !t.indexes.some((i) => i.cols.length >= 1 && i.cols[0] === ac[0].name)) t.addIndex({ name: ac[0].name, cols: [ac[0].name], unique: false });
        if (auto) t.auto = auto;
        this.tables.set(key, t); this.markDirty(t);
        if (this.undo) this.undo.push(() => { this.tables.delete(key); this.dropped.add(t.name); this.dirty.delete(key); });
        return this.ok(0, { message: `Table '${a.name}' created` });
    }
    renameTable(from, to) {
        const t = this.tbl(from);
        if (this.tables.has(to.toLowerCase()) && to.toLowerCase() !== from.toLowerCase()) fail(`Table '${to}' already exists`);
        this.tables.delete(t.name.toLowerCase()); this.dropped.add(t.name); this.dirty.delete(t.name.toLowerCase());
        t.name = to; this.dropped.delete(to); this.tables.set(to.toLowerCase(), t); this.markDirty(t);
    }
    dropIndex(t, name) {
        const i = t.indexes.findIndex((x) => x.name.toLowerCase() === String(name).toLowerCase());
        if (i < 0) fail(`Can't DROP '${name}'; check that column/key exists`);
        t.indexes.splice(i, 1); this.markDirty(t);
    }
    doAlter(a) {
        let t = this.tbl(a.table);
        for (const x of a.actions) {
            switch (x.op) {
                case 'addcol': {
                    const d = x.col; if (t.colMap.has(d.name.toLowerCase())) fail(`Duplicate column name '${d.name}'`);
                    const col = colFromDef(d);
                    let pos = t.cols.length;
                    if (x.pos && x.pos.first) pos = 0; else if (x.pos && x.pos.after) { pos = t.cols.findIndex((c) => c.name.toLowerCase() === x.pos.after.toLowerCase()) + 1; if (!pos) fail(`Unknown column '${x.pos.after}'`); }
                    t.cols.splice(pos, 0, col); t.meta();
                    let counter = 1;
                    for (const row of t.rows.values()) {
                        let v = this.defaultOf(col);
                        if (col.auto) v = counter++;
                        if (v === undefined) v = col.notnull ? implicitDefault(col) : null;
                        row[col.name] = v === null ? null : coerce(col, v);
                    }
                    if (col.auto) t.auto = counter;
                    if (d.pk) t.addIndex({ name: 'PRIMARY', cols: [d.name], unique: true, pk: true });
                    if (d.unique) t.addIndex({ name: d.name, cols: [d.name], unique: true });
                    break;
                }
                case 'dropcol': {
                    const c = this.realCol(t, x.name);
                    if (t.cols.length === 1) fail("You can't delete all columns with ALTER TABLE; use DROP TABLE instead");
                    t.cols = t.cols.filter((k) => k !== c); t.meta();
                    for (const row of t.rows.values()) delete row[c.name];
                    t.indexes = t.indexes.filter((ix) => !ix.cols.includes(c.name));
                    break;
                }
                case 'modify': {
                    const old = this.realCol(t, x.old); const nc = colFromDef(x.col);
                    const wasName = old.name;
                    for (const row of t.rows.values()) {
                        let v = row[wasName];
                        if (v !== null && v !== undefined) { try { v = coerce(nc, v); } catch (e) { v = nc.kind === 'text' ? String(v) : implicitDefault(nc); } }
                        else if (nc.notnull) v = this.defaultOf(nc) ?? implicitDefault(nc);
                        delete row[wasName]; row[nc.name] = v;
                    }
                    Object.assign(old, nc);
                    for (const ix of t.indexes) ix.cols = ix.cols.map((cn) => cn === wasName ? nc.name : cn);
                    if (x.pos) { t.cols = t.cols.filter((k) => k !== old); let pos = 0; if (x.pos.after) { pos = t.cols.findIndex((c) => c.name.toLowerCase() === x.pos.after.toLowerCase()) + 1; } t.cols.splice(pos, 0, old); }
                    t.meta();
                    if (x.col.pk) t.addIndex({ name: 'PRIMARY', cols: [nc.name], unique: true, pk: true });
                    break;
                }
                case 'renamecol': {
                    const c = this.realCol(t, x.from); const was = c.name;
                    if (t.colMap.has(x.to.toLowerCase()) && x.to.toLowerCase() !== was.toLowerCase()) fail(`Duplicate column name '${x.to}'`);
                    c.name = x.to; t.meta();
                    for (const row of t.rows.values()) { row[x.to] = row[was]; delete row[was]; }
                    for (const ix of t.indexes) ix.cols = ix.cols.map((cn) => cn === was ? x.to : cn);
                    break;
                }
                case 'addindex': t.addIndex(x.index); break;
                case 'dropindex': this.dropIndex(t, x.name); break;
                case 'droppk': { const i = t.indexes.findIndex((ix) => ix.pk); if (i < 0) fail("Can't DROP 'PRIMARY'; check that column/key exists"); t.indexes.splice(i, 1); break; }
                case 'renameindex': { const ix = t.indexes.find((i) => i.name.toLowerCase() === x.from.toLowerCase()); if (!ix) fail(`Key '${x.from}' doesn't exist`); ix.name = x.to; break; }
                case 'auto': t.auto = Math.max(1, Number(x.v) || 1); break;
                case 'rename': this.renameTable(t.name, x.to); t = this.tbl(x.to); break;
                default: fail('Unsupported ALTER action');
            }
        }
        t.rebuildIndexes(); this.markDirty(t);
        return this.ok(0, { message: 'Table altered' });
    }

    /* ---------- SHOW ---------- */
    doShow(a) {
        switch (a.what) {
            case 'tables': return { type: 'rows', columns: ['Tables_in_' + this.settings.dbName], rows: Array.from(this.tables.values()).map((t) => [t.name]).sort() };
            case 'databases': return { type: 'rows', columns: ['Database'], rows: [[this.settings.dbName]] };
            case 'columns': {
                const t = this.tbl(a.table);
                return { type: 'rows', columns: ['Field', 'Type', 'Null', 'Key', 'Default', 'Extra'], rows: t.cols.map((c) => { const ix = t.indexes.find((i) => i.cols.includes(c.name) && i.cols[0] === c.name); return [c.name, c.type, c.notnull ? 'NO' : 'YES', ix ? (ix.pk ? 'PRI' : ix.unique ? 'UNI' : 'MUL') : '', c.def === undefined ? null : (c.def.now ? 'CURRENT_TIMESTAMP' : c.def.v === undefined ? null : String(c.def.v)), c.auto ? 'auto_increment' : '']; }) };
            }
            case 'indexes': {
                const t = this.tbl(a.table); const rows = [];
                for (const ix of t.indexes) ix.cols.forEach((c, i) => rows.push([t.name, ix.unique ? 0 : 1, ix.name, i + 1, c]));
                return { type: 'rows', columns: ['Table', 'Non_unique', 'Key_name', 'Seq_in_index', 'Column_name'], rows };
            }
            case 'create': { const t = this.tbl(a.table); return { type: 'rows', columns: ['Table', 'Create Table'], rows: [[t.name, t.createSQL()]] }; }
            case 'status': return { type: 'rows', columns: ['Name', 'Rows', 'Auto_increment'], rows: Array.from(this.tables.values()).map((t) => [t.name, t.rows.size, t.auto]) };
            default: return { type: 'rows', columns: [], rows: [] };
        }
    }
}/* ------------------------------------------------------------------ browse / edit / import / export */
function parseCSV(text, delim) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    if (!delim) {
        const first = text.slice(0, text.indexOf('\n') < 0 ? text.length : text.indexOf('\n'));
        let best = ',', bc = -1;
        for (const d of [',', ';', '\t', '|']) { let c = 0, q = false; for (const ch of first) { if (ch === '"') q = !q; else if (ch === d && !q) c++; } if (c > bc) { bc = c; best = d; } }
        delim = best;
    }
    const rows = []; let row = [], f = '', q = false, i = 0; const n = text.length;
    while (i < n) {
        const ch = text[i];
        if (q) {
            if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i += 2; continue; } q = false; i++; continue; }
            f += ch; i++; continue;
        }
        if (ch === '"' && f === '') { q = true; i++; continue; }
        if (ch === delim) { row.push(f); f = ''; i++; continue; }
        if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(f); f = ''; rows.push(row); row = []; i++; continue; }
        f += ch; i++;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    return { rows: rows.filter((r) => !(r.length === 1 && r[0] === '')), delim };
}
const csvCell = (v, d) => { if (v === null || v === undefined) return ''; const s = String(v); return (s.includes(d) || s.includes('"') || s.includes('\n') || s.includes('\r')) ? '"' + s.replace(/"/g, '""') + '"' : s; };

function inferType(values) {
    let allInt = true, allNum = true, any = false;
    for (const v of values) {
        if (v === null || v === undefined || v === '') continue;
        any = true;
        if (typeof v === 'boolean') continue;
        if (typeof v === 'number') { if (!Number.isInteger(v)) allInt = false; continue; }
        if (typeof v === 'string') {
            if (!NUMSTR.test(v) || /^0\d/.test(v.trim()) || v.length > 15) { allNum = false; allInt = false; break; }
            if (!/^\s*[+-]?\d+\s*$/.test(v)) allInt = false;
        } else { allNum = false; allInt = false; break; }
    }
    if (!any) return 'text';
    if (allInt) return 'bigint'; if (allNum) return 'double';
    return values.some((v) => typeof v === 'string' && v.length > 255) ? 'longtext' : 'varchar(255)';
}

Object.assign(DBEngine.prototype, {
    /* ---------- table browser ---------- */
    browse(name, o = {}) {
        const t = this.tbl(name);
        const size = Math.max(1, Math.min(1000, Number(o.size) || 50));
        const columns = t.cols.map((c) => ({ name: c.name, type: c.type, kind: c.kind, notnull: c.notnull, auto: c.auto, pk: t.indexes.some((i) => i.pk && i.cols.includes(c.name)), hasDef: c.def !== undefined }));
        let list;
        const q = o.search ? String(o.search).toLowerCase() : '';
        const sortCol = o.sort ? t.colMap.get(String(o.sort).toLowerCase()) : null;
        let total = t.rows.size;
        if (!q && !sortCol) {
            const page = Math.max(0, Number(o.page) || 0);
            const from = page * size; list = []; let i = 0;
            for (const [rid, row] of t.rows) { if (i >= from + size) break; if (i >= from) list.push([rid, row]); i++; }
            return { columns, rows: list.map(([rid, row]) => ({ rid, v: t.cols.map((c) => row[c.name]) })), total, page, pages: Math.max(1, Math.ceil(total / size)), size };
        }
        list = Array.from(t.rows.entries());
        if (q) {
            const cname = o.searchCol ? (t.colMap.get(String(o.searchCol).toLowerCase()) || {}).name : null;
            list = list.filter(([, row]) => cname ? (row[cname] != null && String(row[cname]).toLowerCase().includes(q)) : t.cols.some((c) => row[c.name] != null && String(row[c.name]).toLowerCase().includes(q)));
            total = list.length;
        }
        if (sortCol) { const d = o.dir === 'desc' ? -1 : 1; list.sort((a, b) => sortCmp(a[1][sortCol.name], b[1][sortCol.name]) * d); }
        const pages = Math.max(1, Math.ceil(total / size)); const page = Math.min(Math.max(0, Number(o.page) || 0), pages - 1);
        list = list.slice(page * size, page * size + size);
        return { columns, rows: list.map(([rid, row]) => ({ rid, v: t.cols.map((c) => row[c.name]) })), total, page, pages, size };
    },
    atomicOp(fn) {
        this.undo = [];
        try { const r = fn(); this.undo = null; return r; }
        catch (e) { const u = this.undo; this.undo = null; for (let i = u.length - 1; i >= 0; i--) { try { u[i](); } catch (x) { /* ignore */ } } throw e; }
    },
    rowOp(name, op, a = {}) {
        const t = this.tbl(name);
        return this.atomicOp(() => {
            if (op === 'insert') {
                const provided = new Map();
                for (const [k, v] of Object.entries(a.values || {})) { const c = this.realCol(t, k); provided.set(c.name, v === undefined ? DEFAULT : v); }
                const { row } = this.buildRow(t, provided);
                const cf = t.conflict(row, -1); if (cf) fail(t.dupMsg(row, cf.ix));
                const rid = t.nextRid++; this._ins(t, rid, row);
                return { rid, row };
            }
            if (op === 'update') {
                const rid = Number(a.rid); const old = t.rows.get(rid); if (!old) fail('Row no longer exists (reload the table)');
                const nr = { ...old };
                for (const [k, v] of Object.entries(a.values || {})) {
                    const c = this.realCol(t, k);
                    if (v === null) { if (c.notnull) fail(`Column '${c.name}' cannot be null`); nr[c.name] = null; } else nr[c.name] = coerce(c, v);
                }
                for (const c of t.cols) if (c.onUpdateNow && !(c.name in (a.values || {}))) nr[c.name] = fmtDate();
                const cf = t.conflict(nr, rid); if (cf) fail(t.dupMsg(nr, cf.ix));
                for (const c of t.cols) if (c.auto && typeof nr[c.name] === 'number' && nr[c.name] >= t.auto) t.auto = nr[c.name] + 1;
                this._upd(t, rid, nr);
                return { rid, row: nr };
            }
            if (op === 'delete') {
                let n = 0; for (const rid of (a.rids || [])) { if (t.rows.has(Number(rid))) { this._del(t, Number(rid)); n++; } }
                return { deleted: n };
            }
            fail('Unknown row operation');
        });
    },

    /* ---------- export ---------- */
    pickTables(names) {
        const all = Array.from(this.tables.values()).sort((a, b) => a.name.localeCompare(b.name));
        if (!names || !names.length) return all;
        const set = new Set(names.map((n) => String(n).toLowerCase()));
        return all.filter((t) => set.has(t.name.toLowerCase()));
    },
    dumpSQL(o = {}) {
        const structure = o.structure !== false, data = o.data !== false, batch = o.batch || 250;
        const out = [`-- DBEngine SQL dump`, `-- Database: ${this.settings.dbName}`, `-- Generated: ${new Date().toISOString()}`, ''];
        for (const t of this.pickTables(o.tables)) {
            out.push(`-- ----------------------------`, `-- Table: ${t.name}`, `-- ----------------------------`);
            if (structure) {
                if (o.drop) out.push(`DROP TABLE IF EXISTS ${qid(t.name)};`);
                out.push(o.ifNotExists ? t.createSQL().replace('CREATE TABLE', 'CREATE TABLE IF NOT EXISTS') : t.createSQL(), '');
            }
            if (data && t.rows.size) {
                const cl = t.cols.map((c) => qid(c.name)).join(', ');
                let buf = [];
                for (const row of t.rows.values()) {
                    buf.push('(' + t.cols.map((c) => sqlLit(row[c.name])).join(', ') + ')');
                    if (buf.length >= batch) { out.push(`INSERT INTO ${qid(t.name)} (${cl}) VALUES\n${buf.join(',\n')};`); buf = []; }
                }
                if (buf.length) out.push(`INSERT INTO ${qid(t.name)} (${cl}) VALUES\n${buf.join(',\n')};`);
                out.push('');
            }
        }
        return out.join('\n');
    },
    dumpJSON(o = {}) {
        const tables = this.pickTables(o.tables).map((t) => {
            const j = { name: t.name, auto: t.auto, columns: t.cols.map((c) => ({ name: c.name, type: c.type, notnull: c.notnull, auto: c.auto, def: c.def, onUpdateNow: c.onUpdateNow || undefined })), indexes: t.indexes.map((i) => ({ name: i.name, cols: i.cols, unique: i.unique, pk: i.pk })) };
            if (o.data !== false) j.rows = Array.from(t.rows.values()).map((r) => t.cols.map((c) => r[c.name]));
            return j;
        });
        return JSON.stringify({ format: 'dbengine-json', version: 1, database: this.settings.dbName, exportedAt: new Date().toISOString(), tables }, null, o.pretty ? 2 : 0);
    },
    dumpCSV(name, o = {}) {
        const t = this.tbl(name); const d = o.delimiter === 'tab' ? '\t' : (o.delimiter || ',');
        const lines = [];
        if (o.header !== false) lines.push(t.cols.map((c) => csvCell(c.name, d)).join(d));
        for (const row of t.rows.values()) lines.push(t.cols.map((c) => csvCell(row[c.name], d)).join(d));
        return (o.bom ? '\ufeff' : '') + lines.join('\r\n') + '\r\n';
    },

    /* ---------- import ---------- */
    runScript(sql, o = {}) {
        const sum = { statements: 0, ok: 0, failed: 0, affected: 0, errors: [], ms: 0 };
        const t0 = Date.now();
        const saveTx = this.txSnap; let snap = null;
        if (o.atomic) snap = this.snapshot();
        let n = 0, poff = 0;
        try {
            for (const st of statements(String(sql))) {
                n++; sum.statements++;
                try {
                    const r = this.runStatement(st, [], { noUndo: o.noUndo !== false });
                    sum.ok++; sum.affected += r.affected || 0;
                } catch (e) {
                    if (!(e instanceof SQLError)) throw e;
                    sum.failed++;
                    if (sum.errors.length < 50) sum.errors.push({ index: n, error: e.message, sql: st.src.slice(st.from, Math.min(st.to, st.from + 140)) });
                    if (!o.continueOnError) { if (snap) { this.restore(snap); sum.rolledBack = true; } break; }
                }
            }
        } finally { void saveTx; void poff; }
        if (sum.failed && o.atomic && !sum.rolledBack) { this.restore(snap); sum.rolledBack = true; }
        sum.ms = Date.now() - t0;
        return sum;
    },
    insertObjects(t, rowsIn, mode, res) {
        // rowsIn: array of plain objects keyed by column name
        for (const obj of rowsIn) {
            try {
                const provided = new Map();
                for (const [k, v] of Object.entries(obj)) { const c = t.colMap.get(k.toLowerCase()); if (c) provided.set(c.name, v === '' && c.kind !== 'text' && c.kind !== 'json' && c.kind !== 'date' ? null : v); }
                const { row } = this.buildRow(t, provided);
                const cf = t.conflict(row, -1);
                if (cf) {
                    if (mode === 'skip') { res.skipped++; continue; }
                    if (mode === 'replace') { this._del(t, cf.rid); res.replaced++; const cf2 = t.conflict(row, -1); if (cf2) this._del(t, cf2.rid); }
                    else fail(t.dupMsg(row, cf.ix));
                }
                this._ins(t, t.nextRid++, row); res.inserted++;
            } catch (e) {
                if (!(e instanceof SQLError)) throw e;
                res.failed++; if (res.errors.length < 30) res.errors.push(`${t.name}: ${e.message}`);
            }
        }
    },
    ensureTable(name, colDefs, res, o = {}) {
        const key = name.toLowerCase();
        if (this.tables.has(key)) {
            if (o.drop) { this.dispatch({ type: 'drop', ifExists: true, names: [name] }); }
            else {
                const t = this.tables.get(key);
                if (o.truncate) { this.dispatch({ type: 'truncate', table: name }); }
                return t;
            }
        }
        const cols = colDefs.map(colFromDef);
        const t = new Table(name, cols);
        const pk = colDefs.filter((c) => c.pk).map((c) => c.name);
        if (pk.length) t.addIndex({ name: 'PRIMARY', cols: pk, unique: true, pk: true });
        for (const ix of o.indexes || []) { try { if (!ix.pk) t.addIndex(ix); else if (!pk.length) t.addIndex(ix); } catch (e) { /* skip bad index */ } }
        const ac = cols.find((c) => c.auto);
        if (ac && !t.indexes.some((i) => i.cols[0] === ac.name)) t.addIndex({ name: ac.name, cols: [ac.name], unique: false });
        this.tables.set(key, t); this.markDirty(t); res.created.push(name);
        return t;
    },
    importJSON(text, o = {}) {
        const res = { inserted: 0, skipped: 0, replaced: 0, failed: 0, created: [], errors: [], tables: 0 };
        let doc; try { doc = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); } catch (e) { fail('Invalid JSON: ' + e.message); }
        let tables = [];
        if (doc && doc.format === 'dbengine-json') tables = doc.tables;
        else if (Array.isArray(doc) && doc.length && doc.every((x) => x && x.type === 'table' && Array.isArray(x.data))) tables = doc.map((x) => ({ name: x.name, rows: x.data }));
        else if (Array.isArray(doc)) { if (!o.table) fail('This JSON is an array of rows: enter the target table name'); tables = [{ name: o.table, rows: doc }]; }
        else if (doc && typeof doc === 'object') {
            if (Array.isArray(doc.tables)) tables = doc.tables;
            else for (const [k, v] of Object.entries(doc)) if (Array.isArray(v)) tables.push({ name: k, rows: v });
        }
        if (!tables.length) fail('No tables/rows found in the JSON file');
        const mode = o.mode || 'skip';
        const saveUndo = this.undo; this.undo = null;
        try {
            for (const tj of tables) {
                if (!tj || !tj.name) continue;
                res.tables++;
                let rowsObj = tj.rows || [];
                let colDefs = null, names = null;
                if (Array.isArray(tj.columns) && tj.columns.length) {
                    if (typeof tj.columns[0] === 'string') names = tj.columns;
                    else { colDefs = tj.columns.map((c) => ({ name: c.name, type: c.type || 'text', notnull: !!c.notnull, auto: !!c.auto, def: c.def, onUpdateNow: !!c.onUpdateNow, pk: (tj.indexes || []).some((i) => i.pk && i.cols.includes(c.name)) })); names = colDefs.map((c) => c.name); }
                }
                if (rowsObj.length && Array.isArray(rowsObj[0])) {
                    if (!names) fail(`Table '${tj.name}': rows are arrays but no column list was found`);
                    rowsObj = rowsObj.map((r) => { const o2 = {}; names.forEach((n, i) => { o2[n] = r[i]; }); return o2; });
                }
                if (!colDefs) {
                    if (this.tables.has(tj.name.toLowerCase())) colDefs = [];
                    else {
                        const keys = new Set(names || []); for (const r of rowsObj.slice(0, 5000)) Object.keys(r).forEach((k) => keys.add(k));
                        colDefs = Array.from(keys).map((k) => ({ name: k, type: inferType(rowsObj.slice(0, 5000).map((r) => r[k])), notnull: false }));
                        const idc = colDefs.find((c) => c.name.toLowerCase() === 'id' && c.type === 'bigint');
                        if (idc && new Set(rowsObj.map((r) => r.id)).size === rowsObj.length) { idc.pk = true; idc.auto = true; idc.notnull = true; }
                    }
                }
                const t = this.ensureTable(tj.name, colDefs, res, { drop: mode === 'drop', truncate: mode === 'replace-all', indexes: tj.indexes });
                if (tj.auto && tj.auto > t.auto) t.auto = tj.auto;
                this.insertObjects(t, rowsObj, mode === 'drop' || mode === 'replace-all' ? 'error' : mode, res);
                this.markDirty(t);
            }
        } finally { this.undo = saveUndo; }
        return res;
    },
    importCSV(text, o = {}) {
        if (!o.table || !/^[\w$\-. ]{1,64}$/.test(o.table)) fail('Enter a valid target table name');
        const { rows } = parseCSV(text, o.delimiter === 'tab' ? '\t' : o.delimiter);
        if (!rows.length) fail('The CSV file is empty');
        const res = { inserted: 0, skipped: 0, replaced: 0, failed: 0, created: [], errors: [], tables: 1 };
        let head; let body;
        if (o.header === false) { head = rows[0].map((_, i) => 'col' + (i + 1)); body = rows; } else { head = rows[0].map((h, i) => String(h).trim() || 'col' + (i + 1)); body = rows.slice(1); }
        const objs = body.map((r) => { const ob = {}; head.forEach((h, i) => { const v = r[i]; ob[h] = (v === undefined || (v === '' && o.emptyAsNull !== false)) ? null : v; }); return ob; });
        const saveUndo = this.undo; this.undo = null;
        try {
            let t = this.tables.get(o.table.toLowerCase());
            if (!t) {
                if (o.create === false) fail(`Table '${o.table}' doesn't exist`);
                const colDefs = head.map((h) => ({ name: h, type: inferType(objs.slice(0, 5000).map((r) => r[h])), notnull: false }));
                const idc = colDefs.find((c) => c.name.toLowerCase() === 'id' && c.type === 'bigint');
                if (idc && new Set(objs.map((r) => r.id)).size === objs.length && objs.every((r) => r.id !== null)) { idc.pk = true; idc.auto = true; idc.notnull = true; }
                t = this.ensureTable(o.table, colDefs, res, {});
            } else if (o.truncate) this.dispatch({ type: 'truncate', table: o.table });
            this.insertObjects(t, objs, o.mode || 'skip', res);
            this.markDirty(t);
        } finally { this.undo = saveUndo; }
        return res;
    },
    wipeAll() {
        for (const t of this.tables.values()) { this.dropped.add(t.name); }
        this.tables = new Map(); this.dirty.clear(); this.txSnap = null; this.schedule();
    },

    /* ---------- backups ---------- */
    backupCreate(label) {
        const ts = new Date(); const stamp = `${ts.getFullYear()}-${pad(ts.getMonth() + 1)}-${pad(ts.getDate())}_${pad(ts.getHours())}-${pad(ts.getMinutes())}-${pad(ts.getSeconds())}`;
        const safe = label ? '_' + String(label).replace(/[^\w\-]/g, '').slice(0, 24) : '';
        const name = `backup_${stamp}${safe}.json`;
        this.atomic(path.join(this.bdir, name), this.dumpJSON({ pretty: false }));
        this.lastBackupAt = Date.now();
        const list = this.backupList();
        const keep = Math.max(1, this.settings.keepBackups || 10);
        for (const b of list.slice(keep)) { if (!/_pre-restore|_keep/.test(b.name)) { try { fs.unlinkSync(path.join(this.bdir, b.name)); } catch (e) { /* ignore */ } } }
        return name;
    },
    backupList() {
        let files = []; try { files = fs.readdirSync(this.bdir); } catch (e) { return []; }
        return files.filter((f) => /^[\w.\-]+\.json$/.test(f)).map((f) => { const st = fs.statSync(path.join(this.bdir, f)); return { name: f, size: st.size, mtime: st.mtimeMs }; }).sort((a, b) => b.mtime - a.mtime);
    },
    backupPath(name) { if (!/^[\w.\-]+\.json$/.test(String(name))) fail('Bad backup name'); const p = path.join(this.bdir, name); if (!fs.existsSync(p)) fail('Backup not found'); return p; },
    backupRestore(name) {
        const p = this.backupPath(name);
        const text = fs.readFileSync(p, 'utf8');
        JSON.parse(text);
        this.backupCreate('pre-restore');
        this.wipeAll();
        return this.importJSON(text, { mode: 'drop' });
    },
    backupDelete(name) { fs.unlinkSync(this.backupPath(name)); },
    tickBackup() {
        const m = Number(this.settings.autoBackupMin) || 0;
        if (m <= 0) return null;
        if (!this.lastBackupAt) { const l = this.backupList(); this.lastBackupAt = l.length ? l[0].mtime : 0; }
        if (Date.now() - this.lastBackupAt >= m * 60000 && this.tables.size) return this.backupCreate('auto');
        return null;
    },

    /* ---------- settings / cfg ---------- */
    updateSettings(j) {
        const s = this.settings; const e = [];
        const str = (v) => String(v === undefined || v === null ? '' : v).trim();
        if (j.dbName !== undefined) { if (/^[\w\-]{1,64}$/.test(str(j.dbName))) s.dbName = str(j.dbName); else e.push('Database name: letters, digits, _ and - only (max 64)'); }
        if (j.host !== undefined) { if (/^[\w.\-:]{1,255}$/.test(str(j.host))) s.host = str(j.host); else e.push('Invalid host'); }
        if (j.port !== undefined) { const p = Number(j.port); if (Number.isInteger(p) && p >= 1 && p <= 65535) s.port = p; else e.push('Port must be 1-65535'); }
        if (j.user !== undefined) { if (/^[\w.\-@]{1,64}$/.test(str(j.user))) s.user = str(j.user); else e.push('Username: letters, digits, . _ - @ only (max 64)'); }
        if (j.password !== undefined) { const p = String(j.password); if (p.length >= 1 && p.length <= 128 && !/[\x00-\x1f]/.test(p)) s.password = p; else e.push('Password must be 1-128 characters without control characters'); }
        if (j.autoBackupMin !== undefined) { const p = Number(j.autoBackupMin); if (Number.isFinite(p) && p >= 0 && p <= 10080) s.autoBackupMin = Math.floor(p); else e.push('Auto backup interval must be 0-10080 minutes'); }
        if (j.keepBackups !== undefined) { const p = Number(j.keepBackups); if (Number.isFinite(p) && p >= 1 && p <= 200) s.keepBackups = Math.floor(p); else e.push('Keep backups must be 1-200'); }
        if (j.cfgVar !== undefined) { if (/^[\w]{1,64}$/.test(str(j.cfgVar))) s.cfgVar = str(j.cfgVar); else e.push('Invalid convar name'); }
        if (e.length) fail(e.join('; '));
        CURRENT_DB = s.dbName;
        this.saveMeta();
    },
    randomPassword() { return crypto.randomBytes(18).toString('base64').replace(/[+/=]/g, '').slice(0, 20); },
    connString() {
        const s = this.settings;
        return `mysql://${encodeURIComponent(s.user)}:${encodeURIComponent(s.password)}@${s.host}:${s.port}/${encodeURIComponent(s.dbName)}?charset=utf8mb4`;
    },
    cfgLine() { return `set ${this.settings.cfgVar || 'mysql_connection_string'} "${this.connString()}"`; },

    /* ---------- overview ---------- */
    overview() {
        let rows = 0, disk = 0;
        const tables = Array.from(this.tables.values()).sort((a, b) => a.name.localeCompare(b.name)).map((t) => {
            let bytes = 0; try { bytes = fs.statSync(this.tfile(t.name)).size; } catch (e) { /* not flushed yet */ }
            disk += bytes; rows += t.rows.size;
            return { name: t.name, rows: t.rows.size, cols: t.cols.length, indexes: t.indexes.length, auto: t.auto, bytes };
        });
        const st = this.stats;
        return {
            settings: this.settings, tables, history: this.history.slice(0, 60),
            stats: { tables: tables.length, rows, diskBytes: disk, queries: st.queries, errors: st.errors, avgMs: st.queries ? Math.round(st.totalMs / st.queries * 1000) / 1000 : 0, uptimeSec: Math.round((Date.now() - st.started) / 1000), writes: st.writes, lastFlush: st.lastFlush, inTx: !!this.txSnap, pendingWrite: this.dirty.size },
        };
    },
});

/* Insert or replace the DB convar inside a server.cfg text. Keeps line endings. */
DBEngine.applyCfg = function (text, line, varName) {
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const re = new RegExp('^[ \\t]*(?:set|setr|sets)[ \\t]+' + varName + '\\b.*$', 'gmi');
    let count = 0;
    let out = text.replace(re, () => (count++ === 0 ? line : '\u0000REMOVE\u0000'));
    out = out.split(eol).filter((l) => l !== '\u0000REMOVE\u0000').join(eol);
    if (count > 0) return { text: out, changed: out !== text, replaced: true };
    const sep = (out.length && !out.endsWith('\n')) ? eol : '';
    return { text: out + sep + eol + '# DBEngine - automatic database setup' + eol + line + eol, changed: true, replaced: false };
};
DBEngine.parseCSV = parseCSV;
DBEngine.SQLError = SQLError;

module.exports = DBEngine;