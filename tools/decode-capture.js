#!/usr/bin/env node
'use strict';

// Decodes Homey RF signal recorder output into Bear frames, and reports what
// each capture says. See RF_PROTOCOL.md.
//
//   node tools/decode-capture.js captures/raw-captures.txt

const fs = require('node:fs');
const { parseCaptures, decodeCapture } = require('./decoder');
const {
    FRAME_LENGTH, ADDRESS_LENGTH, CHANNEL_LENGTH, identifyFrame, fromBits,
} = require('../drivers/blind/bear-protocol');

const file = process.argv[2];
if (file === undefined) {
    console.error('usage: node tools/decode-capture.js <capture file>');
    process.exit(2);
}

const blocks = parseCaptures(fs.readFileSync(file, 'utf8'));
if (blocks.length === 0) {
    console.error(`No labelled captures in ${file}. Expected "Ch 1 Up:" followed by durations.`);
    process.exit(1);
}

for (const { label, durations } of blocks) {
    const { frames } = decodeCapture(durations);
    const full = frames.filter(f => f.length === FRAME_LENGTH);

    console.log(`\n## ${label}  (${durations.length} durations, ${frames.length} frames, ${full.length} full)`);

    // Group identical frames: repeats that agree are the evidence a capture is
    // clean, and the count is what shows the burst structure.
    const tally = new Map();
    for (const frame of full) {
        const key = frame.join('');
        tally.set(key, (tally.get(key) || 0) + 1);
    }

    for (const [bits, count] of [...tally].sort((a, b) => b[1] - a[1])) {
        const frame = bits.split('').map(Number);
        const known = identifyFrame(frame);
        const byte = fromBits(frame.slice(ADDRESS_LENGTH + CHANNEL_LENGTH));
        console.log(
            `  x${count}  ${bits.slice(0, ADDRESS_LENGTH)}`
            + ` ${bits.slice(ADDRESS_LENGTH, ADDRESS_LENGTH + CHANNEL_LENGTH)}`
            + ` ${bits.slice(ADDRESS_LENGTH + CHANNEL_LENGTH)}`
            + `  byte 0x${byte.toString(16).padStart(2, '0')}`
            + `  ${known ? `ch${known.channel} ${known.command}` : 'UNRECOGNISED'}`,
        );
    }

    if (full.length === 0) console.log('  no clean frames — take the capture again');
}
