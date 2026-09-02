'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const { ADDRESS_LENGTH, identifyFrame } = require('../drivers/blind/bear-protocol');

// Everything the device asks of Homey, and nothing else. The point of this file
// is the driving — which command goes out, and when — and that is all timers and
// arithmetic over a radio it never has to be a real one.
class FakeDevice {
    constructor() {
        this.storeValues = {};
        this.settingsValues = {};
        this.capabilityValues = {};
        this.listeners = {};
        this.sent = [];
        this.logs = [];

        this.homey = {
            // Wrapped rather than passed by reference, so a test's mocked timers
            // are picked up at the moment they are called.
            setTimeout: (...args) => setTimeout(...args),
            clearTimeout: (...args) => clearTimeout(...args),
            setInterval: (...args) => setInterval(...args),
            clearInterval: (...args) => clearInterval(...args),
            __: key => key,
            rf: {
                getSignal433: () => ({
                    tx: async payload => { this.sent.push(payload); },
                }),
            },
        };
        this.driver = {
            registerRXListener: async () => {},
            unregisterRXListener: async () => {},
        };
    }

    getStoreValue(key) { return this.storeValues[key] ?? null; }
    async setStoreValue(key, value) { this.storeValues[key] = value; }
    getSettings() { return { ...this.settingsValues }; }
    getSetting(key) { return this.settingsValues[key]; }
    async setSettings(settings) { Object.assign(this.settingsValues, settings); }
    getCapabilityValue(key) { return this.capabilityValues[key] ?? null; }
    async setCapabilityValue(key, value) { this.capabilityValues[key] = value; }
    registerCapabilityListener(key, listener) { this.listeners[key] = listener; }
    async setUnavailable(reason) { this.unavailable = reason; }
    log(...args) { this.logs.push(args.join(' ')); }
    error(...args) { this.logs.push(`ERROR ${args.join(' ')}`); }
}

// device.js requires `homey`, which only exists on a Homey. Standing a module in
// for it has to happen before the require below, and by filename, because that
// is the only name the loader looks itself up by.
const STUB = path.join(__dirname, 'homey.stub.js');
require.cache[STUB] = {
    id: STUB, filename: STUB, loaded: true, exports: { Device: FakeDevice },
};
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    return request === 'homey' ? STUB : resolveFilename.call(this, request, ...rest);
};

const BearBlindDevice = require('../drivers/blind/device');

const ADDRESS = Array.from({ length: ADDRESS_LENGTH }, (_, i) => i % 2);
const CHANNEL = 3;
const UP_TIME = 20;      // seconds
const DOWN_TIME = 30;    // seconds
const STOP_LEAD = 300;   // milliseconds

async function blind(t, { position = 1, uncertainty = 0, moving = false, invert = false } = {}) {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1000000 });

    const device = new BearBlindDevice();
    device.storeValues = {
        address: ADDRESS,
        channel: CHANNEL,
        estimate: { position, uncertainty, moving },
    };
    device.settingsValues = {
        travel_time_up: UP_TIME,
        travel_time_down: DOWN_TIME,
        stop_lead: STOP_LEAD,
        invert_position: invert,
    };

    await device.onInit();
    device.sent.length = 0;
    return device;
}

// What actually went out on the air, in order.
const commands = device => device.sent.map(payload => identifyFrame(payload).command);
const position = device => device.capabilityValues.windowcoverings_set;
const state = device => device.capabilityValues.windowcoverings_state;

const press = command => [{ address: ADDRESS, channel: CHANNEL, command }, true];

// Timer callbacks here are async, and tick() only fires the callback — it does
// not wait for what the callback goes on to await. Hence the microtask flush,
// and the small steps: a run has to pass through every deadline inside it.
const flush = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };

async function advance(t, ms) {
    for (let elapsed = 0; elapsed < ms; elapsed += 100) {
        t.mock.timers.tick(Math.min(100, ms - elapsed));
        await flush();
    }
    await flush();
}

