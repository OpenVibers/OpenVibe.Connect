'use strict';

/**
 * The tunnel's wire format, `ovconnect-ws/1`: one WebSocket per connected share, many requests at once over it.
 *
 * Text frames are JSON control messages:
 *   client → server  { t: 'hello', key, v: 1, client, port }
 *   server → client  { t: 'ready', v: 1, share: { id, host, url, mode } }   or   { t: 'error', code, message } then close
 *   server → client  { t: 'req', id, method, path, headers: [[name, value], …] }   an HTTP request
 *   server → client  { t: 'raw', id, head }                                       a WebSocket upgrade: the client
 *                     opens a plain TCP connection to the local port, writes `head`, and from then on both sides
 *                     only move bytes (the local server answers the 101 itself)
 *   client → server  { t: 'res', id, status, headers: [[name, value], …] }        the response head
 *   either way       { t: 'pause', id } / { t: 'resume', id }                     backpressure on one stream
 *   either way       { t: 'abort', id, code, message }                            the stream is over, badly
 *
 * Binary frames carry bodies: [kind: 1 byte][stream id: 4 bytes, big-endian][payload].
 *   kind 1  data   kind 2  end (no payload)
 *
 * Stream ids are chosen by the server (1, 2, 3 …) and never reused on one tunnel.
 */
const KIND = { DATA: 1, END: 2 };
const VERSION = 1;
const PROTOCOL = 'ovconnect-ws/1';

function encode(kind, id, payload) {
    const body = payload ? (Buffer.isBuffer(payload) ? payload : Buffer.from(payload)) : Buffer.alloc(0);
    const out = Buffer.allocUnsafe(5 + body.length);
    out.writeUInt8(kind, 0);
    out.writeUInt32BE(id >>> 0, 1);
    body.copy(out, 5);
    return out;
}

function decode(buf) {
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    if (b.length < 5) return null;
    const kind = b.readUInt8(0);
    if (kind !== KIND.DATA && kind !== KIND.END) return null;
    return { kind, id: b.readUInt32BE(1), payload: b.subarray(5) };
}

/** Header pairs as sent on the wire: lowercase names, string values, nothing longer than 16 KB in all. */
function headerPairs(rawHeaders) {
    const out = [];
    let size = 0;
    for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
        const name = String(rawHeaders[i]).toLowerCase();
        const value = String(rawHeaders[i + 1]);
        size += name.length + value.length;
        if (size > 64 * 1024) break;
        out.push([name, value]);
    }
    return out;
}

module.exports = { KIND, VERSION, PROTOCOL, encode, decode, headerPairs };
