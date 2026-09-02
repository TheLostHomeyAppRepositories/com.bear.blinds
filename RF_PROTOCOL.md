# Bear blind remote 433 MHz RF protocol

Reverse-engineered from 18 button presses captured off a single 5-channel Bear handset with
Homey's built-in RF signal recorder — every channel and the ALL position, each with UP, DOWN and
STOP.

Verified on real hardware in both directions: pairing learns the handset, all three buttons drive
the blinds one movement per command, and Homey follows the handset.

This is a working hypothesis, not a manufacturer specification. Treat the structure section as a
guide for decoding further commands.

## Frame layout

Every frame is 40 bits, and splits into three fields:

```
[ 0..27 ]  address   identifies the handset, same for every button and channel
[ 28..31 ] channel   0 for the handset's ALL position, 1-5 for the channels
[ 32..39 ] command   which button was pressed
```

The app stores one address and one channel per paired blind, and builds the frame for each action.
Both live in [`bear-protocol.js`](drivers/blind/bear-protocol.js).

## Signal definition

[`.homeycompose/signals/433/bear.json`](.homeycompose/signals/433/bear.json), compiled into
`app.json` as `signals.433.bear`. One definition serves both transmit and receive: the properties
that differ between the two directions (`repetitions`, `sensitivity`, `rxTimeout`) each only affect
one of them.

| Property | Value | Notes |
|---|---|---|
| `sof` | `4770,1538` | preamble pulse and gap, in us |
| `words` | `[332,752]`, `[690,392]` | index 0 is bit `0`, index 1 is bit `1` |
| `interval` | `9700` | gap between repetitions (transmit) |
| `repetitions` | `8` | transmit only; matches the handset, see below |
| `sensitivity` | `0.2` | match tolerance (receive), see below |
| `rxTimeout` | `255` | receive only; a frame is ~50ms, well past the 10ms default |
| `minimalLength` / `maximalLength` | `39` / `40` | 40 goes out, 39 comes back, see below |

There is deliberately **no `eof`**, and no `txOnly`. See "Receiving" below.

Measured across all 103 frames in the captures, the timings are tight enough to leave no doubt
about the alphabet:

| | mean | min | max |
|---|---|---|---|
| SOF pulse | 4769 | 4732 | 4784 |
| SOF gap | 1538 | 1526 | 1550 |
| bit `0` pulse / gap | 331 / 753 | 314 / 740 | 344 / 768 |
| bit `1` pulse / gap | 690 / 392 | 676 / 380 | 702 / 404 |

Both symbols run ~1083us, so a 40-bit frame plus preamble is about 50ms.

## Commands

The command byte is a 4-bit code, repeated twice:

| Command | Code | Plain byte | Complemented byte |
|---|---|---|---|
| UP | `0001` | `0x11` | `0x1E` |
| DOWN | `0011` | `0x33` | `0x3C` |
| STOP | `0101` | `0x55` | `0x5A` |

The low nibble is either a copy of the high nibble or its bitwise complement, which makes each
frame self-validating without a separate checksum. **There is no checksum over the address or
channel** — nothing in the frame varies with both fields, which is what makes it possible to
synthesise any channel's frame from one learned address, and so to pair once and add all five
blinds.

Unused codes: `0000`, `0010`, `0100`, `0110`-`1111`. The three in use are the odd values 1, 3 and
5, which suggests room for more buttons than this handset has.

### Codes this app does not implement

Pressing **UP and DOWN together** transmits a well-formed frame carrying code `0x7`:

```
0001000000110010110000100010 0001 0111100?
address                      ch1  0x78 = complemented form of code 0x7
```

It has no effect on the blind. `identifyFrame` rejects it because `0x7` is not a command the app
implements, which the log says in as many words. Implemented codes are the odd values 1, 3 and 5,
and 7 fits that pattern, so the handset's button matrix likely encodes combinations in the same
field rather than in a separate one.

One further frame has been seen that fits nothing: correct address and channel 1, clean deviation,
but a command byte whose low nibble is neither a copy nor a complement of the high one (`0x8`
followed by `000`). It has been observed once, against many clean repeats of every other frame, so
a corrupted reception is the likeliest explanation rather than a message family of its own. Worth
revisiting only if it recurs and can be tied to a deliberate button press.

