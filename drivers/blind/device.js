'use strict';

const Homey = require('homey');
const {
    SIGNAL_ID, ADDRESS_LENGTH, CHANNEL_ALL, CHANNEL_NUMBERS, buildFrame, sameAddress,
} = require('./bear-protocol');
const { Position, UP, DOWN, IDLE } = require('./position');

// Homey's windowcoverings_state enum onto the remote's three buttons. `idle` is
// the STOP button: Homey's ternary control sends it for the middle position.
const STATE_TO_DIRECTION = { up: UP, idle: IDLE, down: DOWN };
const DIRECTION_TO_STATE = { [UP]: 'up', [IDLE]: 'idle', [DOWN]: 'down' };
const DIRECTION_TO_COMMAND = { [UP]: 'up', [DOWN]: 'down' };
const COMMAND_TO_DIRECTION = { up: UP, down: DOWN, stop: IDLE };

// How often the position is republished while the blind is moving, so the
// slider tracks it rather than jumping at the end. Each write is also a
// `windowcoverings_set_changed` flow trigger and an Insights entry, so this is a
// balance rather than a free choice; a second is smooth enough to watch.
const POSITION_TICK = 1000;

// Reversing a loaded motor without stopping it first is hard on the mechanism,
// and some tubular motors ignore the reversal outright. Timed moves never
// reverse mid-run, but a remote press or a new command can.
const REVERSAL_PAUSE = 500;

// Homey sets a capability to the value the listener was called with once that
// listener resolves. When we decide a move is too small to make, that write
// lands after ours and leaves the slider showing a position the blind is not at,
// so the correction is repeated once the dust has settled.
const CORRECTION_DELAY = 500;

const DEFAULTS = {
    travel_time_up: 30,
    travel_time_down: 30,
    stop_lead: 300,
    invert_position: false,
};