test('a position between the ends is a timed run, stopped by us', async (t) => {
    const device = await blind(t, { position: 1 });

    await device.listeners.windowcoverings_set(0.5);
    assert.deepEqual(commands(device), ['down']);
    assert.equal(state(device), 'down');

    // Half of a 30s travel, sent early by the stop lead.
    await advance(t, 0.5 * DOWN_TIME * 1000 - STOP_LEAD);
    assert.deepEqual(commands(device), ['down', 'stop']);

    // And the estimate counts the lead back in, because the motor keeps running
    // for it. Stopping the clock at the transmission instead would land at 51%.
    assert.equal(position(device), 0.5);
    assert.equal(state(device), 'idle');
});

test('an end is a run into the limit switch, and no stop is sent at all', async (t) => {
    const device = await blind(t, { position: 0.5 });

    await device.listeners.windowcoverings_set(1);
    assert.deepEqual(commands(device), ['up']);

    await advance(t, 0.5 * UP_TIME * 1000 * 1.1);
    assert.deepEqual(commands(device), ['up'], 'the motor stops itself; we must not cut it short');
    assert.equal(position(device), 1);
    assert.equal(state(device), 'idle');
    assert.equal(device.storeValues.estimate.uncertainty, 0, 'and the drift is gone');
});

// The one invariant the whole position estimate rests on: whatever asks for an
// end, the motor is left to its own limit switch and the estimate is taken from
// where that leaves it. No STOP is transmitted, so nothing depends on our clock
// being right, and the accumulated drift goes to zero rather than growing.
for (const [end, target, command] of [['open', 1, 'up'], ['closed', 0, 'down']]) {
    for (const entry of ['slider', 'ternary', 'remote', 'flow card']) {
        test(`running ${end} from the ${entry} sends no stop and makes the position exact`, async (t) => {
            // Start adrift, so a reset is something other than a no-op.
            const device = await blind(t, { position: 0.5, uncertainty: 0.4 });

            if (entry === 'slider') await device.listeners.windowcoverings_set(target);
            if (entry === 'ternary') await device.listeners.windowcoverings_state(command);
            if (entry === 'remote') device.onRX(...press(command));
            if (entry === 'flow card') await device.recalibrate(end);

            // Long enough for the slowest possible run: a full travel, plus the
            // arrival margin, from the far end of the uncertainty.
            await advance(t, 35000);

            // A press on the handset is already on the air; Homey follows it and
            // says nothing. Every other route transmits the drive command once,
            // and in no case is a stop sent after it.
            assert.deepEqual(commands(device), entry === 'remote' ? [] : [command],
                'the drive command, and nothing after it');
            assert.equal(position(device), target, 'exactly at the end, not near it');
            assert.equal(device.tracker.uncertainty, 0, 'and the drift is gone');
            assert.equal(state(device), 'idle');
            assert.equal(device.storeValues.estimate.moving, false);
        });
    }
}

test('the ternary control runs to an end rather than for a while', async (t) => {
    const device = await blind(t, { position: 0.5 });

    await device.listeners.windowcoverings_state('down');
    await advance(t, 0.5 * DOWN_TIME * 1000 * 1.1);

    assert.deepEqual(commands(device), ['down']);
    assert.equal(position(device), 0);
});

test('stop always transmits, even when nothing is thought to be moving', async (t) => {
    // Whoever pressed it can see the blind and Homey cannot.
    const device = await blind(t, { position: 0.5 });

    await device.listeners.windowcoverings_state('idle');
    assert.deepEqual(commands(device), ['stop']);
});

test('a move too small to be worth making sends nothing', async (t) => {
    const device = await blind(t, { position: 0.5 });

    await device.listeners.windowcoverings_set(0.51);
    assert.deepEqual(commands(device), []);
    assert.equal(state(device), 'idle');
});

test('a press on the handset moves the position without transmitting', async (t) => {
    const device = await blind(t, { position: 1 });

    device.onRX(...press('down'));
    await flush();
    assert.equal(state(device), 'down');

    await advance(t, 9000);
    device.onRX(...press('stop'));
    await flush();

    assert.equal(position(device), 0.7, '9 of 30 seconds down from the top');
    assert.equal(state(device), 'idle');
    assert.deepEqual(commands(device), [], 'following the remote is not echoing it');
});

