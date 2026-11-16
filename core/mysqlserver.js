'use strict';
/*
 * DBEngine MySQL protocol server.
 * Lets oxmysql / mysql2 / mariadb connectors talk to the internal DBEngine over TCP
 * (default 127.0.0.1:3306) using the standard MySQL client/server protocol.
 * Zero dependencies. Supports: handshake v10 + mysql_native_password, COM_QUERY (text protocol,
 * multi-statement), prepared statements (binary protocol), COM_PING / INIT_DB / QUIT / RESET.
 */
const net = require('node:net');
const crypto = require('node:crypto');

const CAP = {
    LONG_PASSWORD: 0x1, FOUND_ROWS: 0x2, LONG_FLAG: 0x4, CONNECT_WITH_DB: 0x8, PROTOCOL_41: 0x200,
    TRANSACTIONS: 0x2000, SECURE_CONNECTION: 0x8000, MULTI_STATEMENTS: 0x10000, MULTI_RESULTS: 0x20000,
    PS_MULTI_RESULTS: 0x40000, PLUGIN_AUTH: 0x80000, CONNECT_ATTRS: 0x100000, PLUGIN_AUTH_LENENC: 0x200000,
};
const SERVER_CAPS = CAP.LONG_PASSWORD | CAP.FOUND_ROWS | CAP.LONG_FLAG | CAP.CONNECT_WITH_DB | CAP.PROTOCOL_41 |
    CAP.TRANSACTIONS | CAP.SECURE_CONNECTION | CAP.MULTI_STATEMENTS | CAP.MULTI_RESULTS | CAP.PS_MULTI_RESULTS |
    CAP.PLUGIN_AUTH | CAP.CONNECT_ATTRS | CAP.PLUGIN_AUTH_LENENC;
const ST = { IN_TRANS: 0x1, AUTOCOMMIT: 0x2, MORE: 0x8 };
const T = { TINY: 1, SHORT: 2, LONG: 3, FLOAT: 4, DOUBLE: 5, NULL: 6, TIMESTAMP: 7, LONGLONG: 8, INT24: 9, DATE: 10, TIME: 11, DATETIME: 12, YEAR: 13, VARCHAR: 15, BIT: 16, JSON: 245, NEWDECIMAL: 246, BLOB: 252, VAR_STRING: 253, STRING: 254 };
const SERVER_VERSION = '8.0.36-DBEngine';
const MAX_PACKET_TOTAL = 512 * 1024 * 1024;
const LOCK_WAIT_MS = 30000;

const sha1 = (...b) => { const h = crypto.createHash('sha1'); for (const x of b) h.update(x); return h.digest(); };
const xor = (a, b) => { const o = Buffer.alloc(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] ^ b[i]; return o; };

/* ------------------------------------------------------------------ encoding helpers */
function lenInt(n) {
    if (typeof n === 'bigint') { const b = Buffer.alloc(9); b[0] = 0xfe; b.writeBigUInt64LE(n, 1); return b; }
    if (n < 251) return Buffer.from([n]);
    if (n < 0x10000) { const b = Buffer.alloc(3); b[0] = 0xfc; b.writeUInt16LE(n, 1); return b; }
    if (n < 0x1000000) { const b = Buffer.alloc(4); b[0] = 0xfd; b.writeUIntLE(n, 1, 3); return b; }
    const b = Buffer.alloc(9); b[0] = 0xfe; b.writeBigUInt64LE(BigInt(n), 1); return b;
}
const lenStr = (s) => { const b = Buffer.isBuffer(s) ? s : Buffer.from(String(s), 'utf8'); return Buffer.concat([lenInt(b.length), b]); };
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff, 0); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; };