Neither is implemented, and neither should be transmitted speculatively: a frame whose meaning is
unknown could plausibly reprogram a motor.

### The two forms

One press transmits **eight frames at ~10ms intervals: four with the byte plain, then four
complemented.** For example, a press of DOWN on channel 3:

```
33 33 33 33 3c 3c 3c 3c
```

The gaps are uniform across the switch (~10.1ms, against ~10.8ms at the boundary), so this is one
continuous burst, not two presses.

**The app transmits the plain form only**, eight times. Each frame is individually self-consistent,
so a receiver has no reason to require both forms, and `Signal#tx()` sends one payload repeatedly
rather than alternating two. If a blind turns out not to respond, sending the complemented form as
a second `tx()` is the first thing to try.

`repetitions` is `8` to match the handset's eight frames. It matters: on the sibling RC300 app,
transmitting for materially longer than the real remote made the receiver re-trigger and register
one Homey command as two presses.

## Channels

The channel nibble is a plain binary counter, and `0000` is the handset's ALL position:

| Channel | Bits |
|---|---|
| ALL | `0000` |
| 1 | `0001` |
| 2 | `0010` |
| 3 | `0011` |
| 4 | `0100` |
| 5 | `0101` |

ALL is not offered as a device — the five channels are. But a press of it is recognised on receive
and updates every blind on that handset, so using it by hand doesn't leave Homey holding a stale
state.

## Receiving: four Homey requirements