// windowcoverings_set carries two decimals. Rounding to them keeps a 30-second
// travel from writing a different number every tick for no visible difference.
const round = value => Math.round(value * 100) / 100;

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

        // Bumped whenever a movement is abandoned. Anything still waiting on a
        // transmission from the old one checks it before carrying on.
        this.generation = 0;
        this.legs = [];

        this.applySettings(this.getSettings());
        this.restoreEstimate();

        this.registerCapabilityListener('windowcoverings_state', this.onCapabilityState.bind(this));
        this.registerCapabilityListener('windowcoverings_set', this.onCapabilityPosition.bind(this));
        await this.publish();

        this.log(`${this.ch()} initialised; address ${this.address.join('')}`);

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
        this.cancelMotion();
        this.clearTimer('tickTimer');
        // The motor is left running on purpose: the app going down is no reason
        // to stop a blind halfway. The estimate records that it was moving, and
        // onInit treats a position saved that way as unknown.
        if (this.tracker) await this.saveEstimate();
        await this.driver.unregisterRXListener(this.onRX).catch(() => {});
    }

    // Settings are cached rather than read at each use, because onSettings runs
    // before Homey commits them: getSetting() would still return the old value
    // for the rest of that call.
    applySettings(settings) {
        const value = key => (settings[key] === undefined || settings[key] === null
            ? DEFAULTS[key]
            : settings[key]);

        this.upTime = Number(value('travel_time_up')) * 1000;
        this.downTime = Number(value('travel_time_down')) * 1000;
        this.stopLead = Number(value('stop_lead'));
        this.invert = Boolean(value('invert_position'));

        if (this.tracker) this.tracker.retime(this.upTime, this.downTime);
    }

    async onSettings({ newSettings, changedKeys }) {
        this.applySettings(newSettings);
        this.log(`${this.ch()} settings changed: ${changedKeys.join(', ')}`);

        // A move already running keeps the stop it was scheduled for, but its
        // position is now integrated against the new times, so changing these
        // mid-move leaves the estimate a little off. It is not worth machinery:
        // nobody edits settings while a blind is running, and the next run into
        // an end stop puts it right anyway.
        if (changedKeys.includes('invert_position')) await this.publish();
    }

    // The slider reads 100% as fully open by default, which is Homey's own
    // convention for windowcoverings_set. Inverting swaps only that reading —
    // never the direction the motor turns, because up is up either way.
    toDisplay(position) {
        return this.invert ? 1 - position : position;
    }

    toPosition(value) {
        return this.invert ? 1 - value : value;
    }

    // The estimate is kept in the store rather than read back off the capability,
    // because it carries two things the capability cannot: how far out it may be,
    // and whether the app stopped while the motor was still running.
    restoreEstimate() {
        const saved = this.getStoreValue('estimate') || {};
        const moving = saved.moving === true;

        // A blind that was moving when the app went down could be anywhere: we
        // do not know whether the motor ran on to its end stop or how far it got.
        const uncertainty = moving || typeof saved.uncertainty !== 'number' ? 1 : saved.uncertainty;

        this.tracker = new Position({
            upTime: this.upTime,
            downTime: this.downTime,
            position: typeof saved.position === 'number' ? saved.position : 1,
            uncertainty,
            now: () => Date.now(),
        });

        this.log(`${this.ch()} position ${percent(this.tracker.at())}`
            + `, ±${percent(uncertainty)}${moving ? ' (was moving when the app stopped)' : ''}`);
    }

    async saveEstimate() {
        await this.setStoreValue('estimate', {
            position: this.tracker.at(),
            uncertainty: this.tracker.uncertainty,
            moving: this.tracker.moving,
        }).catch(err => this.error(`${this.ch()} could not save the position:`, err.message));
    }

    // Writes what the tracker believes to both capabilities. Only changed values
    // are written: an unchanged one still costs a flow trigger and an Insights
    // entry, and this runs once a second while a blind is moving.
    async publish(reason) {
        const state = DIRECTION_TO_STATE[this.tracker.direction];
        const position = round(this.toDisplay(this.tracker.at()));

        for (const [capability, value] of [
            ['windowcoverings_state', state],
            ['windowcoverings_set', position],
        ]) {
            if (this.getCapabilityValue(capability) === value) continue;
            // Read back and logged on failure: the device keeps working when a
            // write is rejected, and only the UI goes quietly stale.
            await this.setCapabilityValue(capability, value)
                .catch(err => this.error(`${this.ch()} could not set ${capability} to ${value}:`, err.message));
        }

        if (reason) {
            this.log(`${reason}; ${state} at ${percent(this.tracker.at())}`
                + ` ±${percent(this.tracker.uncertainty)}`);
        }
    }

    // --- commands from Homey -------------------------------------------------

    async onCapabilityState(value) {
        const direction = STATE_TO_DIRECTION[value];
        if (direction === undefined) {
            throw new Error(`Unknown state: ${value}`);
        }

        if (direction === IDLE) {
            // Always transmit, even when the tracker thinks nothing is moving.
            // Someone pressing STOP is telling us the blind is running, and they
            // can see it and we cannot.
            const generation = this.cancelMotion();
            await this.send('stop');
            if (!this.current(generation)) return;
            this.haltAfterStop();
            await this.finish(`${this.ch()} stop`);
            return;
        }

        // The ternary control is a direction, not a destination, so this runs to
        // the end stop — which is also the one move that repairs the estimate.
        await this.drive(this.tracker.plan(direction === UP ? 1 : 0), `${this.ch()} ${DIRECTION_TO_COMMAND[direction]}`);
    }

    async onCapabilityPosition(value) {
        const target = this.toPosition(value);
        const legs = this.tracker.plan(target);

        if (legs.length === 0 && !this.tracker.moving) {
            this.log(`${this.ch()} ${percent(target)} is where it already is; not moving`);
            this.scheduleCorrection();
            return;
        }

        const plan = legs.map(leg => `${leg.limit ? 'run to' : `${leg.duration}ms`} `
            + `${leg.direction === UP ? 'open' : 'closed'}`).join(', then ');
        await this.drive(legs, `${this.ch()} to ${percent(target)} (${plan || 'stop'})`);
    }

    // --- driving -------------------------------------------------------------

    async drive(legs, reason) {
        const generation = this.cancelMotion();
        this.legs = legs.slice();
        if (reason) this.log(reason);
        await this.nextLeg(generation);
    }

    async nextLeg(generation) {
        if (!this.current(generation)) return;

        const leg = this.legs.shift();
        if (leg === undefined) {
            await this.settle(generation);
            return;
        }

        const runtime = await this.startMotor(generation, leg.direction);
        if (runtime === null) return;

        // A limit run is re-timed from the moment the motor actually started,
        // which is what the plan could only estimate. A timed run is stopped
        // early by the stop lead, to cover the delay between handing the frame
        // to the radio and the motor acting on it.
        const delay = leg.limit ? runtime : Math.max(0, leg.duration - this.stopLead);

        this.legTimer = this.homey.setTimeout(() => {
            this.legTimer = null;
            this.endLeg(generation, leg)
                .catch(err => this.error(`${this.ch()} could not finish the move:`, err.message));
        }, delay);
    }

    async startMotor(generation, direction) {
        if (this.tracker.moving && this.tracker.direction !== direction) {
            await this.send('stop');
            if (!this.current(generation)) return null;
            this.haltAfterStop();
            await this.pause(REVERSAL_PAUSE);
            if (!this.current(generation)) return null;
        }

        await this.send(DIRECTION_TO_COMMAND[direction]);
        if (!this.current(generation)) return null;

        // The clock starts here rather than before the transmission, so the
        // queueing latency lands outside the integral instead of inside it.
        const runtime = this.tracker.run(direction);
        this.startTicker();
        await this.publish();
        await this.saveEstimate();
        return runtime;
    }

    async endLeg(generation, leg) {
        if (!this.current(generation)) return;

        if (leg.limit) {
            // Nothing to transmit: the motor stopped itself against its own end
            // stop somewhere in the last few seconds. That stop, not our clock,
            // is what the position is now measured from.
            this.tracker.halt('tx');
            this.log(`${this.ch()} reached ${leg.direction === UP ? 'open' : 'closed'}; position is exact again`);
        } else {
            await this.send('stop');
            if (!this.current(generation)) return;
            this.haltAfterStop();
        }

        await this.nextLeg(generation);
    }

    // The end of a movement: stop the motor if a plan ran out while it was still
    // running, which is what an empty plan means.
    async settle(generation) {
        if (this.tracker.moving) {
            await this.send('stop');
            if (!this.current(generation)) return;
            this.haltAfterStop();
        }

        await this.finish(`${this.ch()} idle`);
    }

    async finish(reason) {
        this.clearTimer('tickTimer');
        await this.publish(reason);
        await this.saveEstimate();
    }

    // --- recalibration and the calibration wizard ----------------------------

    // The `recalibrate` flow card. Running into an end stop is the only move
    // whose result does not depend on the clock, so it is also the repair.
    async recalibrate(end) {
        this.ready();
        const target = end === 'closed' ? 0 : 1;
        await this.drive(this.tracker.plan(target),
            `${this.ch()} recalibrating against the ${end} end stop`);
    }

    // The repair wizard drives the motor without integrating anything: the
    // travel times are what is being measured, so there is nothing yet to
    // measure against. The estimate is replaced wholesale at the end.
    async calibrationDrive(command) {
        this.ready();
        // Unconditionally, even when nothing is thought to be running: this is
        // the one place where what the blind is doing is genuinely unknown, and
        // a stop before a reversal is cheaper than a motor that ignores it.
        await this.calibrationStop();
        await this.pause(REVERSAL_PAUSE);

        await this.send(command);
        await this.setCapabilityValue('windowcoverings_state', command)
            .catch(err => this.error(`${this.ch()} could not set state:`, err.message));
    }

    async calibrationStop() {
        this.ready();
        this.cancelMotion();
        this.clearTimer('tickTimer');
        await this.send('stop');
        this.haltAfterStop();
        await this.setCapabilityValue('windowcoverings_state', 'idle')
            .catch(err => this.error(`${this.ch()} could not set state:`, err.message));
    }

    async applyCalibration(upTime, downTime) {
        this.ready();
        const settings = {
            travel_time_up: toTravelSetting(upTime),
            travel_time_down: toTravelSetting(downTime),
        };
        await this.setSettings(settings);
        // setSettings does not call onSettings — that fires only for a change the
        // user made in the UI — so the cache is refreshed by hand.
        this.applySettings(this.getSettings());

        // The wizard ends with the blind against its bottom stop, which is the
        // one position that needs no calculating at all.
        this.tracker.reset(0);
        await this.finish(`${this.ch()} calibrated: opens in ${settings.travel_time_up}s`
            + `, closes in ${settings.travel_time_down}s`);
    }

    // A device that failed to find its address in onInit has no tracker and no
    // business transmitting; it is already unavailable in the UI, and this is
    // what stops a flow card or a repair session from reaching past that.
    ready() {
        if (!this.tracker) throw new Error(this.homey.__('errors.not_paired'));
    }

    // --- the physical remote -------------------------------------------------

    // Called for every Bear frame Homey receives, from any handset and channel.
    onRX(frame, isFirst) {
        // Each press is transmitted repeatedly; only act on it once.
        if (isFirst === false) return;

        // Ignore other households' handsets, and this handset's other channels.
        // The ALL position drives every blind at once, so it counts as ours too.
        if (!sameAddress(frame.address, this.address)) return;
        if (frame.channel !== this.channel && frame.channel !== CHANNEL_ALL) return;

        const direction = COMMAND_TO_DIRECTION[frame.command];
        if (direction === undefined) return;

        // One press reaches us as several receptions, and our own transmissions
        // can come back to us as well. A command that only repeats what the blind
        // is already doing tells us nothing, and acting on it does damage: it
        // would abandon a timed run's scheduled stop and let the blind carry on
        // to the end, and it would charge the estimate for a stop that never
        // happened. Ignoring it makes both harmless.
        if (direction === this.tracker.direction) return;

        // The tracker is updated here, in the synchronous handler, so that the
        // position is integrated to the moment the frame arrived rather than to
        // whenever the capability writes below get their turn.
        const generation = this.cancelMotion();
        let runtime = null;
        if (direction === IDLE) {
            this.tracker.halt('rx');
        } else {
            runtime = this.tracker.run(direction);
            this.startTicker();
        }

        const reason = `${this.ch()} rx ${frame.command} from the remote`
            + (frame.channel === CHANNEL_ALL ? ' (ALL)' : '');

        if (runtime !== null) {
            // Whoever pressed the button gave no destination and may never press
            // stop, so this runs until the end stop unless a stop arrives first.
            this.legTimer = this.homey.setTimeout(() => {
                this.legTimer = null;
                this.endLeg(generation, { limit: true, direction })
                    .catch(err => this.error(`${this.ch()} could not finish the move:`, err.message));
            }, runtime);
        }

        const done = runtime === null ? this.finish(reason) : this.publish(reason).then(() => this.saveEstimate());
        done.catch(err => this.error(`${this.ch()} could not follow the remote:`, err.message));
    }

    // --- plumbing ------------------------------------------------------------

    // Abandons whatever is in flight and returns the token the new movement runs
    // under. Anything still awaiting a transmission from the old one sees its
    // token superseded and drops out instead of driving the motor again.
    cancelMotion() {
        this.clearTimer('legTimer');
        this.clearTimer('correctionTimer');
        this.legs = [];
        return ++this.generation;
    }

    current(generation) {
        return this.generation === generation;
    }

    // A STOP we transmit reaches the motor some time after tx() has taken the
    // frame off our hands, and the blind keeps travelling in between — which is
    // the same delay the stop lead exists to cover, and the reason a timed run
    // is cut short by it. So the estimate is closed at the moment the motor
    // actually stopped rather than the moment we let go of the frame. A stop
    // heard from the handset gets no such treatment: it reaches the motor and
    // Homey at once.
    haltAfterStop() {
        return this.tracker.halt('tx', Date.now() + this.stopLead);
    }

    startTicker() {
        if (this.tickTimer) return;
        this.tickTimer = this.homey.setInterval(() => {
            if (!this.tracker.moving) {
                this.clearTimer('tickTimer');
                return;
            }
            this.publish().catch(err => this.error(`${this.ch()} could not publish:`, err.message));
        }, POSITION_TICK);
    }

    // Puts the slider back where the blind actually is, after Homey has written
    // the value we declined to move to. See CORRECTION_DELAY.
    scheduleCorrection() {
        this.clearTimer('correctionTimer');
        this.correctionTimer = this.homey.setTimeout(() => {
            this.correctionTimer = null;
            this.publish().catch(err => this.error(`${this.ch()} could not publish:`, err.message));
        }, CORRECTION_DELAY);
    }

    clearTimer(name) {
        if (!this[name]) return;
        if (name === 'tickTimer') this.homey.clearInterval(this[name]);
        else this.homey.clearTimeout(this[name]);
        this[name] = null;
    }

    pause(ms) {
        return new Promise(resolve => this.homey.setTimeout(resolve, ms));
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

const percent = fraction => `${Math.round(fraction * 100)}%`;

// The travel time settings move in half seconds and run from 1 to 300, and
// setSettings rejects anything outside that.
const toTravelSetting = ms => Math.min(300, Math.max(1, Math.round(ms / 500) / 2));

module.exports = BearBlindDevice;