class Reader {
    constructor(buf, off = 0) { this.b = buf; this.o = off; }
    get left() { return this.b.length - this.o; }
    u8() { return this.b[this.o++]; }
    u16() { const v = this.b.readUInt16LE(this.o); this.o += 2; return v; }
    u24() { const v = this.b.readUIntLE(this.o, 3); this.o += 3; return v; }
    u32() { const v = this.b.readUInt32LE(this.o); this.o += 4; return v; }
    i8() { const v = this.b.readInt8(this.o); this.o += 1; return v; }
    i16() { const v = this.b.readInt16LE(this.o); this.o += 2; return v; }
    i32() { const v = this.b.readInt32LE(this.o); this.o += 4; return v; }
    u64() { const v = this.b.readBigUInt64LE(this.o); this.o += 8; return v; }
    i64() { const v = this.b.readBigInt64LE(this.o); this.o += 8; return v; }
    f32() { const v = this.b.readFloatLE(this.o); this.o += 4; return v; }
    f64() { const v = this.b.readDoubleLE(this.o); this.o += 8; return v; }
    bytes(n) { const v = this.b.subarray(this.o, this.o + n); this.o += n; return v; }
    rest() { const v = this.b.subarray(this.o); this.o = this.b.length; return v; }
    cstr() { let e = this.b.indexOf(0, this.o); if (e < 0) e = this.b.length; const v = this.b.toString('utf8', this.o, e); this.o = Math.min(e + 1, this.b.length); return v; }
    lenInt() {
        const f = this.u8();
        if (f < 251) return f;
        if (f === 0xfc) return this.u16();
        if (f === 0xfd) return this.u24();
        if (f === 0xfe) return Number(this.u64());
        return null; // 0xfb NULL
    }
    lenBytes() { const n = this.lenInt(); return n === null ? null : this.bytes(n); }
}

