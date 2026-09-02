'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    ADDRESS_LENGTH, CHANNEL_LENGTH, COMMAND_LENGTH, FRAME_LENGTH, RX_FRAME_LENGTH,
    completeFrame, describeFrame,
    CHANNEL_ALL, CHANNEL_NUMBERS, COMMAND_CODES, COMMAND_NAMES,
    plainByte, complementedByte, toBits, fromBits,
    buildFrame, identifyFrame, sameAddress,
} = require('../drivers/blind/bear-protocol');

// A stand-in address of the right length, so these exercise the field split
// rather than one particular handset. The real one is covered by captures.test.js.
const ADDRESS = Array.from({ length: ADDRESS_LENGTH }, (_, i) => i % 2);
const ALL_CHANNELS = [CHANNEL_ALL, ...CHANNEL_NUMBERS];

test('the frame is 28 address + 4 channel + 8 command bits', () => {
    assert.equal(ADDRESS_LENGTH, 28);
    assert.equal(CHANNEL_LENGTH, 4);
    assert.equal(COMMAND_LENGTH, 8);
    assert.equal(FRAME_LENGTH, 40);
    assert.deepEqual(CHANNEL_NUMBERS, [1, 2, 3, 4, 5]);
    assert.deepEqual(COMMAND_NAMES.slice().sort(), ['down', 'stop', 'up']);
});

test('bit conversion round-trips', () => {
    assert.deepEqual(toBits(0b0101, 4), [0, 1, 0, 1]);
    assert.deepEqual(toBits(0x55, 8), [0, 1, 0, 1, 0, 1, 0, 1]);
    for (const value of [0, 1, 5, 0x1E, 0xFF, 0xFFFFFFF]) {
        assert.equal(fromBits(toBits(value, 28)), value);
    }
});

test('the command byte repeats the nibble, plain or complemented', () => {
    // Both forms come off the handset; the captures show four of each per press.
    assert.equal(plainByte(COMMAND_CODES.up), 0x11);
    assert.equal(complementedByte(COMMAND_CODES.up), 0x1E);
    assert.equal(plainByte(COMMAND_CODES.down), 0x33);
    assert.equal(complementedByte(COMMAND_CODES.down), 0x3C);
    assert.equal(plainByte(COMMAND_CODES.stop), 0x55);
    assert.equal(complementedByte(COMMAND_CODES.stop), 0x5A);
});

test('sameAddress', async (t) => {
    await t.test('matches identical addresses', () => {
        assert.equal(sameAddress([1, 0, 1], [1, 0, 1]), true);
    });

    await t.test('rejects a different address, a prefix, and a non-array', () => {
        assert.equal(sameAddress([1, 0, 1], [1, 0, 0]), false);
        assert.equal(sameAddress([1, 0, 1], [1, 0]), false);
        assert.equal(sameAddress([1, 0, 1], null), false);
        assert.equal(sameAddress(undefined, [1, 0, 1]), false);
    });
});

test('a built frame identifies back as what went into it', () => {
    for (const channel of ALL_CHANNELS) {
        for (const command of COMMAND_NAMES) {
            const frame = buildFrame(ADDRESS, channel, command);
            assert.equal(frame.length, FRAME_LENGTH, `ch${channel}.${command} length`);
            assert.deepEqual(identifyFrame(frame), { address: ADDRESS, channel, command });
        }
    }
});

test('the complemented form of every command is received too', () => {
    // Half of every press arrives in this form. Rejecting it would make Homey
    // follow the handset only intermittently.
    for (const channel of ALL_CHANNELS) {
        for (const command of COMMAND_NAMES) {
            const frame = [
                ...ADDRESS,
                ...toBits(channel, CHANNEL_LENGTH),
                ...toBits(complementedByte(COMMAND_CODES[command]), COMMAND_LENGTH),
            ];
            assert.deepEqual(identifyFrame(frame), { address: ADDRESS, channel, command });
        }
    }
});

test('a frame arrives one symbol short, and the missing bit is recovered', async (t) => {
    // Homey never closes the final word, because that bit's gap on air is the
    // gap to the next frame. Every received frame therefore arrives as 39
    // symbols; rejecting those would mean receiving nothing at all.
    await t.test('every channel and button, in both byte forms', () => {
        for (const channel of ALL_CHANNELS) {
            for (const command of COMMAND_NAMES) {
                for (const byte of [plainByte(COMMAND_CODES[command]),
                    complementedByte(COMMAND_CODES[command])]) {
                    const sent = [
                        ...ADDRESS,
                        ...toBits(channel, CHANNEL_LENGTH),
                        ...toBits(byte, COMMAND_LENGTH),
                    ];
                    const received = sent.slice(0, RX_FRAME_LENGTH);

                    assert.equal(received.length, 39);
                    assert.deepEqual(completeFrame(received), sent, `ch${channel} ${command} 0x${byte.toString(16)}`);
                    assert.deepEqual(identifyFrame(received), { address: ADDRESS, channel, command });
                }
            }
        }
    });

    await t.test('the completion is never ambiguous', () => {
        // A nibble and its complement differ in every position, so at most one
        // of the two candidate last bits can produce a valid byte.
        for (const command of COMMAND_NAMES) {
            for (const byte of [plainByte(COMMAND_CODES[command]),
                complementedByte(COMMAND_CODES[command])]) {
                const head = [...ADDRESS, ...toBits(1, CHANNEL_LENGTH), ...toBits(byte, COMMAND_LENGTH)]
                    .slice(0, RX_FRAME_LENGTH);
                const valid = [0, 1].filter((last) => {
                    const frame = [...head, last];
                    const b = fromBits(frame.slice(ADDRESS_LENGTH + CHANNEL_LENGTH));
                    return b === plainByte(b >> 4) || b === complementedByte(b >> 4);
                });
                assert.equal(valid.length, 1, `0x${byte.toString(16)} has ${valid.length} completions`);
            }
        }
    });

    await t.test('a 39-symbol tail that completes to nothing valid is rejected', () => {
        const head = [...ADDRESS, ...toBits(1, CHANNEL_LENGTH), ...toBits(0b0010011, 7)];
        assert.equal(head.length, RX_FRAME_LENGTH);
        assert.equal(completeFrame(head), null);
        assert.equal(identifyFrame(head), null);
    });
});

