'use strict';

const Homey = require('homey');
const {
    SIGNAL_ID, ADDRESS_LENGTH, CHANNEL_ALL, CHANNEL_NUMBERS, buildFrame, sameAddress,
} = require('./bear-protocol');

// Homey's windowcoverings_state enum onto the remote's three buttons. `idle` is
// the STOP button: Homey's ternary control sends it for the middle position.
const STATE_TO_COMMAND = {
    up: 'up',
    idle: 'stop',
    down: 'down',
};
const COMMAND_TO_STATE = {
    up: 'up',
    stop: 'idle',
    down: 'down',
};

// One press of the remote can reach us as two or three separate receptions: the
// `isFirst` flag only groups frames Homey heard as a single burst, and reception
// dropping briefly mid-transmission starts a new one. Collapsing repeats of the
// same command within this window is safe because a repeated UP is a no-op on a
// blind that is already going up.
const RX_REPEAT_WINDOW = 2000;

const DEFAULT_TRAVEL_TIME = 30;

class BearBlindDevice extends Homey.Device {
    async onInit() {
        this.signal = this.homey.rf.getSignal433(SIGNAL_ID);

        // Address and channel are learned from the user's own remote during
        // pairing. There is no default: transmitting an address we guessed would
        // drive whichever blind happens to answer to it, so a device without one
        // stays unavailable until it is added again.
        this.address = this.getStoreValue('address');
        this.channel = this.getStoreValue('channel');
        if (!Array.isArray(this.address)
            || this.address.length !== ADDRESS_LENGTH
            || !CHANNEL_NUMBERS.includes(this.channel)) {
            this.error(`${this.ch()} no address or channel stored; the device must be added again`);
            await this.setUnavailable(this.homey.__('errors.not_paired'));
            return;
        }
        this.log(`${this.ch()} initialised; address ${this.address.join('')}`);

        this.registerCapabilityListener('windowcoverings_state', this.onCapabilityState.bind(this));

        // Follow the physical remote, so Homey doesn't show stale state. Failing
        // here must not stop the device from transmitting.
        this.onRX = this.onRX.bind(this);
        try {
            await this.driver.registerRXListener(this.onRX);
        } catch (err) {
            this.error(`${this.ch()} could not listen for the remote; state may go stale:`, err.message);
        }
    }

    // Homey prefixes a device's log lines with its uuid, which says nothing about
    // which blind it is, so every message here names the channel as well.
    ch() {
        return `ch${this.channel === undefined ? '?' : this.channel}`;
    }

    async onUninit() {
        this.clearIdleTimer();
        await this.driver.unregisterRXListener(this.onRX).catch(() => {});
    }

    // Called for every Bear frame Homey receives, from any handset and channel.
    onRX(frame, isFirst) {
        // Each press is transmitted repeatedly; only act on it once.
        if (isFirst === false) return;

        // Ignore other households' handsets, and this handset's other channels.
        // The ALL position drives every blind at once, so it counts as ours too.
        if (!sameAddress(frame.address, this.address)) return;
        if (frame.channel !== this.channel && frame.channel !== CHANNEL_ALL) return;

        const now = Date.now();
        if (frame.command === this.lastRxCommand && now - this.lastRxAt < RX_REPEAT_WINDOW) {
            return;
        }
        this.lastRxCommand = frame.command;
        this.lastRxAt = now;

        const state = COMMAND_TO_STATE[frame.command];
        if (state === undefined) return;

        const from = `${this.ch()} rx ${frame.command} from the remote`
            + (frame.channel === CHANNEL_ALL ? ' (ALL)' : '');

        // setCapabilityValue, not triggerCapabilityListener: this reflects a
        // press that already happened, and must not transmit it back. The value
        // is read back and logged because a rejection here is otherwise
        // invisible — the device keeps working, and only the UI goes stale.
        this.setCapabilityValue('windowcoverings_state', state)
            .then(() => this.log(`${from}; state now ${this.getCapabilityValue('windowcoverings_state')}`))
            .catch(err => this.error(`${from}; could not set state to ${state}:`, err.message));

        this.scheduleIdle(state);
    }

    async onCapabilityState(value) {
        const command = STATE_TO_COMMAND[value];
        if (command === undefined) {
            throw new Error(`Unknown state: ${value}`);
        }

        await this.send(command);
        this.scheduleIdle(value);
    }

    // A blind reports nothing back, so the only way Homey can stop showing it as
    // moving is to wait out the travel time the user configured. Without this the
    // ternary control sits on "up" indefinitely, claiming movement that finished
    // long ago.
    scheduleIdle(state) {
        this.clearIdleTimer();
        if (state === 'idle') return;

        const seconds = Number(this.getSetting('travel_time')) || DEFAULT_TRAVEL_TIME;
        this.idleTimer = this.homey.setTimeout(() => {
            this.idleTimer = null;
            this.setCapabilityValue('windowcoverings_state', 'idle')
                .then(() => this.log(`${this.ch()} travel time (${seconds}s) elapsed; state now idle`))
                .catch(err => this.error(`${this.ch()} could not return to idle:`, err.message));
        }, seconds * 1000);
    }

    clearIdleTimer() {
        if (this.idleTimer) {
            this.homey.clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
    }

    // Builds this blind's frame for a command and transmits it.
    async send(command) {
        const payload = buildFrame(this.address, this.channel, command);
        const startedAt = Date.now();

        try {
            // tx() resolves once Homey has queued the transmission, not once the
            // repetitions have finished going out, so this time is call latency
            // rather than airtime.
            await this.signal.tx(payload);
            this.log(`${this.ch()} tx ${command} ok (queued in ${Date.now() - startedAt}ms)`);
        } catch (err) {
            this.error(`${this.ch()} tx ${command} failed after ${Date.now() - startedAt}ms:`, err.message);
            this.error(`  payload was [${payload.join(',')}]`);
            throw err;
        }
    }
}

module.exports = BearBlindDevice;
