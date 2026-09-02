'use strict';

// Bear 5-channel blind remote. See RF_PROTOCOL.md for how this was decoded.
//
// Frames are 40 bits, transmitted as plain binary (two symbols), and split into
// three fields:
//
//   [ 0..27 ]  address  identifies the handset, identical across every button
//                       and every channel
//   [ 28..31 ] channel  0 for the handset's ALL position, 1-5 for the channels
//   [ 32..39 ] command  the button, as a nibble repeated twice
//
// A device stores its address and channel once at pair time, and transmits
// address + channel + command for each action.

const SIGNAL_ID = 'bear';

const ADDRESS_LENGTH = 28;
const CHANNEL_LENGTH = 4;
const COMMAND_LENGTH = 8;
const FRAME_LENGTH = ADDRESS_LENGTH + CHANNEL_LENGTH + COMMAND_LENGTH;

// The handset's ALL position, which drives every channel at once. Not a device
// of its own, but pressing it must still update all five.
const CHANNEL_ALL = 0;
const CHANNEL_NUMBERS = [1, 2, 3, 4, 5];

// The command nibble, keyed by the name used throughout the app.
const COMMAND_CODES = {
    up: 0b0001,
    down: 0b0011,
    stop: 0b0101,
};
const COMMAND_NAMES = Object.keys(COMMAND_CODES);
const COMMAND_BY_CODE = new Map(Object.entries(COMMAND_CODES).map(([name, code]) => [code, name]));

const nibble = code => code & 0xF;

// The command byte carries the nibble twice, and the handset sends it in two
// forms: plain, then complemented. Each press is four frames of one followed by
// four of the other, so receiving has to accept both. Transmitting uses the
// plain form — see RF_PROTOCOL.md on why one form is enough.
const plainByte = code => (nibble(code) << 4) | nibble(code);
const complementedByte = code => (nibble(code) << 4) | nibble(~code);

const toBits = (value, width) => Array.from({ length: width }, (_, i) => (value >> (width - 1 - i)) & 1);
const fromBits = bits => bits.reduce((value, bit) => (value << 1) | bit, 0);

// Builds the frame to transmit for one button press on one channel.
function buildFrame(address, channel, command) {
    if (!Array.isArray(address) || address.length !== ADDRESS_LENGTH) {
        throw new Error(`Bad address: ${JSON.stringify(address)}`);
    }
    if (!Number.isInteger(channel) || channel < CHANNEL_ALL || channel > 5) {
        throw new Error(`Unknown channel: ${channel}`);
    }
    const code = COMMAND_CODES[command];
    if (code === undefined) {
        throw new Error(`Unknown command: ${command}`);
    }

    return [
        ...address,
        ...toBits(channel, CHANNEL_LENGTH),
        ...toBits(plainByte(code), COMMAND_LENGTH),
    ];
}

// Identifies a received frame. Returns { address, channel, command } when the
// frame is the right length and carries a channel and command we recognise,
// otherwise null. The command byte's two halves have to agree, which together
// with the fixed length is what stops pairing from latching onto an unrelated
// 433 MHz device that happens to be in range.
function identifyFrame(payload) {
    if (!Array.isArray(payload) || payload.length !== FRAME_LENGTH) return null;
    if (!payload.every(bit => bit === 0 || bit === 1)) return null;

    const channel = fromBits(payload.slice(ADDRESS_LENGTH, ADDRESS_LENGTH + CHANNEL_LENGTH));
    if (channel !== CHANNEL_ALL && !CHANNEL_NUMBERS.includes(channel)) return null;

    const byte = fromBits(payload.slice(ADDRESS_LENGTH + CHANNEL_LENGTH));
    const code = byte >> 4;
    if (byte !== plainByte(code) && byte !== complementedByte(code)) return null;

    const command = COMMAND_BY_CODE.get(code);
    if (command === undefined) return null;

    return { address: payload.slice(0, ADDRESS_LENGTH), channel, command };
}

// Whether a received frame came from a given handset, so one household's remote
// can't drive another's blinds.
function sameAddress(a, b) {
    return Array.isArray(a)
        && Array.isArray(b)
        && a.length === b.length
        && a.every((bit, i) => bit === b[i]);
}

module.exports = {
    SIGNAL_ID,
    ADDRESS_LENGTH,
    CHANNEL_LENGTH,
    COMMAND_LENGTH,
    FRAME_LENGTH,
    CHANNEL_ALL,
    CHANNEL_NUMBERS,
    COMMAND_CODES,
    COMMAND_NAMES,
    plainByte,
    complementedByte,
    toBits,
    fromBits,
    buildFrame,
    identifyFrame,
    sameAddress,
};
