'use strict';

// Decodes Homey RF signal recorder output into Bear frames.
//
// The recorder emits raw pulse/gap durations in microseconds. A press produces
// several repeated frames separated by a long gap, which the recorder reports as
// a large value or its overflow, 65535. Each repeat is decoded independently so
// that agreement between them can be used as the test of a clean capture.

// Preamble: one long pulse and a long gap, before every frame.
const SOF = { pulse: [4400, 5200], gap: [1350, 1750] };

// Two symbols, so the payload is plain binary.
const WORDS = [
    { bit: 0, pulse: [260, 480], gap: [640, 860] },
    { bit: 1, pulse: [600, 800], gap: [300, 500] },
];

// Anything longer than this ends a frame rather than being part of one.
const FRAME_GAP = 2000;

const within = (v, [lo, hi]) => v >= lo && v <= hi;

// Splits a recorder dump into labelled blocks: "Ch 1 Up:" followed by durations.
function parseCaptures(text) {
    const blocks = [];
    let current = null;

    for (const line of text.split('\n')) {
        if (line.trim().startsWith('#')) continue;

        const label = line.match(/^\s*([^\d\s][^:]*):\s*$/);
        if (label) {
            current = { label: label[1].trim(), durations: [] };
            blocks.push(current);
            continue;
        }
        if (current === null) continue;

        const numbers = line.trim().split(',').map(Number).filter(n => Number.isFinite(n));
        current.durations.push(...numbers);
    }

    return blocks;
}

// Decodes every frame in one capture. Frames that don't decode cleanly are
// dropped rather than repaired: a capture with enough clean repeats to agree is
// worth more than a guess at a glitched one.
function decodeFrames(durations) {
    const frames = [];

    for (let i = 0; i + 1 < durations.length; i += 1) {
        // Search for the preamble rather than assuming the capture starts at
        // one — captures often open with a glitchy run.
        if (!within(durations[i], SOF.pulse) || !within(durations[i + 1], SOF.gap)) continue;

        const bits = [];
        let j = i + 2;
        let clean = true;

        for (; j + 1 < durations.length; j += 2) {
            const pulse = durations[j];
            const gap = durations[j + 1];

            const word = WORDS.find(w => within(pulse, w.pulse) && within(gap, w.gap));
            if (word !== undefined) {
                bits.push(word.bit);
                continue;
            }

            // A long gap after a valid pulse ends the frame; anything else is a
            // glitch, and the partial frame is discarded.
            const tail = WORDS.find(w => within(pulse, w.pulse));
            if (tail !== undefined && gap >= FRAME_GAP) {
                bits.push(tail.bit);
                j += 2;
            } else {
                clean = false;
            }
            break;
        }

        if (clean && bits.length > 0) frames.push(bits);
        i = j - 1;
    }

    return frames;
}

// Reduces a capture to the one frame its repeats agree on. Returns null when
// they don't, which means the capture should be taken again rather than trusted.
function decodeCapture(durations) {
    const frames = decodeFrames(durations);
    if (frames.length === 0) return { frame: null, frames, agreed: 0 };

    // The modal length is the frame; shorter ones lost their tail to a glitch.
    const counts = new Map();
    for (const f of frames) counts.set(f.length, (counts.get(f.length) || 0) + 1);
    const length = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];

    const candidates = frames.filter(f => f.length === length);
    const first = candidates[0].join('');
    const agreed = candidates.filter(f => f.join('') === first).length;

    return {
        frame: agreed === candidates.length ? candidates[0] : null,
        frames,
        agreed,
        candidates: candidates.length,
        length,
    };
}

module.exports = { parseCaptures, decodeFrames, decodeCapture, SOF, WORDS };
