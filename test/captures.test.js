'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseCaptures, decodeCapture } = require('../tools/decoder');
const {
    FRAME_LENGTH, CHANNEL_ALL, buildFrame, identifyFrame, plainByte, complementedByte,
    COMMAND_CODES, fromBits, ADDRESS_LENGTH, CHANNEL_LENGTH,
} = require('../drivers/blind/bear-protocol');

// Real recordings from the handset, decoded on every run. This is what ties the
// shipped tables back to the hardware: change a timing window or a command code
// and these stop matching.
//
// The file carries the address that operates the blinds, so it is deliberately
// not committed (see .gitignore and RF_PROTOCOL.md). Everyone else's `npm test`
// skips this file rather than failing on its absence.
const CAPTURES = path.join(__dirname, '..', 'captures', 'raw-captures.txt');
const skip = fs.existsSync(CAPTURES)
    ? false
    : 'captures/raw-captures.txt not present (it is not committed — see RF_PROTOCOL.md)';

const blocks = skip ? [] : parseCaptures(fs.readFileSync(CAPTURES, 'utf8'));

// "Ch 3 Down" / "All Up" -> { channel, command }.
function expected(label) {
    const m = label.match(/^(?:Ch (\d)|All)\s+(up|down|stop)$/i);
    assert.ok(m, `capture label "${label}" is not in the "Ch <n> <button>" form`);
    return { channel: m[1] === undefined ? CHANNEL_ALL : Number(m[1]), command: m[2].toLowerCase() };
}

// The handset transmits four frames with the command nibble plain, then four
// with it complemented.
const bothForms = code => [plainByte(code), complementedByte(code)];

const fullFrames = block => decodeCapture(block.durations).frames.filter(f => f.length === FRAME_LENGTH);

test('the captures cover every channel and button', { skip }, () => {
    assert.equal(blocks.length, 18);
    assert.deepEqual(
        blocks.map(b => b.label.toLowerCase()),
        ['1', '2', '3', '4', '5', 'all'].flatMap(c => ['up', 'down', 'stop']
            .map(b => (c === 'all' ? `all ${b}` : `ch ${c} ${b}`))),
    );
});

for (const block of blocks) {
    const want = expected(block.label);

    test(`${block.label} decodes to ch${want.channel} ${want.command}`, () => {
        const frames = fullFrames(block);
        assert.ok(frames.length >= 1, `no clean ${FRAME_LENGTH}-bit frame in the capture`);

        const code = COMMAND_CODES[want.command];
        const address = frames[0].slice(0, ADDRESS_LENGTH);

        for (const frame of frames) {
            assert.deepEqual(identifyFrame(frame), {
                address,
                channel: want.channel,
                command: want.command,
            });

            // Beyond identifyFrame: the frame is exactly the documented layout.
            assert.deepEqual(frame.slice(0, ADDRESS_LENGTH), address, 'address is constant');
            assert.equal(
                fromBits(frame.slice(ADDRESS_LENGTH, ADDRESS_LENGTH + CHANNEL_LENGTH)),
                want.channel,
            );
            assert.ok(
                bothForms(code).includes(fromBits(frame.slice(ADDRESS_LENGTH + CHANNEL_LENGTH))),
                'command byte is the nibble plain or complemented',
            );
        }
    });
}

test('every capture carries the same address', { skip }, () => {
    const addresses = new Set();
    for (const block of blocks) {
        for (const frame of fullFrames(block)) addresses.add(frame.slice(0, ADDRESS_LENGTH).join(''));
    }
    assert.equal(addresses.size, 1, `expected one handset address, got ${addresses.size}`);
});

test('buildFrame reproduces the frames the handset actually sent', { skip }, () => {
    // The decisive check: what the app transmits is bit-for-bit what was
    // recorded off the remote, for every channel and button it can send.
    const covered = new Set();
    for (const block of blocks) {
        for (const frame of fullFrames(block)) {
            const { address, channel, command } = identifyFrame(frame);
            const byte = fromBits(frame.slice(ADDRESS_LENGTH + CHANNEL_LENGTH));
            // Only the plain form is transmitted, so only it has to round-trip.
            if (byte !== plainByte(COMMAND_CODES[command])) continue;
            covered.add(`${channel}.${command}`);
            assert.deepEqual(buildFrame(address, channel, command), frame);
        }
    }

    assert.equal(covered.size, 18, `covered ${covered.size} of 18 channel/button pairs`);
});

test('both byte forms appear in the recordings', { skip }, () => {
    // If this ever fails, the burst structure documented in RF_PROTOCOL.md is
    // wrong, and receiving would silently start missing half of every press.
    const forms = new Set();
    for (const block of blocks) {
        for (const frame of fullFrames(block)) {
            forms.add(fromBits(frame.slice(ADDRESS_LENGTH + CHANNEL_LENGTH)));
        }
    }
    assert.ok(forms.has(plainByte(COMMAND_CODES.up)), 'plain UP');
    assert.ok(forms.has(complementedByte(COMMAND_CODES.up)), 'complemented UP');
    assert.ok(forms.has(plainByte(COMMAND_CODES.down)), 'plain DOWN');
    assert.ok(forms.has(complementedByte(COMMAND_CODES.down)), 'complemented DOWN');
});