const pad = (n, l = 2) => String(n).padStart(l, '0');
const fmtDate = (d) => `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

function mapError(msg) {
    msg = String(msg || '');
    if (/^Duplicate entry/.test(msg)) return [1062, '23000'];
    if (/^Table '.*' doesn't exist/.test(msg)) return [1146, '42S02'];
    if (/^Unknown table/.test(msg)) return [1051, '42S02'];
    if (/^Unknown column/.test(msg)) return [1054, '42S22'];
    if (/^Syntax error|^unsupported|^Unexpected character|^Unterminated/i.test(msg)) return [1064, '42000'];
    if (/^Table '.*' already exists/.test(msg)) return [1050, '42S01'];
    if (/^Duplicate column name/.test(msg)) return [1060, '42S21'];
    if (/^Duplicate key name/.test(msg)) return [1061, '42000'];
    if (/cannot be null/.test(msg)) return [1048, '23000'];
    if (/^Column count doesn't match/.test(msg)) return [1136, '21S01'];
    if (/is ambiguous/.test(msg)) return [1052, '23000'];
    if (/^Out of range/.test(msg)) return [1264, '22003'];
    if (/^Incorrect (integer|decimal)/.test(msg)) return [1366, 'HY000'];
    if (/^Unknown function/.test(msg)) return [1305, '42000'];
    if (/^Multiple primary key/.test(msg)) return [1068, '42000'];
    return [1105, 'HY000'];
}

/* ------------------------------------------------------------------ session / system query shims */
const VARS = {
    version: SERVER_VERSION, version_comment: 'DBEngine (txAdmin internal)', version_compile_os: 'Win64', max_allowed_packet: 67108864,
    sql_mode: 'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION', autocommit: 1, time_zone: 'SYSTEM', system_time_zone: 'UTC',
    character_set_client: 'utf8mb4', character_set_connection: 'utf8mb4', character_set_results: 'utf8mb4', character_set_database: 'utf8mb4',
    character_set_server: 'utf8mb4', collation_connection: 'utf8mb4_general_ci', collation_database: 'utf8mb4_general_ci', collation_server: 'utf8mb4_general_ci',
    lower_case_table_names: 0, wait_timeout: 28800, interactive_timeout: 28800, net_write_timeout: 60, net_read_timeout: 30,
    transaction_isolation: 'REPEATABLE-READ', tx_isolation: 'REPEATABLE-READ', sql_auto_is_null: 0, group_concat_max_len: 1024,
    max_connections: 151, event_scheduler: 'OFF', default_storage_engine: 'InnoDB', have_ssl: 'NO', innodb_version: '8.0.36', license: 'GPL',
    hostname: 'dbengine', foreign_key_checks: 1, unique_checks: 1, sql_safe_updates: 0, read_only: 0, innodb_lock_wait_timeout: 50,
};
const stripSQL = (sql) => String(sql).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\n)\s*(--\s|#)[^\n]*/g, ' ').trim().replace(/;+\s*$/, '').trim();
const likeToRe = (p) => new RegExp('^' + String(p).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i');

function shim(sql, srv) {
    const s = stripSQL(sql);
    if (!s) return [{ type: 'ok', affected: 0, insertId: 0 }];
    let m;
    const db = srv.db;
    if ((m = /^select\s+version\s*\(\s*\)(?:\s+(?:as\s+)?[`'"]?(\w+)[`'"]?)?$/i.exec(s))) return [{ type: 'rows', columns: [m[1] || 'VERSION()'], rows: [[SERVER_VERSION]] }];
    if ((m = /^select\s+(?:database|schema)\s*\(\s*\)(?:\s+(?:as\s+)?[`'"]?(\w+)[`'"]?)?$/i.exec(s))) return [{ type: 'rows', columns: [m[1] || 'DATABASE()'], rows: [[db.settings.dbName]] }];
    if (/^select\s+@@/i.test(s) && !/\bfrom\b/i.test(s)) {
        const items = s.replace(/^select\s+/i, '').split(',').map((x) => x.trim());
        const cols = [], row = []; let ok = true;
        for (const it of items) {
            const mm = /^@@(?:(?:global|session|local)\.)?(\w+)(?:\s+(?:as\s+)?[`'"]?(\w+)[`'"]?)?$/i.exec(it);
            if (!mm) { ok = false; break; }
            const k = mm[1].toLowerCase();
            cols.push(mm[2] || ('@@' + it.replace(/^@@/, '').split(/\s/)[0]));
            row.push(k === 'port' ? db.settings.port : (k in VARS ? VARS[k] : null));
        }
        if (ok) return [{ type: 'rows', columns: cols, rows: [row] }];
    }
    if ((m = /^show\s+(?:global\s+|session\s+)?(variables|status)(?:\s+like\s+'([^']*)')?$/i.exec(s))) {
        const re = m[2] ? likeToRe(m[2]) : null;
        const src = m[1].toLowerCase() === 'variables' ? VARS : { Uptime: Math.round((Date.now() - db.stats.started) / 1000), Threads_connected: srv.conns.size, Questions: db.stats.queries, Queries: db.stats.queries };
        const rows = Object.entries(src).filter(([k]) => !re || re.test(k)).map(([k, v]) => [k, String(v)]);
        return [{ type: 'rows', columns: ['Variable_name', 'Value'], rows }];
    }
    if (/^show\s+(warnings|errors)/i.test(s)) return [{ type: 'rows', columns: ['Level', 'Code', 'Message'], rows: [] }];
    if (/^show\s+engines/i.test(s)) return [{ type: 'rows', columns: ['Engine', 'Support', 'Comment', 'Transactions', 'XA', 'Savepoints'], rows: [['InnoDB', 'DEFAULT', 'DBEngine', 'YES', 'NO', 'NO']] }];
    if (/^show\s+(full\s+)?processlist/i.test(s)) return [{ type: 'rows', columns: ['Id', 'User', 'Host', 'db', 'Command', 'Time', 'State', 'Info'], rows: [] }];
    if (/^show\s+(charset|character\s+set|collation)/i.test(s)) return [{ type: 'rows', columns: ['Charset', 'Description', 'Default collation', 'Maxlen'], rows: [['utf8mb4', 'UTF-8 Unicode', 'utf8mb4_general_ci', 4]] }];
    if (/^(savepoint|release\s+savepoint)\b/i.test(s)) return [{ type: 'ok', affected: 0, insertId: 0 }];
    if (/^kill\b/i.test(s)) return [{ type: 'ok', affected: 0, insertId: 0 }];
    if (/^select\s+(connection_id|last_insert_id)\s*\(\s*\)$/i.test(s)) return null;
    return null;
}

function countPlaceholders(sql) {
    let n = 0, i = 0; const L = sql.length;
    while (i < L) {
        const c = sql[i];
        if (c === "'" || c === '"' || c === '`') {
            i++;
            while (i < L) { if (sql[i] === '\\' && c !== '`') { i += 2; continue; } if (sql[i] === c) { if (sql[i + 1] === c) { i += 2; continue; } break; } i++; }
            i++; continue;
        }
        if (c === '-' && sql[i + 1] === '-' && (i + 2 >= L || /\s/.test(sql[i + 2]))) { const e = sql.indexOf('\n', i); i = e < 0 ? L : e + 1; continue; }
        if (c === '#') { const e = sql.indexOf('\n', i); i = e < 0 ? L : e + 1; continue; }
        if (c === '/' && sql[i + 1] === '*') { const e = sql.indexOf('*/', i + 2); i = e < 0 ? L : e + 2; continue; }
        if (c === '?') n++;
        i++;
    }
    return n;
}

/* ------------------------------------------------------------------ result set encoding */
function inferColumns(columns, rows) {
    return columns.map((name, ci) => {
        let allInt = true, allNum = true, any = false;
        for (const r of rows) {
            const v = r[ci];
            if (v === null || v === undefined) continue;
            any = true;
            if (typeof v === 'bigint') continue;
            if (typeof v === 'boolean') continue;
            if (typeof v === 'number' && Number.isFinite(v)) { if (!Number.isInteger(v)) allInt = false; continue; }
            allInt = false; allNum = false; break;
        }
        let type = T.VAR_STRING;
        if (any && allInt) type = T.LONGLONG; else if (any && allNum) type = T.DOUBLE;
        return { name: String(name === undefined || name === null ? '' : name), type };
    });
}
function colDef(c, dbName) {
    const num = c.type !== T.VAR_STRING;
    return Buffer.concat([
        lenStr('def'), lenStr(dbName || ''), lenStr(''), lenStr(''), lenStr(c.name), lenStr(c.name),
        Buffer.from([0x0c]), u16(num ? 63 : 45), u32(c.type === T.VAR_STRING ? 262140 : (c.type === T.DOUBLE ? 22 : 20)),
        Buffer.from([c.type]), u16(num ? 0x80 : 0), Buffer.from([c.type === T.DOUBLE ? 31 : 0]), Buffer.from([0, 0]),
    ]);
}
function toText(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') return v;
    if (Buffer.isBuffer(v)) return v;
    if (typeof v === 'boolean') return v ? '1' : '0';
    if (v instanceof Date) return fmtDate(v);
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
}

/* ------------------------------------------------------------------ prepared statement param decoding */
function readTemporal(r, type) {
    const len = r.u8();
    if (len === 0) return type === T.DATE ? '0000-00-00' : '0000-00-00 00:00:00';
    const y = r.u16(), mo = r.u8(), d = r.u8();
    let h = 0, mi = 0, s = 0, us = 0;
    if (len >= 7) { h = r.u8(); mi = r.u8(); s = r.u8(); }
    if (len >= 11) us = r.u32();
    let out = `${pad(y, 4)}-${pad(mo)}-${pad(d)}`;
    if (type !== T.DATE) { out += ` ${pad(h)}:${pad(mi)}:${pad(s)}`; if (us) out += '.' + String(us).padStart(6, '0'); }
    return out;
}
function readParam(r, type, unsigned) {
    switch (type) {
        case T.NULL: return null;
        case T.TINY: return unsigned ? r.u8() : r.i8();
        case T.SHORT: case T.YEAR: return unsigned ? r.u16() : r.i16();
        case T.LONG: case T.INT24: return unsigned ? r.u32() : r.i32();
        case T.LONGLONG: { const v = unsigned ? r.u64() : r.i64(); return (v >= -9007199254740991n && v <= 9007199254740991n) ? Number(v) : v.toString(); }
        case T.FLOAT: return Number(r.f32().toPrecision(7));
        case T.DOUBLE: return r.f64();
        case T.DATE: case T.DATETIME: case T.TIMESTAMP: return readTemporal(r, type);
        case T.TIME: {
            const len = r.u8(); if (len === 0) return '00:00:00';
            const neg = r.u8(), days = r.u32(), h = r.u8(), mi = r.u8(), s = r.u8(); let us = 0; if (len >= 12) us = r.u32();
            return `${neg ? '-' : ''}${pad(days * 24 + h)}:${pad(mi)}:${pad(s)}${us ? '.' + String(us).padStart(6, '0') : ''}`;
        }
        default: { const b = r.lenBytes(); return b === null ? null : b.toString('utf8'); }
    }
}

/* ------------------------------------------------------------------ connection */
class Conn {
    constructor(srv, sock, id) {
        this.srv = srv; this.sock = sock; this.id = id;
        this.buf = Buffer.alloc(0); this.pending = []; this.pendingSize = 0;
        this.state = 'auth'; this.seq = 0; this.out = [];
        this.salt = crypto.randomBytes(20); for (let i = 0; i < 20; i++) if (this.salt[i] === 0 || this.salt[i] === 0x24) this.salt[i] = 0x41 + (i % 20);
        this.caps = 0; this.user = ''; this.stmts = new Map(); this.nextStmt = 1; this.chain = Promise.resolve(); this.closed = false;
        this.switched = false; this.hasTx = false;
        sock.setNoDelay(true);
        sock.on('data', (d) => this.onData(d));
        sock.on('error', () => { /* handled by close */ });
        sock.on('close', () => this.onClose());
        this.sendHandshake();
    }
    /* ----- framing ----- */
    onData(d) {
        this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
        while (this.buf.length >= 4) {
            const len = this.buf.readUIntLE(0, 3);
            if (this.buf.length < 4 + len) break;
            const seq = this.buf[3];
            const body = this.buf.subarray(4, 4 + len);
            this.buf = this.buf.subarray(4 + len);
            this.pending.push(body); this.pendingSize += len;
            if (this.pendingSize > MAX_PACKET_TOTAL) { this.sock.destroy(); return; }
            if (len === 0xffffff) continue;
            const payload = this.pending.length === 1 ? this.pending[0] : Buffer.concat(this.pending);
            this.pending = []; this.pendingSize = 0;
            this.seq = (seq + 1) & 0xff;
            if (this.state === 'auth') this.onAuth(payload);
            else this.chain = this.chain.then(() => this.onCommand(payload)).catch((e) => { this.srv.log('error', 'connection error: ' + (e && e.message || e)); try { this.err(1105, 'HY000', 'Internal error: ' + (e && e.message || e)); this.flush(); } catch (x) { /* ignore */ } });
        }
    }
    send(payload) {
        let off = 0;
        for (;;) {
            const n = Math.min(0xffffff, payload.length - off);
            const h = Buffer.allocUnsafe(4); h.writeUIntLE(n, 0, 3); h[3] = this.seq; this.seq = (this.seq + 1) & 0xff;
            this.out.push(h, payload.subarray(off, off + n)); off += n;
            if (n < 0xffffff) break;
        }
    }
    flush() { if (this.out.length && !this.closed && !this.sock.destroyed) this.sock.write(Buffer.concat(this.out)); this.out = []; }
    status(more) { return ST.AUTOCOMMIT | (this.srv.db.txSnap && this.srv.txOwner === this ? ST.IN_TRANS : 0) | (more ? ST.MORE : 0); }
    ok(affected, insertId, more, info) {
        this.send(Buffer.concat([Buffer.from([0]), lenInt(affected || 0), lenInt(insertId || 0), u16(this.status(more)), u16(0), info ? Buffer.from(String(info)) : Buffer.alloc(0)]));
    }
    eof(more) { this.send(Buffer.concat([Buffer.from([0xfe]), u16(0), u16(this.status(more))])); }
    err(code, state, msg) { this.send(Buffer.concat([Buffer.from([0xff]), u16(code), Buffer.from('#' + state), Buffer.from(String(msg), 'utf8')])); }
    /* ----- handshake / auth ----- */
    sendHandshake() {
        this.seq = 0;
        const p = Buffer.concat([
            Buffer.from([10]), Buffer.from(SERVER_VERSION + '\0'), u32(this.id), this.salt.subarray(0, 8), Buffer.from([0]),
            u16(SERVER_CAPS & 0xffff), Buffer.from([45]), u16(ST.AUTOCOMMIT), u16(SERVER_CAPS >>> 16), Buffer.from([21]), Buffer.alloc(10),
            this.salt.subarray(8, 20), Buffer.from([0]), Buffer.from('mysql_native_password\0'),
        ]);
        this.send(p); this.flush();
    }
    checkToken(token) {
        const pw = String(this.srv.db.settings.password || '');
        if (!token || token.length !== 20) return pw === '' && (!token || token.length === 0);
        const s1 = sha1(Buffer.from(pw, 'utf8')), s2 = sha1(s1);
        const expect = xor(s1, sha1(this.salt, s2));
        return crypto.timingSafeEqual(expect, token);
    }
    deny(msg) { this.err(1045, '28000', msg || `Access denied for user '${this.user}'@'${this.sock.remoteAddress || 'localhost'}' (using password: YES)`); this.flush(); this.sock.end(); }
    onAuth(p) {
        try {
            if (this.switched) { // reply to AuthSwitchRequest
                if (!this.checkToken(p)) return this.deny();
                return this.authOk();
            }
            const r = new Reader(p);
            if (p.length < 32) return this.deny('Bad handshake');
            this.caps = r.u32(); r.u32(); r.u8(); r.bytes(23);
            this.user = r.cstr();
            let token;
            if (this.caps & CAP.PLUGIN_AUTH_LENENC) token = r.lenBytes() || Buffer.alloc(0);
            else if (this.caps & CAP.SECURE_CONNECTION) { const n = r.u8(); token = r.bytes(n); }
            else token = Buffer.from(r.cstr(), 'latin1');
            this.db = null;
            if ((this.caps & CAP.CONNECT_WITH_DB) && r.left > 0) this.db = r.cstr();
            let plugin = 'mysql_native_password';
            if ((this.caps & CAP.PLUGIN_AUTH) && r.left > 0) plugin = r.cstr();
            const S = this.srv.db.settings;
            if (this.user !== S.user) return this.deny();
            if (plugin !== 'mysql_native_password') {
                this.switched = true;
                this.send(Buffer.concat([Buffer.from([0xfe]), Buffer.from('mysql_native_password\0'), this.salt, Buffer.from([0])])); this.flush();
                return;
            }
            if (!this.checkToken(token)) return this.deny();
            if (this.db && this.db.toLowerCase() !== String(S.dbName).toLowerCase()) { this.err(1049, '42000', `Unknown database '${this.db}'`); this.flush(); return this.sock.end(); }
            this.authOk();
        } catch (e) { this.srv.log('error', 'auth error: ' + e.message); this.deny('Bad handshake'); }
    }
    authOk() { this.state = 'cmd'; this.ok(0, 0, false); this.flush(); this.srv.totalConns++; }
    onClose() {
        this.closed = true; this.srv.conns.delete(this);
        try { this.srv.releaseOnClose(this); } catch (e) { /* ignore */ }
    }
    /* ----- commands ----- */
    async onCommand(p) {
        if (this.closed) return;
        const cmd = p[0], r = new Reader(p, 1);
        switch (cmd) {
            case 0x01: this.sock.end(); return;                                   // COM_QUIT
            case 0x02: {                                                           // COM_INIT_DB
                const name = r.rest().toString('utf8');
                if (name.toLowerCase() !== String(this.srv.db.settings.dbName).toLowerCase()) this.err(1049, '42000', `Unknown database '${name}'`); else this.ok(0, 0, false);
                break;
            }
            case 0x03: await this.comQuery(r.rest().toString('utf8')); break;       // COM_QUERY
            case 0x04: this.eof(false); break;                                      // COM_FIELD_LIST
            case 0x09: this.send(Buffer.from(`Uptime: ${Math.round((Date.now() - this.srv.db.stats.started) / 1000)}  Threads: ${this.srv.conns.size}  Questions: ${this.srv.db.stats.queries}`)); break;
            case 0x0e: this.ok(0, 0, false); break;                                 // COM_PING
            case 0x16: this.comPrepare(r.rest().toString('utf8')); break;           // COM_STMT_PREPARE
            case 0x17: await this.comExecute(r); break;                             // COM_STMT_EXECUTE
            case 0x18: { const id = r.u32(), pid = r.u16(), st = this.stmts.get(id); if (st) { st.long = st.long || {}; st.long[pid] = Buffer.concat([st.long[pid] || Buffer.alloc(0), r.rest()]); } return; } // LONG_DATA: no reply
            case 0x19: this.stmts.delete(r.u32()); return;                          // COM_STMT_CLOSE: no reply
            case 0x1a: { const st = this.stmts.get(r.u32()); if (st) st.long = {}; this.ok(0, 0, false); break; } // COM_STMT_RESET
            case 0x1b: this.eof(false); break;                                      // COM_SET_OPTION
            case 0x1f: this.stmts.clear(); this.ok(0, 0, false); break;            // COM_RESET_CONNECTION
            default: this.err(1047, '08S01', 'Unknown command'); break;
        }
        this.flush();
    }
    async run(sql, params) {
        const srv = this.srv;
        await srv.acquire(this);
        try {
            const sh = shim(sql, srv);
            if (sh) return { results: sh };
            try { return { results: srv.db.exec(sql, params, {}) }; }
            catch (e) { return { results: e.results || [], error: e }; }
        } finally { srv.afterExec(this); }
    }
    sendError(e) {
        const msg = e && e.message || String(e);
        const [code, state] = (e && e.name === 'SQLError') || (e && e.constructor && e.constructor.name === 'SQLError') ? mapError(msg) : [1105, 'HY000'];
        this.err(code, state, msg);
    }
    sendResults(results, error, binary) {
        const total = results.length;
        results.forEach((res, i) => {
            const more = i < total - 1 || !!error;
            if (res.type === 'rows') this.sendRows(res, binary, more);
            else if (res.type === 'error') this.sendError({ message: res.error, name: 'SQLError' });
            else this.ok(res.affected || 0, res.insertId || 0, more, res.message && res.message.length < 200 ? '' : '');
        });
        if (error) this.sendError(error);
    }
    sendRows(res, binary, more) {
        let columns = res.columns || [], rows = res.rows || [];
        if (!columns.length) { // empty column list (e.g. SHOW VARIABLES on bare engine) -> still need a valid resultset
            columns = ['Variable_name', 'Value']; rows = [];
        }
        const defs = inferColumns(columns, rows);
        this.send(lenInt(defs.length));
        for (const d of defs) this.send(colDef(d, this.srv.db.settings.dbName));
        this.eof(false);
        const nb = (defs.length + 7 + 2) >> 3;
        for (const row of rows) {
            if (!binary) {
                const parts = [];
                for (let i = 0; i < defs.length; i++) {
                    const v = toText(row[i]);
                    parts.push(v === null ? Buffer.from([0xfb]) : lenStr(v));
                }
                this.send(Buffer.concat(parts));
            } else {
                const bitmap = Buffer.alloc(nb), parts = [];
                for (let i = 0; i < defs.length; i++) {
                    const v = row[i], t = defs[i].type;
                    if (v === null || v === undefined) { bitmap[(i + 2) >> 3] |= 1 << ((i + 2) & 7); continue; }
                    if (t === T.LONGLONG) { const b = Buffer.alloc(8); b.writeBigInt64LE(typeof v === 'bigint' ? v : BigInt(typeof v === 'boolean' ? (v ? 1 : 0) : v)); parts.push(b); }
                    else if (t === T.DOUBLE) { const b = Buffer.alloc(8); b.writeDoubleLE(typeof v === 'boolean' ? (v ? 1 : 0) : Number(v)); parts.push(b); }
                    else parts.push(lenStr(toText(v)));
                }
                this.send(Buffer.concat([Buffer.from([0]), bitmap, ...parts]));
            }
        }
        this.eof(more);
    }
    async comQuery(sql) {
        const { results, error } = await this.run(sql, []);
        if (!results.length && error) this.sendError(error); else this.sendResults(results, error, false);
    }
    comPrepare(sql) {
        const n = countPlaceholders(sql);
        const id = this.nextStmt++;
        this.stmts.set(id, { sql, n, types: null, long: {} });
        this.send(Buffer.concat([Buffer.from([0]), u32(id), u16(0), u16(n), Buffer.from([0]), u16(0)]));
        if (n > 0) {
            for (let i = 0; i < n; i++) this.send(colDef({ name: '?', type: T.VAR_STRING }, ''));
            this.eof(false);
        }
    }
    async comExecute(r) {
        const id = r.u32(); r.u8(); r.u32();
        const st = this.stmts.get(id);
        if (!st) { this.err(1243, 'HY000', 'Unknown prepared statement handler (' + id + ') given to mysqld_stmt_execute'); return; }
        const params = [];
        if (st.n > 0) {
            const nbm = (st.n + 7) >> 3, bm = r.bytes(nbm), bound = r.u8();
            if (bound === 1) { st.types = []; for (let i = 0; i < st.n; i++) { const t = r.u8(), f = r.u8(); st.types.push({ t, u: !!(f & 0x80) }); } }
            if (!st.types) { this.err(1210, 'HY000', 'Incorrect arguments to mysqld_stmt_execute'); return; }
            for (let i = 0; i < st.n; i++) {
                if (bm[i >> 3] & (1 << (i & 7))) { params.push(null); continue; }
                if (st.long && st.long[i] !== undefined) { params.push(st.long[i].toString('utf8')); continue; }
                params.push(readParam(r, st.types[i].t, st.types[i].u));
            }
            st.long = {};
        }
        const { results, error } = await this.run(st.sql, params);
        if (!results.length && error) this.sendError(error); else this.sendResults(results.slice(0, 1), error, true);
    }
}

/* ------------------------------------------------------------------ server */
class MySQLServer {
    constructor(db, opts = {}) {
        this.db = db; this.log = opts.log || (() => {});
        this.server = null; this.bound = null; this.conns = new Set(); this.nextId = 1; this.totalConns = 0;
        this.txOwner = null; this.waiters = []; this.lastError = null; this.reported = {};
    }
    /* global transaction lock: DBEngine keeps one snapshot, so a transaction is exclusive */
    async acquire(conn) {
        const t0 = Date.now();
        while (this.txOwner && this.txOwner !== conn && this.db.txSnap) {
            if (Date.now() - t0 > LOCK_WAIT_MS) { const e = new Error('Lock wait timeout exceeded; try restarting transaction'); e.name = 'SQLError'; throw e; }
            await new Promise((res) => { const w = { res }; this.waiters.push(w); setTimeout(() => { const i = this.waiters.indexOf(w); if (i >= 0) { this.waiters.splice(i, 1); res(); } }, 500); });
        }
        if (this.txOwner && !this.db.txSnap) this.txOwner = null;
    }
    afterExec(conn) {
        if (this.db.txSnap) { if (!this.txOwner) this.txOwner = conn; }
        else if (this.txOwner) this.txOwner = null;
        if (!this.txOwner && this.waiters.length) { const w = this.waiters.splice(0); w.forEach((x) => x.res()); }
    }
    releaseOnClose(conn) {
        if (this.txOwner === conn) {
            if (this.db.txSnap) { try { this.db.restore(this.db.txSnap); } catch (e) { /* ignore */ } this.db.txSnap = null; }
            this.txOwner = null;
            const w = this.waiters.splice(0); w.forEach((x) => x.res());
        }
    }
    start() {
        const S = this.db.settings;
        const want = `${S.host}:${S.port}`;
        if (this.server && this.bound === want) return;
        if (this.server) this.stop();
        const srv = net.createServer((sock) => { const c = new Conn(this, sock, this.nextId++); this.conns.add(c); });
        srv.on('error', (e) => {
            this.lastError = e.code || e.message; this.server = null; this.bound = null;
            if (!this.reported[this.lastError + want]) {
                this.reported[this.lastError + want] = true;
                if (e.code === 'EADDRINUSE') this.log('warn', `Cannot listen on ${want}: port already in use (another MySQL/MariaDB is running?). Stop it or change the port in the Database page. Will retry automatically.`);
                else this.log('error', `MySQL protocol server error on ${want}: ${e.message}`);
            }
        });
        srv.listen({ host: S.host, port: S.port }, () => {
            this.lastError = null; this.reported = {};
            this.log('info', `MySQL protocol server listening on ${want} (db "${S.dbName}", user "${S.user}"). oxmysql can now connect.`);
        });
        this.server = srv; this.bound = want;
    }
    stop() {
        if (this.server) { try { this.server.close(); } catch (e) { /* ignore */ } }
        for (const c of this.conns) { try { c.sock.destroy(); } catch (e) { /* ignore */ } }
        this.conns.clear(); this.server = null; this.bound = null;
    }
    /* called periodically: re-bind if host/port were changed in the panel, retry if bind failed earlier */
    sync() { this.start(); }
    status() {
        return { listening: !!(this.server && this.server.listening), bound: this.bound, connections: this.conns.size, total: this.totalConns, error: this.lastError };
    }
}

module.exports = MySQLServer;
module.exports.mapError = mapError;
module.exports.countPlaceholders = countPlaceholders;