Transmitting works from the signal definition alone. Receiving needed four separate things. The
first two are carried over from the sibling
[RC300 app](https://github.com/jbothe/homey-heatnglo-rc300); the last two were found here. All four
give the same symptom — `enableRX()` resolving successfully while nothing reaches a device — which
is why [`driver.js`](drivers/blind/driver.js) logs every payload it cannot identify. That one log
line is what separates "no frames arriving" from "frames arriving and not decoding", and it turned
the last two of these from guesswork into a single run each.

**1. The driver must declare itself an RF receiver**, in
[`driver.compose.json`](drivers/blind/driver.compose.json):

```json
"rf433": { "satelliteMode": true }
```

Without it Homey routes no received frame to the driver at all, not even for a deliberately
permissive signal definition. It is documented only in the
[homey-rfdriver](https://github.com/athombv/node-homey-rfdriver) README, under the transmitter
(learn from a remote) case.

**2. The signal must omit `eof`.** Homey will not match an incoming frame against a definition
declaring an `eof` unless it observes that eof on air. `txOnly` must stay absent too; it defaults
to `false`, so it never needed removing to enable receiving, but setting it would disable it.

**3. `sensitivity` must keep the two symbols apart.** It is a fractional tolerance, so a value that
sounds safely permissive can make the alphabet ambiguous. At `0.5` the windows overlap by 153us on
the pulse and 212us on the gap — a 400us pulse matches both bit `0` and bit `1`, and nothing
decodes:

| sensitivity | bit `0` pulse | bit `1` pulse | overlap |
|---|---|---|---|
| 0.5 | 166-498 | 345-1035 | 153us |
| 0.3 | 232-432 | 483-897 | none |
| 0.2 | 266-398 | 552-828 | none |

`0.2` separates them cleanly and still contains every duration measured across the captures. Real
frames then arrive at a deviation of ~0.008-0.013, matching the ~0.009 the RC300 app sees.

**4. A received frame is one symbol shorter than a transmitted one.** A word is a (pulse, gap)
pair, but the last bit's gap on air is the ~10ms gap to the next frame, not the symbol's own 392 or
752us. Homey therefore never closes the final word and delivers **39 symbols, not 40** — with the
last bit dropped whatever its value:

```
transmitted   0001000000110010110000100010 0001 00010001    (40)
received      0001000000110010110000100010 0001 0001000     (39)
```

So `minimalLength` is `39` and `maximalLength` is `40`. Requiring exactly 40 makes the app
completely deaf while looking like a radio problem. (The decoder in
[`tools/decoder.js`](tools/decoder.js) has to special-case the same trailing gap when reading
captures, which is the corroborating evidence that the frame really is 40 bits on air.)

The dropped bit is not guessed. The command byte carries its nibble twice, so the seven surviving
bits determine the eighth — and uniquely, since a nibble and its complement differ in *every*
position, so the two candidate completions can never both form a valid byte. `completeFrame` in
[`bear-protocol.js`](drivers/blind/bear-protocol.js) restores it, and returns null when neither
candidate is valid, which is what keeps the shorter length from weakening the check against
unrelated 433 MHz traffic.

Both halves of every press must be accepted on receive, since half the frames of any press carry
the complemented byte. Accepting only the plain form would make Homey follow the handset
intermittently — a failure that looks like poor radio range rather than a decoding bug.

## Addressing and pairing

Positions 0-27 never change with the button or the channel, which makes them the per-handset
address.

The app therefore **learns the address from the user's own handset at pair time** rather than
shipping one (see [`driver.js`](drivers/blind/driver.js)). It listens on 433 MHz, waits for a
40-bit frame carrying a channel it knows and a command byte whose halves agree, and keeps the
leading 28 bits. Matching on that structure is what prevents pairing to an unrelated 433 MHz device
transmitting nearby.

This clones the existing handset rather than inventing an address and teaching it to each motor.
Cloning needs only the remote the user already has, and leaves the blinds' own pairing untouched.
Because one handset drives every channel with the same address, a single press is enough to offer
all five channels as devices.

**Caveat.** All captures come from one handset, so the data cannot distinguish "unique per unit"
from "identical on every Bear remote ever made", and cannot show whether part of the 28-bit address
is really a fixed manufacturer prefix. The product's per-channel behaviour makes the address
reading far more likely. The same limit applies to the command and channel fields: if any of them
also varies per unit, a single sample cannot show it. Settling either needs captures from a second,
independently paired handset.

## Captures

The recorder output is **not committed**: it carries the address that operates the blinds, and
anyone within 433 MHz range who has it can drive them. Keep your own at
`captures/raw-captures.txt`, which [`.gitignore`](.gitignore) excludes.

[`test/captures.test.js`](test/captures.test.js) decodes that file on every `npm test` and asserts
that `buildFrame` reproduces the recorded frames bit-for-bit, which is what ties the shipped tables
back to the hardware. Without the file those four tests skip rather than fail, so a fresh clone
still runs green — at the cost of the only check that reaches the radio.

Format: a label line, then the recorder's comma-separated durations, ending in `65535`. Lines
beginning with `#` are ignored.

```
Ch 1 Up:
4757,1538,330,746,342,746,338,744,694,392,...,65535

Ch 1 Down:
...
```

Eighteen blocks are expected — `Ch 1`-`Ch 5` and `All`, each with `Up`, `Down` and `Stop`.

One gap remains in the recordings: the STOP captures contain only the first four frames of the
burst, so the complemented STOP byte `0x5A` is predicted from the pattern rather than observed.

## Adding a command

1. **Capture it.** Use Homey's built-in RF signal recorder in Developer Tools, which is what
   produced everything above: press the button once and it records raw pulse/gap durations in us
   for every repeated frame. An SDR with [`rtl_433`](https://github.com/merbanan/rtl_433) or
   [Universal Radio Hacker](https://github.com/jopohl/urh) works too.
2. **Decode it** with [`tools/decode-capture.js`](tools/decode-capture.js), which finds the SOF
   (rather than assuming the capture starts at one — captures often open with a glitchy run),
   splits the repeats, and reports whether they agree. Disagreement means take the capture again.
3. **Check it against the structure above.** If it does not fit, document what actually differs
   rather than forcing it into the model.
4. **Add the nibble** to `COMMAND_CODES` in [`bear-protocol.js`](drivers/blind/bear-protocol.js),
   which also registers it for receive via `identifyFrame`, then wire it to a capability.
5. **Add the capture** to [`captures/`](captures/), so `npm test` covers it.
6. **Update this document.**