test('a repeat of a press already being followed costs the estimate nothing', async (t) => {
    // One press reaches us as several receptions, and our own frames can come
    // back too. A repeat carries no news, so it must not be charged for as a
    // stop and a fresh start.
    const device = await blind(t, { position: 1 });

    device.onRX(...press('down'));
    await flush();
    await advance(t, 6000);
    device.onRX(...press('down'));
    await flush();
    await advance(t, 6000);
    device.onRX(...press('stop'));
    await flush();

    assert.equal(position(device), 0.6, '12 seconds of travel, not 6');
    // 0.4 travelled at the 5% drift rate, plus one heard stop. One stop, not two.
    assert.equal(device.storeValues.estimate.uncertainty, 0.4 * 0.05 + 0.005);
});

test('a repeat heard mid-move does not turn a timed run into an open-ended one', async (t) => {
    const device = await blind(t, { position: 1 });

    await device.listeners.windowcoverings_set(0.5);
    await advance(t, 3000);

    // The handset pressed again while the blind is already on its way, or our
    // own frame finding its way back to us.
    device.onRX(...press('down'));
    await flush();

    await advance(t, 0.5 * DOWN_TIME * 1000 - STOP_LEAD - 3000);
    assert.deepEqual(commands(device), ['down', 'stop'], 'the scheduled stop survived');
    assert.equal(position(device), 0.5, 'rather than running on to the bottom');
});

test('a press left to run out lands the position exactly', async (t) => {
    const device = await blind(t, { position: 0.5, uncertainty: 0.4 });

    device.onRX(...press('up'));
    await advance(t, UP_TIME * 1000 * 1.1);

    assert.equal(position(device), 1);
    assert.equal(device.storeValues.estimate.uncertainty, 0);
});

test('too uncertain to time, so it runs to an end stop on the way', async (t) => {
    const device = await blind(t, { position: 0.5, uncertainty: 1 });

    await device.listeners.windowcoverings_set(0.9);
    assert.deepEqual(commands(device), ['up'], 'anchoring against the top first');

    await advance(t, UP_TIME * 1000 * 1.1);
    assert.deepEqual(commands(device), ['up', 'down'], 'and now timing the rest from there');

    await advance(t, 0.1 * DOWN_TIME * 1000 - STOP_LEAD);
    assert.deepEqual(commands(device), ['up', 'down', 'stop']);
    assert.equal(position(device), 0.9);
});

test('a restart mid-run leaves the position unknown, not merely stale', async (t) => {
    const device = await blind(t, { position: 0.5, uncertainty: 0, moving: true });

    assert.equal(device.tracker.uncertainty, 1);
    // Which means the next intermediate position is repaired rather than timed.
    await device.listeners.windowcoverings_set(0.6);
    await flush();
    assert.equal(device.legs.length + 1, 2, 'a limit run, then the timed one');
});

test('inverting changes the number, never the direction', async (t) => {
    const device = await blind(t, { position: 0.3, invert: true });
    assert.equal(position(device), 0.7, 'a blind 30% open is 70% out');

    // Further out is further down, whatever the slider is counting.
    await device.listeners.windowcoverings_set(0.9);
    assert.deepEqual(commands(device), ['down']);
    assert.equal(state(device), 'down', 'up is up either way');

    await advance(t, 0.2 * DOWN_TIME * 1000 - STOP_LEAD);
    assert.equal(position(device), 0.9);
});

test('a blind with no address stays unavailable and never transmits', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const device = new BearBlindDevice();
    device.storeValues = { address: null, channel: null };

    await device.onInit();

    assert.equal(device.unavailable, 'errors.not_paired');
    assert.equal(device.tracker, undefined);
    assert.throws(() => device.ready(), /not_paired/);
    assert.deepEqual(commands(device), []);
});