test('identifyFrame rejects anything that is not one of our frames', async (t) => {
    await t.test('wrong shape', () => {
        assert.equal(identifyFrame(null), null);
        assert.equal(identifyFrame(undefined), null);
        assert.equal(identifyFrame('0,1,0'), null);
        assert.equal(identifyFrame([]), null);
        assert.equal(identifyFrame(Array(FRAME_LENGTH - 2).fill(0)), null);
        assert.equal(identifyFrame(Array(FRAME_LENGTH + 1).fill(1)), null);
        // 39 is a real length, but all-zero completes to byte 0x00, code 0.
        assert.equal(identifyFrame(Array(RX_FRAME_LENGTH).fill(0)), null);
        assert.equal(identifyFrame(Array(FRAME_LENGTH).fill(2)), null);
    });

    await t.test('unknown channel', () => {
        for (const channel of [6, 9, 15]) {
            const frame = [
                ...ADDRESS,
                ...toBits(channel, CHANNEL_LENGTH),
                ...toBits(plainByte(COMMAND_CODES.up), COMMAND_LENGTH),
            ];
            assert.equal(identifyFrame(frame), null, `channel ${channel}`);
        }
    });

    await t.test('unknown command nibble', () => {
        for (const code of [0x0, 0x2, 0x7, 0xF]) {
            const frame = [
                ...ADDRESS, ...toBits(1, CHANNEL_LENGTH), ...toBits(plainByte(code), COMMAND_LENGTH),
            ];
            assert.equal(identifyFrame(frame), null, `code ${code}`);
        }
    });

    await t.test('command byte whose halves disagree', () => {
        // 0x13 is neither 0x11 nor 0x1E, so it is noise that happened to land on
        // a valid length and channel.
        const frame = [...ADDRESS, ...toBits(1, CHANNEL_LENGTH), ...toBits(0x13, COMMAND_LENGTH)];
        assert.equal(identifyFrame(frame), null);
    });
});

test('buildFrame refuses input it cannot encode', () => {
    assert.throws(() => buildFrame(ADDRESS.slice(1), 1, 'up'), /Bad address/);
    assert.throws(() => buildFrame(null, 1, 'up'), /Bad address/);
    assert.throws(() => buildFrame(ADDRESS, 6, 'up'), /Unknown channel/);
    assert.throws(() => buildFrame(ADDRESS, -1, 'up'), /Unknown channel/);
    assert.throws(() => buildFrame(ADDRESS, '1', 'up'), /Unknown channel/);
    assert.throws(() => buildFrame(ADDRESS, 1, 'sideways'), /Unknown command/);
});

test('describeFrame names the field that failed', () => {
    // Two rounds of this were decoded by hand off a log line. It says which
    // check failed so an unimplemented button, a foreign channel and a decoding
    // bug are distinguishable at a glance.
    const frame = (channel, byte) => [
        ...ADDRESS, ...toBits(channel, CHANNEL_LENGTH), ...toBits(byte, COMMAND_LENGTH),
    ];

    // Pressing up and down together: a well-formed frame carrying code 0x7,
    // which this app does not implement.
    assert.match(describeFrame(frame(1, 0x78).slice(0, RX_FRAME_LENGTH)),
        /ch1 code 0x7 .* unimplemented command/);
    assert.equal(identifyFrame(frame(1, 0x78).slice(0, RX_FRAME_LENGTH)), null);

    assert.match(describeFrame(frame(15, 0x11)), /ch15 .* unknown channel/);
    assert.match(describeFrame(frame(1, 0x13)), /neither a repeated nor a complemented nibble/);
    assert.match(describeFrame(Array(4).fill(0)), /4 symbols, expected 39 or 40/);
    assert.equal(describeFrame(null), 'not an array');
    assert.equal(describeFrame(Array(FRAME_LENGTH).fill(2)), 'not bits');

    // A frame that does identify still describes cleanly, with nothing flagged.
    assert.equal(describeFrame(frame(2, 0x33)), 'ch2 code 0x3');
});
