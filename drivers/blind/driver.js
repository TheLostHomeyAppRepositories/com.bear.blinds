'use strict';

const Homey = require('homey');
const { SIGNAL_ID, CHANNEL_NUMBERS, identifyFrame, describeFrame } = require('./bear-protocol');

// How long to listen for a button press before giving up, in milliseconds.
const LEARN_TIMEOUT = 30000;

// Ambient 433 MHz traffic occasionally fits our timings. The unrecognised-frame
// log exists to diagnose a silent receiver, not to narrate the airwaves, so it
// is throttled to one line per minute with a count of what it skipped.
const UNRECOGNISED_LOG_INTERVAL = 60000;

class BearBlindDriver extends Homey.Driver {
    async onInit() {
        this.learnAttempts = 0;
        this.unrecognisedSinceLog = 0;
        this.lastUnrecognisedLog = 0;

        // RX is shared: every paired blind listens so it can follow the physical
        // remote, and pairing listens to learn a new address. Homey's enableRX is
        // per-signal rather than per-listener, so it is reference counted here —
        // otherwise pairing finishing would switch RX off for every device.
        this.rxListeners = new Set();
        this.signal = this.homey.rf.getSignal433(SIGNAL_ID);
        this.signal.on('payload', this.onPayload.bind(this));
    }

    onPayload(payload, isFirst, deviation) {
        const frame = identifyFrame(payload);
        if (frame === null) {
            // Log rather than drop silently. Homey gives the identical symptom —
            // enableRX() resolving while no payload ever reaches a device —
            // whether frames are not arriving at all or arriving and failing to
            // decode, and this line is what tells those two apart. It found both
            // of the receive bugs in RF_PROTOCOL.md, one run each.
            this.unrecognisedSinceLog += 1;
            const now = Date.now();
            if (now - this.lastUnrecognisedLog < UNRECOGNISED_LOG_INTERVAL) return;

            const skipped = this.unrecognisedSinceLog - 1;
            this.log(`rx unrecognised: ${describeFrame(payload)}`
                + ` [${payload.join('')}]${deviation === undefined ? '' : ` dev ${deviation}`}`
                + (skipped > 0 ? ` (+${skipped} more in the last minute)` : ''));
            this.lastUnrecognisedLog = now;
            this.unrecognisedSinceLog = 0;
            return;
        }

        for (const listener of this.rxListeners) {
            try {
                listener(frame, isFirst);
            } catch (err) {
                this.error('RX listener failed:', err.message);
            }
        }
    }

    async registerRXListener(listener) {
        if (this.rxListeners.has(listener)) return;
        this.rxListeners.add(listener);

        if (this.rxListeners.size === 1) {
            await this.signal.enableRX();
            this.log(`RX enabled on signal '${SIGNAL_ID}'`);
        }
    }

    async unregisterRXListener(listener) {
        if (!this.rxListeners.delete(listener)) return;

        if (this.rxListeners.size === 0) {
            await this.signal.disableRX();
            this.log('RX disabled');
        }
    }

    async onPair(session) {
        // The address learned from the remote in this pairing session.
        let address = null;

        session.setHandler('learn', async () => {
            address = null;
            address = await this.learnAddress(session);
        });

        session.setHandler('list_devices', async () => {
            if (address === null) {
                this.log('[pair] list_devices called with no learned address');
                return [];
            }

            // One handset drives every channel, so a single press is enough to
            // offer all of them. Homey dedupes on data.id, so channels already
            // added show as such and pairing again to add a skipped one works.
            return CHANNEL_NUMBERS.map(channel => ({
                name: `${this.homey.__(this.manifest.name)} ${this.homey.__('pair.channel')} ${channel}`,
                // The address makes this stable across re-pairs, and unique if a
                // household has more than one Bear handset.
                data: { id: `bear-${address.join('')}-ch${channel}` },
                store: { address, channel },
            }));
        });
    }

    // Listens for a frame from a physical Bear remote and returns the address it
    // carries, so Homey can transmit as that remote.
    async learnAddress(session) {
        const attempt = ++this.learnAttempts;
        const log = (...args) => this.log(`[pair #${attempt}]`, ...args);
        let heard = 0;

        log('listening for a button press');

        let listener = null;
        const stop = async () => {
            if (listener !== null) {
                await this.unregisterRXListener(listener).catch(() => {});
                listener = null;
            }
        };

        try {
            return await new Promise((resolve, reject) => {
                let timer = null;

                const settle = (fn, arg) => {
                    if (timer !== null) {
                        clearTimeout(timer);
                        timer = null;
                    }
                    stop().then(() => fn(arg));
                };

                listener = (frame, isFirst) => {
                    // Each press is transmitted repeatedly; only count it once.
                    if (isFirst === false) return;

                    heard += 1;
                    const label = `ch${frame.channel}.${frame.command}`;
                    log(`heard #${heard}: ${label}`);
                    session.emit('rx', { heard, command: label }).catch(() => {});

                    // Any button will do: every one carries the same address, and
                    // asking for a specific one only invites pressing the wrong key.
                    log(`matched ${label}; address:`, JSON.stringify(frame.address));
                    settle(resolve, frame.address);
                };

                timer = setTimeout(() => {
                    log(`timed out after ${LEARN_TIMEOUT}ms; ${heard} frame(s) heard`);
                    settle(reject, new Error(this.homey.__('pair.timeout')));
                }, LEARN_TIMEOUT);

                this.registerRXListener(listener).catch(err => {
                    log('could not enable RX:', err.message);
                    settle(reject, err);
                });
            });
        } finally {
            await stop();
        }
    }
}

module.exports = BearBlindDriver;
